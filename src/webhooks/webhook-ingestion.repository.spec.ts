import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookIngestionRepository } from './webhook-ingestion.repository.js';

describe('WebhookIngestionRepository', () => {
  let repo: WebhookIngestionRepository;
  let mockPool: { query: ReturnType<typeof vi.fn> };

  const baseEvent = {
    event_id: 'evt-001',
    order_id: 'order-001',
    event_type: 'payment.authorized',
    sequence: 1,
    occurred_at: '2024-01-01T00:00:00Z',
    payload: '{"test":true}',
    payload_hash: 'abc123',
    received_at: new Date(),
    processing_status: 'PENDING',
    outcome_reason: null,
    processed_at: null,
    correlation_id: 'corr-001',
  };

  const baseDelivery = {
    event_id: 'evt-001',
    received_at: new Date(),
    correlation_id: 'corr-001',
  };

  beforeEach(() => {
    mockPool = {
      query: vi.fn(),
    };
    repo = new WebhookIngestionRepository(mockPool as any);
  });

  it('should execute a single CTE query containing UPSERT and delivery INSERT', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING', delivery_result: 'CREATED' }],
    });

    const result = await repo.saveEventAndDelivery(baseEvent, baseDelivery);

    expect(result.upsert.delivery_count).toBe(1);
    expect(result.deliveryResult).toBe('CREATED');
    // Single query call — no BEGIN/COMMIT round trips
    expect(mockPool.query).toHaveBeenCalledOnce();

    const sql = mockPool.query.mock.calls[0]![0] as string;
    expect(sql).toContain('INSERT INTO webhook_events');
    expect(sql).toContain('INSERT INTO webhook_deliveries');
  });

  it('should compute latency_ms with clock_timestamp() and received_at inside SQL', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING', delivery_result: 'CREATED' }],
    });

    await repo.saveEventAndDelivery(baseEvent, baseDelivery);

    const sql = mockPool.query.mock.calls[0]![0] as string;
    expect(sql).toContain('clock_timestamp()');
    expect(sql).toContain('$15::timestamptz');
    // latency_ms is computed in SQL, not passed as a parameter
    const params = mockPool.query.mock.calls[0]![1] as unknown[];
    // Should have 16 params (no latency_ms param)
    expect(params).toHaveLength(16);
    // No param should be a pre-calculated latency number
    // $15 is received_at (Date), $16 is correlation_id (string)
    expect(params[14]).toBeInstanceOf(Date); // $15 = received_at
    expect(typeof params[15]).toBe('string'); // $16 = correlation_id
  });

  it('should not accept resolveResult as a parameter (dead code removed)', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING', delivery_result: 'CREATED' }],
    });

    // saveEventAndDelivery only takes 2 params now
    expect(repo.saveEventAndDelivery.length).toBe(2);

    await repo.saveEventAndDelivery(baseEvent, baseDelivery);
    expect(mockPool.query).toHaveBeenCalledOnce();
  });

  it('delivery INSERT depends on resolved which depends on evt', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING', delivery_result: 'CREATED' }],
    });

    await repo.saveEventAndDelivery(baseEvent, baseDelivery);

    const sql = mockPool.query.mock.calls[0]![0] as string;
    // resolved references evt
    expect(sql).toMatch(/resolved\s+AS\s*\(\s*SELECT[\s\S]*FROM\s+evt/);
    // dlv references resolved
    expect(sql).toMatch(/dlv\s+AS\s*\(\s*INSERT[\s\S]*FROM\s+resolved/);
  });

  it('should return CREATED for new non-stale event via CTE CASE', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'PENDING', delivery_result: 'CREATED' }],
    });

    const result = await repo.saveEventAndDelivery(baseEvent, baseDelivery);

    expect(result.deliveryResult).toBe('CREATED');
    // Verify isStale parameter ($13) is false for PENDING status
    const params = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(params[12]).toBe(false); // isStale
  });

  it('should return IGNORED for stale event via CTE CASE', async () => {
    const staleEvent = { ...baseEvent, processing_status: 'IGNORED' };

    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 1, payload_hash: 'abc123', processing_status: 'IGNORED', delivery_result: 'IGNORED' }],
    });

    const result = await repo.saveEventAndDelivery(staleEvent, baseDelivery);

    expect(result.deliveryResult).toBe('IGNORED');
    // Verify isStale parameter ($13) is true for IGNORED status
    const params = mockPool.query.mock.calls[0]![1] as unknown[];
    expect(params[12]).toBe(true); // isStale
  });

  it('should return DUPLICATE when delivery_count > 1 and payload_hash matches', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: 1, delivery_count: 2, payload_hash: 'abc123', processing_status: 'PENDING', delivery_result: 'DUPLICATE' }],
    });

    const result = await repo.saveEventAndDelivery(baseEvent, baseDelivery);

    expect(result.deliveryResult).toBe('DUPLICATE');
  });

  it('should propagate errors from pool.query', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('PG error'));

    await expect(
      repo.saveEventAndDelivery(baseEvent, baseDelivery),
    ).rejects.toThrow('PG error');
  });
});
