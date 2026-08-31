import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { WorkerAppModule } from '../src/worker/worker-app.module.js';
import { PG_POOL } from '../src/database/database.module.js';
import { ProviderClient } from '../src/provider/provider-client.js';

function createMockPool() {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn().mockResolvedValue({ rows: [{ now: new Date() }] }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  return { pool, mockClient };
}

describe('Reconciliation (e2e)', () => {
  let app: INestApplication;
  let mockPool: ReturnType<typeof createMockPool>['pool'];
  let mockClient: ReturnType<typeof createMockPool>['mockClient'];
  let providerClient: ProviderClient;

  beforeAll(async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret';

    const created = createMockPool();
    mockPool = created.pool;
    mockClient = created.mockClient;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(mockPool)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();

    providerClient = moduleRef.get(ProviderClient);
  });

  afterAll(async () => {
    await app.close();
    delete process.env['WEBHOOK_SECRET'];
  });

  function resetMocks() {
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    mockPool.connect.mockResolvedValue(mockClient);
  }

  function setupReconciliationQueries(
    localOrders: Record<string, { status: string; last_sequence: number; amount: string | null; currency: string | null }>,
  ) {
    mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const sqlStr = typeof sql === 'string' ? sql.trim() : '';

      if (sqlStr === 'BEGIN') return {};
      if (sqlStr === 'COMMIT') return {};
      if (sqlStr === 'ROLLBACK') return {};
      if (sqlStr.includes('pg_advisory_xact_lock')) return {};

      if (sqlStr.includes('INSERT INTO reconciliation_runs')) {
        return { rows: [{ id: '1', started_at: new Date('2026-01-01T00:00:00Z') }] };
      }

      if (sqlStr.includes('INSERT INTO orders') && sqlStr.includes('ON CONFLICT')) {
        const orderId = params?.[0] as string;
        const local = localOrders[orderId];
        // If local exists, RETURNING returns empty; if new, returns the id
        if (local) {
          return { rows: [] };
        }
        return { rows: [{ id: orderId }] };
      }

      if (sqlStr.includes('SELECT') && sqlStr.includes('FOR UPDATE')) {
        const orderId = params?.[0] as string;
        const local = localOrders[orderId];
        if (local) {
          return { rows: [{ id: orderId, ...local }] };
        }
        return { rows: [{ id: orderId, status: 'pending', last_sequence: 0, amount: null, currency: null }] };
      }

      if (sqlStr.includes('UPDATE orders')) return {};
      if (sqlStr.includes('INSERT INTO order_status_history')) return {};

      if (sqlStr.includes('UPDATE reconciliation_runs')) {
        return { rows: [{ finished_at: new Date('2026-01-01T00:00:01Z') }] };
      }

      if (sqlStr.includes('INSERT INTO reconciliation_details')) return {};

      return { rows: [] };
    });
  }

  it('POST /admin/reconcile returns 200 with report', async () => {
    resetMocks();

    vi.spyOn(providerClient, 'fetchSnapshot').mockResolvedValue({
      generated_at: '2026-01-01T00:00:00Z',
      orders: [
        { id: 'order-1', status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'order-2', status: 'failed', sequence: 2, amount: '50.00', currency: 'USD', updated_at: '2026-01-01T00:00:00Z' },
      ],
    });

    setupReconciliationQueries({
      'order-1': { status: 'authorized', last_sequence: 2, amount: '100.00', currency: 'MXN' },
    });

    const res = await request(app.getHttpServer())
      .post('/admin/reconcile')
      .expect(200);

    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.run_id).toBe('1');
    expect(res.body.orders_checked).toBe(2);
    expect(res.body.details).toBeInstanceOf(Array);
  });

  it('POST /admin/reconcile returns 502 when provider is unavailable', async () => {
    resetMocks();

    vi.spyOn(providerClient, 'fetchSnapshot').mockRejectedValue(
      new (await import('../src/provider/provider-client.js')).ProviderHttpError('connection refused', 0),
    );

    const res = await request(app.getHttpServer())
      .post('/admin/reconcile')
      .expect(502);

    // Should return generic message, not internal details
    expect(res.body.message).toBe('Provider unavailable or returned invalid data');
  });

  it('POST /admin/reconcile returns 502 for invalid snapshot', async () => {
    resetMocks();

    vi.spyOn(providerClient, 'fetchSnapshot').mockRejectedValue(
      new (await import('../src/provider/provider-client.js')).ProviderPayloadError('invalid payload'),
    );

    const res = await request(app.getHttpServer())
      .post('/admin/reconcile')
      .expect(502);

    expect(res.body.message).toBe('Provider unavailable or returned invalid data');
  });

  it('POST /admin/reconcile returns 503 when PostgreSQL fails', async () => {
    resetMocks();

    vi.spyOn(providerClient, 'fetchSnapshot').mockResolvedValue({
      generated_at: '2026-01-01T00:00:00Z',
      orders: [{ id: 'o1', status: 'captured', sequence: 1, amount: '10.00', currency: 'MXN', updated_at: '2026-01-01T00:00:00Z' }],
    });

    mockClient.query.mockRejectedValue(new Error('connection lost'));

    const res = await request(app.getHttpServer())
      .post('/admin/reconcile')
      .expect(503);

    expect(res.body.message).toBe('Reconciliation temporarily unavailable');
  });
});

describe('Reconciliation not in WorkerAppModule (e2e)', () => {
  it('WorkerAppModule does not expose reconciliation controller', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerAppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue({
        connect: vi.fn(),
        query: vi.fn().mockResolvedValue({ rows: [{ now: new Date() }] }),
        end: vi.fn(),
        on: vi.fn(),
      })
      .compile();

    // WorkerAppModule should not contain ProviderClient
    let found = false;
    try {
      moduleRef.get(ProviderClient, { strict: false });
      found = true;
    } catch {
      found = false;
    }
    expect(found).toBe(false);

    await moduleRef.close();
  });
});
