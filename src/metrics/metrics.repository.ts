import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

const { Pool } = pg;

export interface MetricsSnapshot {
  webhook_events_received_total: number;
  webhook_duplicate_events_total: number;
  webhook_out_of_order_events_total: number;
  webhook_dlq_size: number;
  webhook_ingest_latency_p95_ms: number;
  webhook_processing_latency_p95_ms: number;
}

const METRICS_QUERY = `
SELECT
  COALESCE((SELECT COUNT(*) FROM webhook_deliveries), 0)::bigint
    AS events_received,
  COALESCE((SELECT COUNT(*) FROM webhook_deliveries WHERE result = 'DUPLICATE'), 0)::bigint
    AS duplicate_events,
  COALESCE((SELECT COUNT(*) FROM webhook_events WHERE outcome_reason = 'STALE_SEQUENCE'), 0)::bigint
    AS out_of_order_events,
  COALESCE((SELECT COUNT(*) FROM webhook_events WHERE processing_status = 'DLQ'), 0)::bigint
    AS dlq_size,
  COALESCE((SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FROM webhook_deliveries), 0)::float8
    AS ingest_latency_p95,
  COALESCE((
    SELECT percentile_cont(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (processed_at - received_at)) * 1000
    )
    FROM webhook_events
    WHERE processed_at IS NOT NULL
      AND processing_status IN ('APPLIED', 'IGNORED')
  ), 0)::float8
    AS processing_latency_p95
`;

interface MetricsRow {
  events_received: string;
  duplicate_events: string;
  out_of_order_events: string;
  dlq_size: string;
  ingest_latency_p95: string;
  processing_latency_p95: string;
}

@Injectable()
export class MetricsRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
  ) {}

  async getMetrics(): Promise<MetricsSnapshot> {
    const result = await this.pool.query<MetricsRow>(METRICS_QUERY);
    const row = result.rows[0]!;

    return {
      webhook_events_received_total: Number(row.events_received) || 0,
      webhook_duplicate_events_total: Number(row.duplicate_events) || 0,
      webhook_out_of_order_events_total: Number(row.out_of_order_events) || 0,
      webhook_dlq_size: Number(row.dlq_size) || 0,
      webhook_ingest_latency_p95_ms: Number(row.ingest_latency_p95) || 0,
      webhook_processing_latency_p95_ms: Number(row.processing_latency_p95) || 0,
    };
  }
}
