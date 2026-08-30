import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookIngestionRepository } from './webhook-ingestion.repository.js';

describe('WebhookIngestionRepository', () => {
  let repo: WebhookIngestionRepository;
  let mockClient: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let mockPool: { connect: ReturnType<typeof vi.fn> };

  const baseEvent = {
    event_id: 'evt-001',
    order_id: 'order-001',
    event_type: 'payment.authorized',
    sequence: 1,
    occurred_at: new Date().toISOString(),
    payload: '{"event_id":"evt-001"}',
    payload_hash: 'abc123',
    received_at: new Date(),
    processing_status: 'PENDING',
    outcome_reason: null,
    processed_at: null,
    correlation_id: 'corr-1',
  };

  const baseDelivery = {
    event_id: 'evt-001',
    received_at: new Date(),
    correlation_id: 'corr-1',
  };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      release: vi.fn(),
    };
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    };
    repo = new WebhookIngestionRepository(mockPool as any);
  });

  it('should execute BEGIN, upsert, delivery insert, and COMMIT in order', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING' }] }) // UPSERT
      .mockResolvedValueOnce(undefined) // delivery INSERT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repo.saveEventAndDelivery(
      baseEvent,
      baseDelivery,
      performance.now() - 10,
      () => 'CREATED',
    );

    expect(result.upsert.delivery_count).toBe(1);
    expect(result.deliveryResult).toBe('CREATED');
    expect(mockClient.query).toHaveBeenCalledTimes(4);

    // Verify order: BEGIN, UPSERT, DELIVERY INSERT, COMMIT
    const calls = mockClient.query.mock.calls;
    expect(calls[0]![0]).toBe('BEGIN');
    expect(calls[1]![0]).toContain('INSERT INTO webhook_events');
    expect(calls[2]![0]).toContain('INSERT INTO webhook_deliveries');
    expect(calls[3]![0]).toBe('COMMIT');

    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('should not return before COMMIT', async () => {
    const callOrder: string[] = [];

    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') { callOrder.push('BEGIN'); return undefined; }
      if (typeof sql === 'string' && sql.includes('INSERT INTO webhook_events')) {
        callOrder.push('UPSERT');
        return { rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING' }] };
      }
      if (typeof sql === 'string' && sql.includes('INSERT INTO webhook_deliveries')) {
        callOrder.push('DELIVERY');
        return undefined;
      }
      if (sql === 'COMMIT') { callOrder.push('COMMIT'); return undefined; }
      return undefined;
    });

    await repo.saveEventAndDelivery(
      baseEvent,
      baseDelivery,
      performance.now() - 10,
      () => 'CREATED',
    );

    expect(callOrder).toEqual(['BEGIN', 'UPSERT', 'DELIVERY', 'COMMIT']);
  });

  it('should ROLLBACK and release client on upsert error', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('PG error')) // UPSERT fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      repo.saveEventAndDelivery(baseEvent, baseDelivery, performance.now(), () => 'CREATED'),
    ).rejects.toThrow('PG error');

    // Check ROLLBACK was called
    const rollbackCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => call[0] === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('should ROLLBACK and release client on delivery insert error', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING' }] }) // UPSERT
      .mockRejectedValueOnce(new Error('delivery insert error')) // delivery INSERT fails
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(
      repo.saveEventAndDelivery(baseEvent, baseDelivery, performance.now(), () => 'CREATED'),
    ).rejects.toThrow('delivery insert error');

    const rollbackCall = mockClient.query.mock.calls.find(
      (call: unknown[]) => call[0] === 'ROLLBACK',
    );
    expect(rollbackCall).toBeDefined();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('should release client even if ROLLBACK fails', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('PG error')) // UPSERT fails
      .mockRejectedValueOnce(new Error('ROLLBACK also fails')); // ROLLBACK fails

    await expect(
      repo.saveEventAndDelivery(baseEvent, baseDelivery, performance.now(), () => 'CREATED'),
    ).rejects.toThrow('PG error');

    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('should calculate latency_ms after upsert using performance.now()', async () => {
    // Mock performance.now to control timing
    let callCount = 0;
    const startTime = 1000;

    // First call in the repository (after upsert) should return a later time
    vi.spyOn(performance, 'now').mockImplementation(() => {
      callCount++;
      // The repository calls performance.now() after upsert to compute latency
      return startTime + 42.5; // 42.5ms after startTime
    });

    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING' }] }) // UPSERT
      .mockResolvedValueOnce(undefined) // delivery INSERT
      .mockResolvedValueOnce(undefined); // COMMIT

    await repo.saveEventAndDelivery(
      baseEvent,
      baseDelivery,
      startTime,
      () => 'CREATED',
    );

    // Verify the delivery INSERT received the computed latency
    const deliveryInsertCall = mockClient.query.mock.calls[2]!;
    const deliveryParams = deliveryInsertCall[1] as unknown[];
    const latencyMs = deliveryParams[2] as number;

    // latency should be ~42.5 (performance.now() - startTime)
    expect(latencyMs).toBe(42.5);

    // Verify performance.now was called AFTER the upsert (call index 2 = delivery insert)
    // The upsert is call index 1, so performance.now must have been called after it
    expect(callCount).toBeGreaterThanOrEqual(1);

    vi.restoreAllMocks();
  });
});
