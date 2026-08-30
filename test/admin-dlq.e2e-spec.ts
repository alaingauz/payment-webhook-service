import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PG_POOL } from '../src/database/database.module.js';

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

describe('Admin DLQ (e2e)', () => {
  let app: INestApplication;
  let mockPool: ReturnType<typeof createMockPool>['pool'];
  let mockClient: ReturnType<typeof createMockPool>['mockClient'];

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

  describe('GET /admin/dlq', () => {
    it('returns 200 with items array', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // COUNT
        .mockResolvedValueOnce({ rows: [] }) // SELECT items
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(app.getHttpServer()).get('/admin/dlq');

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      expect(res.body.total).toBe(0);
      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
    });

    it('uses default pagination', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(undefined);

      const res = await request(app.getHttpServer()).get('/admin/dlq');

      expect(res.body.limit).toBe(50);
      expect(res.body.offset).toBe(0);
    });

    it('limit max is 100', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/dlq?limit=200');

      expect(res.status).toBe(400);
    });

    it('limit 0 returns 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/dlq?limit=0');

      expect(res.status).toBe(400);
    });

    it('invalid limit returns 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/dlq?limit=abc');

      expect(res.status).toBe(400);
    });

    it('negative offset returns 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/dlq?offset=-1');

      expect(res.status).toBe(400);
    });

    it('does not expose payload or secrets', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({
          rows: [{
            id: '1',
            event_id: 'evt-1',
            order_id: 'order-1',
            event_type: 'payment.captured',
            sequence: 2,
            processing_status: 'DLQ',
            attempt_count: 5,
            last_error: 'NUMERIC overflow',
            outcome_reason: 'MAX_ATTEMPTS_EXHAUSTED',
            received_at: new Date().toISOString(),
            processed_at: new Date().toISOString(),
            replay_count: 0,
            correlation_id: 'corr-1',
          }],
        })
        .mockResolvedValueOnce(undefined);

      const res = await request(app.getHttpServer()).get('/admin/dlq');

      expect(res.status).toBe(200);
      expect(res.body.items[0].id).toBe('1');
      expect(res.body.items[0]).not.toHaveProperty('payload');
      expect(res.body.items[0]).not.toHaveProperty('WEBHOOK_SECRET');
      expect(res.body.items[0]).not.toHaveProperty('payload_hash');
    });
  });

  describe('POST /admin/dlq/:id/replay', () => {
    it('DLQ returns 202 and REPLAYED', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'DLQ', replay_count: 0 }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', replay_count: 1, processing_status: 'PENDING' }],
        }) // UPDATE RETURNING
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(app.getHttpServer())
        .post('/admin/dlq/5/replay');

      expect(res.status).toBe(202);
      expect(res.body.result).toBe('REPLAYED');
      expect(res.body.id).toBe('5');
      expect(res.body.replay_count).toBe(1);
      expect(res.body.processing_status).toBe('PENDING');
    });

    it('non-DLQ returns 200 and NOT_IN_DLQ', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'PENDING', replay_count: 1 }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(app.getHttpServer())
        .post('/admin/dlq/5/replay');

      expect(res.status).toBe(200);
      expect(res.body.result).toBe('NOT_IN_DLQ');
      expect(res.body.processing_status).toBe('PENDING');
    });

    it('non-existent id returns 404', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(app.getHttpServer())
        .post('/admin/dlq/99999/replay');

      expect(res.status).toBe(404);
    });

    it('non-numeric id returns 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/dlq/abc/replay');

      expect(res.status).toBe(400);
    });

    it('PostgreSQL error returns 500', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('connection lost'));
      mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

      const res = await request(app.getHttpServer())
        .post('/admin/dlq/5/replay');

      expect(res.status).toBe(500);
    });

    it('does not process the order within the endpoint', async () => {
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'DLQ', replay_count: 0 }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', replay_count: 1, processing_status: 'PENDING' }],
        })
        .mockResolvedValueOnce(undefined); // COMMIT

      await request(app.getHttpServer())
        .post('/admin/dlq/5/replay');

      // Should only have BEGIN, SELECT FOR UPDATE, UPDATE RETURNING, COMMIT
      // No INSERT INTO orders, no UPDATE orders, no INSERT INTO order_status_history
      const calls = mockClient.query.mock.calls;
      const orderCalls = calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (
          (c[0] as string).includes('INSERT INTO orders') ||
          (c[0] as string).includes('UPDATE orders') ||
          (c[0] as string).includes('INSERT INTO order_status_history')
        ),
      );
      expect(orderCalls).toHaveLength(0);
    });
  });
});
