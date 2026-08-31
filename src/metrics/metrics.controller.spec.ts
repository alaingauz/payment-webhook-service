import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricsController } from './metrics.controller.js';
import type { MetricsRepository } from './metrics.repository.js';

function createMockResponse() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    header(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    send(body: string) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe('MetricsController', () => {
  let controller: MetricsController;
  let mockRepo: { getMetrics: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockRepo = { getMetrics: vi.fn() };
    controller = new MetricsController(mockRepo as unknown as MetricsRepository);
  });

  it('should return 200 with Prometheus format containing HELP, TYPE and values', async () => {
    mockRepo.getMetrics.mockResolvedValue({
      webhook_events_received_total: 10,
      webhook_duplicate_events_total: 2,
      webhook_out_of_order_events_total: 1,
      webhook_dlq_size: 0,
      webhook_ingest_latency_p95_ms: 5.5,
      webhook_processing_latency_p95_ms: 100.2,
    });

    const res = createMockResponse();
    await controller.getMetrics(res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/plain; version=0.0.4; charset=utf-8');

    const body = res.body as string;

    // Check all metrics have HELP and TYPE
    expect(body).toContain('# HELP webhook_events_received_total');
    expect(body).toContain('# TYPE webhook_events_received_total counter');
    expect(body).toContain('webhook_events_received_total 10');

    expect(body).toContain('# HELP webhook_duplicate_events_total');
    expect(body).toContain('# TYPE webhook_duplicate_events_total counter');
    expect(body).toContain('webhook_duplicate_events_total 2');

    expect(body).toContain('# HELP webhook_out_of_order_events_total');
    expect(body).toContain('# TYPE webhook_out_of_order_events_total counter');
    expect(body).toContain('webhook_out_of_order_events_total 1');

    expect(body).toContain('# HELP webhook_dlq_size');
    expect(body).toContain('# TYPE webhook_dlq_size gauge');
    expect(body).toContain('webhook_dlq_size 0');

    expect(body).toContain('# HELP webhook_ingest_latency_p95_ms');
    expect(body).toContain('# TYPE webhook_ingest_latency_p95_ms gauge');
    expect(body).toContain('webhook_ingest_latency_p95_ms 5.5');

    expect(body).toContain('# HELP webhook_processing_latency_p95_ms');
    expect(body).toContain('# TYPE webhook_processing_latency_p95_ms gauge');
    expect(body).toContain('webhook_processing_latency_p95_ms 100.2');
  });

  it('should return 503 when PostgreSQL is down', async () => {
    mockRepo.getMetrics.mockRejectedValue(new Error('connection refused'));

    const res = createMockResponse();
    await controller.getMetrics(res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('Metrics temporarily unavailable');
  });

  it('should return zeros for empty database', async () => {
    mockRepo.getMetrics.mockResolvedValue({
      webhook_events_received_total: 0,
      webhook_duplicate_events_total: 0,
      webhook_out_of_order_events_total: 0,
      webhook_dlq_size: 0,
      webhook_ingest_latency_p95_ms: 0,
      webhook_processing_latency_p95_ms: 0,
    });

    const res = createMockResponse();
    await controller.getMetrics(res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('webhook_events_received_total 0');
    expect(res.body).toContain('webhook_dlq_size 0');
    expect(res.body).toContain('webhook_ingest_latency_p95_ms 0');
  });
});
