import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricsRepository } from './metrics.repository.js';

describe('MetricsRepository', () => {
  let repo: MetricsRepository;
  let mockPool: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPool = { query: vi.fn() };
    repo = new MetricsRepository(mockPool as any);
  });

  it('should map all metrics from SQL result', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        events_received: '42',
        duplicate_events: '5',
        out_of_order_events: '3',
        dlq_size: '2',
        ingest_latency_p95: '12.5',
        processing_latency_p95: '150.75',
      }],
    });

    const result = await repo.getMetrics();

    expect(result.webhook_events_received_total).toBe(42);
    expect(result.webhook_duplicate_events_total).toBe(5);
    expect(result.webhook_out_of_order_events_total).toBe(3);
    expect(result.webhook_dlq_size).toBe(2);
    expect(result.webhook_ingest_latency_p95_ms).toBe(12.5);
    expect(result.webhook_processing_latency_p95_ms).toBe(150.75);
  });

  it('should return zeros for empty database', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        events_received: '0',
        duplicate_events: '0',
        out_of_order_events: '0',
        dlq_size: '0',
        ingest_latency_p95: '0',
        processing_latency_p95: '0',
      }],
    });

    const result = await repo.getMetrics();

    expect(result.webhook_events_received_total).toBe(0);
    expect(result.webhook_duplicate_events_total).toBe(0);
    expect(result.webhook_out_of_order_events_total).toBe(0);
    expect(result.webhook_dlq_size).toBe(0);
    expect(result.webhook_ingest_latency_p95_ms).toBe(0);
    expect(result.webhook_processing_latency_p95_ms).toBe(0);
  });

  it('should never return NaN or undefined', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        events_received: null,
        duplicate_events: undefined,
        out_of_order_events: '',
        dlq_size: 'NaN',
        ingest_latency_p95: null,
        processing_latency_p95: null,
      }],
    });

    const result = await repo.getMetrics();

    for (const value of Object.values(result)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });

  it('should not interpolate user values in SQL', async () => {
    mockPool.query.mockResolvedValue({
      rows: [{
        events_received: '0',
        duplicate_events: '0',
        out_of_order_events: '0',
        dlq_size: '0',
        ingest_latency_p95: '0',
        processing_latency_p95: '0',
      }],
    });

    await repo.getMetrics();

    // query should be called with a static string, no parameters
    const call = mockPool.query.mock.calls[0]!;
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe('string');
  });

  it('should propagate database errors', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));
    await expect(repo.getMetrics()).rejects.toThrow('connection refused');
  });
});
