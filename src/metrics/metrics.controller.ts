import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsRepository } from './metrics.repository.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsRepository: MetricsRepository) {}

  @Get()
  async getMetrics(@Res() res: Response): Promise<void> {
    try {
      const m = await this.metricsRepository.getMetrics();

      const lines = [
        '# HELP webhook_events_received_total Total webhook deliveries with valid HMAC.',
        '# TYPE webhook_events_received_total counter',
        `webhook_events_received_total ${m.webhook_events_received_total}`,
        '',
        '# HELP webhook_duplicate_events_total Total duplicate webhook deliveries.',
        '# TYPE webhook_duplicate_events_total counter',
        `webhook_duplicate_events_total ${m.webhook_duplicate_events_total}`,
        '',
        '# HELP webhook_out_of_order_events_total Total out-of-order (stale sequence) events.',
        '# TYPE webhook_out_of_order_events_total counter',
        `webhook_out_of_order_events_total ${m.webhook_out_of_order_events_total}`,
        '',
        '# HELP webhook_dlq_size Current number of events in the dead-letter queue.',
        '# TYPE webhook_dlq_size gauge',
        `webhook_dlq_size ${m.webhook_dlq_size}`,
        '',
        '# HELP webhook_ingest_latency_p95_ms 95th percentile ingest latency in milliseconds.',
        '# TYPE webhook_ingest_latency_p95_ms gauge',
        `webhook_ingest_latency_p95_ms ${m.webhook_ingest_latency_p95_ms}`,
        '',
        '# HELP webhook_processing_latency_p95_ms 95th percentile processing latency in milliseconds.',
        '# TYPE webhook_processing_latency_p95_ms gauge',
        `webhook_processing_latency_p95_ms ${m.webhook_processing_latency_p95_ms}`,
        '',
      ];

      res
        .status(200)
        .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
        .send(lines.join('\n'));
    } catch {
      res
        .status(503)
        .header('Content-Type', 'text/plain')
        .send('Metrics temporarily unavailable');
    }
  }
}
