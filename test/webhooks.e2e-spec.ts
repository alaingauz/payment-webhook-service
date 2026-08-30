import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { PG_POOL } from '../src/database/database.module.js';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-001',
    order_id: 'order-001',
    event_type: 'payment.authorized',
    sequence: 1,
    occurred_at: new Date().toISOString(),
    data: { amount: 1000, currency: 'MXN' },
    ...overrides,
  };
}

// Mock PG pool to avoid real DB in e2e tests
function createMockPool() {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  // Default: successful transaction
  mockClient.query
    .mockResolvedValueOnce(undefined) // BEGIN
    .mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: '', processing_status: 'PENDING' }],
    }) // UPSERT
    .mockResolvedValueOnce(undefined) // delivery INSERT
    .mockResolvedValueOnce(undefined); // COMMIT

  const pool = {
    connect: vi.fn().mockResolvedValue(mockClient),
    query: vi.fn().mockResolvedValue({ rows: [{ now: new Date() }] }),
    end: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  };

  return { pool, mockClient };
}

describe('POST /webhooks/payments (e2e)', () => {
  let app: INestApplication;
  let mockPool: ReturnType<typeof createMockPool>['pool'];
  let mockClient: ReturnType<typeof createMockPool>['mockClient'];

  beforeAll(async () => {
    process.env['WEBHOOK_SECRET'] = SECRET;

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

  function resetMockClient(overrides?: {
    upsertRow?: Record<string, unknown>;
    upsertError?: Error;
  }) {
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    mockPool.connect.mockResolvedValue(mockClient);

    if (overrides?.upsertError) {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(overrides.upsertError) // UPSERT fails
        .mockResolvedValueOnce(undefined); // ROLLBACK
    } else {
      const upsertRow = overrides?.upsertRow ?? {
        id: 1,
        delivery_count: 1,
        payload_hash: '',
        processing_status: 'PENDING',
      };
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [upsertRow] }) // UPSERT
        .mockResolvedValueOnce(undefined) // delivery INSERT
        .mockResolvedValueOnce(undefined); // COMMIT
    }
  }

  it('should return 401 when X-Signature is absent', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('should return 401 when X-Signature is invalid', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 'a'.repeat(64))
      .send(body);

    expect(res.status).toBe(401);
  });

  it('should not call repository when signature is invalid', async () => {
    resetMockClient();
    const payload = makePayload();
    const body = JSON.stringify(payload);

    await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', 'a'.repeat(64))
      .send(body);

    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('should return 202 with valid signature', async () => {
    resetMockClient();
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.event_id).toBe('evt-001');
    expect(res.body.result).toBe('CREATED');
    expect(res.body.message).toBe('Webhook stored for asynchronous processing');
  });

  it('should return 202 and IGNORED for a stale event', async () => {
    const staleDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const payload = makePayload({ occurred_at: staleDate });
    const body = JSON.stringify(payload);
    const sig = sign(body);

    resetMockClient();

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.result).toBe('IGNORED');
  });

  it('should return 202 and DUPLICATE for same event_id with same payload', async () => {
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const sig = sign(body);

    // Compute the payload hash the same way the service does
    const { createHash } = await import('node:crypto');
    const payloadHash = createHash('sha256').update(Buffer.from(body)).digest('hex');

    resetMockClient({
      upsertRow: {
        id: 1,
        delivery_count: 2,
        payload_hash: payloadHash,
        processing_status: 'PENDING',
      },
    });

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.result).toBe('DUPLICATE');
  });

  it('should return X-Correlation-Id in response header and body', async () => {
    resetMockClient();
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const sig = sign(body);
    const corrId = 'my-custom-correlation-id';

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .set('X-Correlation-Id', corrId)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.headers['x-correlation-id']).toBe(corrId);
    expect(res.body.correlation_id).toBe(corrId);
  });

  it('should generate correlation_id when X-Correlation-Id is missing', async () => {
    resetMockClient();
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(202);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.body.correlation_id).toBeDefined();
    // Should be a UUID format
    expect(res.body.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('should return 503 when PostgreSQL fails', async () => {
    resetMockClient({ upsertError: new Error('connection refused') });
    const payload = makePayload();
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(503);
  });

  it('should reject when data is absent', async () => {
    resetMockClient();
    const payload = {
      event_id: 'evt-nodata',
      order_id: 'order-001',
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('should reject event_id longer than 255 characters', async () => {
    resetMockClient();
    const payload = makePayload({ event_id: 'x'.repeat(256) });
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('should reject order_id longer than 255 characters', async () => {
    resetMockClient();
    const payload = makePayload({ order_id: 'x'.repeat(256) });
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('should preserve original payload including extra fields', async () => {
    resetMockClient();
    const payload = {
      event_id: 'evt-extra',
      order_id: 'order-001',
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date().toISOString(),
      data: { amount: 1000, currency: 'MXN' },
      extra_field: 'should_be_preserved',
    };
    const body = JSON.stringify(payload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/payments')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(body);

    expect(res.status).toBe(202);

    // Verify the upsert INSERT received the original JSON payload
    const upsertCall = mockClient.query.mock.calls[1]!;
    const upsertParams = upsertCall[1] as unknown[];
    const storedPayload = upsertParams[5] as string;
    const parsed = JSON.parse(storedPayload) as Record<string, unknown>;
    expect(parsed['extra_field']).toBe('should_be_preserved');
  });
});
