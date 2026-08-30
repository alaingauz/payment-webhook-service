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

describe('Orders E2E', () => {
  let app: INestApplication;
  let mockClient: ReturnType<typeof createMockPool>['mockClient'];

  beforeAll(async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret';

    const { pool, mockClient: client } = createMockPool();
    mockClient = client;

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env['WEBHOOK_SECRET'];
  });

  it('GET /orders/:id returns 404 for non-existent order', async () => {
    mockClient.query.mockReset();
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN READ ONLY
      .mockResolvedValueOnce({ rows: [] }) // SELECT orders
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await request(app.getHttpServer())
      .get('/orders/non-existent')
      .expect(404);

    expect(res.body.message).toContain('not found');
  });

  it('GET /orders/:id returns 200 with order data for existing order', async () => {
    mockClient.query.mockReset();
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN READ ONLY
      .mockResolvedValueOnce({
        rows: [{
          id: 'order-001',
          status: 'captured',
          last_sequence: 2,
          amount: '1000.00',
          currency: 'MXN',
          created_at: new Date('2026-01-01T00:00:00Z'),
          updated_at: new Date('2026-01-01T01:00:00Z'),
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: 'evt-001',
            event_type: 'payment.authorized',
            sequence: 1,
            occurred_at: new Date('2026-01-01T00:00:00Z'),
            received_at: new Date('2026-01-01T00:00:01Z'),
            processing_status: 'APPLIED',
            outcome_reason: null,
            attempt_count: 0,
            delivery_count: 1,
            processed_at: new Date('2026-01-01T00:00:02Z'),
          },
          {
            event_id: 'evt-002',
            event_type: 'payment.captured',
            sequence: 2,
            occurred_at: new Date('2026-01-01T00:30:00Z'),
            received_at: new Date('2026-01-01T00:30:01Z'),
            processing_status: 'APPLIED',
            outcome_reason: null,
            attempt_count: 0,
            delivery_count: 1,
            processed_at: new Date('2026-01-01T00:30:02Z'),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: 'evt-001',
            sequence: 1,
            previous_status: 'pending',
            new_status: 'authorized',
            outcome: 'APPLIED',
            outcome_reason: null,
            source: 'WEBHOOK',
            changed_at: new Date('2026-01-01T00:00:02Z'),
          },
          {
            event_id: 'evt-002',
            sequence: 2,
            previous_status: 'authorized',
            new_status: 'captured',
            outcome: 'APPLIED',
            outcome_reason: null,
            source: 'WEBHOOK',
            changed_at: new Date('2026-01-01T00:30:02Z'),
          },
        ],
      })
      .mockResolvedValueOnce(undefined); // COMMIT

    const res = await request(app.getHttpServer())
      .get('/orders/order-001')
      .expect(200);

    expect(res.body.id).toBe('order-001');
    expect(res.body.status).toBe('captured');
    expect(res.body.last_sequence).toBe(2);
    expect(res.body.amount).toBe('1000.00');
    expect(res.body.currency).toBe('MXN');
    expect(res.body.history.events).toHaveLength(2);
    expect(res.body.history.status_changes).toHaveLength(2);
  });

  it('returns events in chronological order', async () => {
    mockClient.query.mockReset();
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{
          id: 'order-002',
          status: 'refunded',
          last_sequence: 3,
          amount: '500.00',
          currency: 'USD',
          created_at: new Date('2026-01-01'),
          updated_at: new Date('2026-01-02'),
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: 'evt-a',
            event_type: 'payment.refunded',
            sequence: 3,
            occurred_at: new Date('2026-01-01T00:00:00Z'),
            received_at: new Date('2026-01-01T00:00:01Z'),
            processing_status: 'APPLIED',
            outcome_reason: null,
            attempt_count: 0,
            delivery_count: 1,
            processed_at: new Date('2026-01-01T00:00:02Z'),
          },
          {
            event_id: 'evt-b',
            event_type: 'payment.captured',
            sequence: 2,
            occurred_at: new Date('2026-01-01T00:01:00Z'),
            received_at: new Date('2026-01-01T00:01:01Z'),
            processing_status: 'IGNORED',
            outcome_reason: 'STALE_SEQUENCE',
            attempt_count: 0,
            delivery_count: 1,
            processed_at: new Date('2026-01-01T00:01:02Z'),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: 'evt-a',
            sequence: 3,
            previous_status: 'pending',
            new_status: 'refunded',
            outcome: 'APPLIED',
            outcome_reason: null,
            source: 'WEBHOOK',
            changed_at: new Date('2026-01-01T00:00:02Z'),
          },
          {
            event_id: 'evt-b',
            sequence: 2,
            previous_status: 'refunded',
            new_status: 'refunded',
            outcome: 'IGNORED',
            outcome_reason: 'STALE_SEQUENCE',
            source: 'WEBHOOK',
            changed_at: new Date('2026-01-01T00:01:02Z'),
          },
        ],
      })
      .mockResolvedValueOnce(undefined);

    const res = await request(app.getHttpServer())
      .get('/orders/order-002')
      .expect(200);

    // Events should be in received_at order
    expect(res.body.history.events[0].event_id).toBe('evt-a');
    expect(res.body.history.events[1].event_id).toBe('evt-b');

    // Status changes should be in changed_at order
    expect(res.body.history.status_changes[0].event_id).toBe('evt-a');
    expect(res.body.history.status_changes[1].event_id).toBe('evt-b');
  });

  it('shows APPLIED and IGNORED events with outcome reasons', async () => {
    mockClient.query.mockReset();
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{
          id: 'order-003',
          status: 'authorized',
          last_sequence: 1,
          amount: '100.00',
          currency: 'MXN',
          created_at: new Date(),
          updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: 'evt-x',
            event_type: 'payment.authorized',
            sequence: 1,
            occurred_at: new Date(),
            received_at: new Date(),
            processing_status: 'APPLIED',
            outcome_reason: null,
            attempt_count: 0,
            delivery_count: 1,
            processed_at: new Date(),
          },
          {
            event_id: 'evt-y',
            event_type: 'payment.pending',
            sequence: 0,
            occurred_at: new Date(),
            received_at: new Date(),
            processing_status: 'IGNORED',
            outcome_reason: 'STALE_SEQUENCE',
            attempt_count: 0,
            delivery_count: 1,
            processed_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            event_id: 'evt-x',
            sequence: 1,
            previous_status: 'pending',
            new_status: 'authorized',
            outcome: 'APPLIED',
            outcome_reason: null,
            source: 'WEBHOOK',
            changed_at: new Date(),
          },
          {
            event_id: 'evt-y',
            sequence: 0,
            previous_status: 'authorized',
            new_status: 'authorized',
            outcome: 'IGNORED',
            outcome_reason: 'STALE_SEQUENCE',
            source: 'WEBHOOK',
            changed_at: new Date(),
          },
        ],
      })
      .mockResolvedValueOnce(undefined);

    const res = await request(app.getHttpServer())
      .get('/orders/order-003')
      .expect(200);

    const applied = res.body.history.events.find((e: Record<string, unknown>) => e.processing_status === 'APPLIED');
    const ignored = res.body.history.events.find((e: Record<string, unknown>) => e.processing_status === 'IGNORED');

    expect(applied).toBeDefined();
    expect(applied.outcome_reason).toBeNull();
    expect(ignored).toBeDefined();
    expect(ignored.outcome_reason).toBe('STALE_SEQUENCE');
  });

  it('does not expose secrets in response', async () => {
    mockClient.query.mockReset();
    mockClient.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rows: [{
          id: 'order-004',
          status: 'pending',
          last_sequence: 0,
          amount: null,
          currency: null,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(undefined);

    const res = await request(app.getHttpServer())
      .get('/orders/order-004')
      .expect(200);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret');
    expect(body).not.toContain('WEBHOOK_SECRET');
    expect(body).not.toContain('password');
  });
});
