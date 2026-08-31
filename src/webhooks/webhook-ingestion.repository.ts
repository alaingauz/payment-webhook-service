import { Inject, Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

const { Pool } = pg;

export interface UpsertResult {
  id: number;
  delivery_count: number;
  payload_hash: string;
  processing_status: string;
}

export interface EventInsertParams {
  event_id: string;
  order_id: string;
  event_type: string;
  sequence: number;
  occurred_at: string;
  payload: string;
  payload_hash: string;
  received_at: Date;
  processing_status: string;
  outcome_reason: string | null;
  processed_at: Date | null;
  correlation_id: string;
}

export interface DeliveryBaseParams {
  event_id: string;
  received_at: Date;
  correlation_id: string;
}

/**
 * Single-statement CTE that upserts the event, determines the delivery
 * result, and inserts the delivery record atomically.
 *
 * A single PostgreSQL statement is implicitly atomic — no explicit
 * BEGIN/COMMIT is needed.  This reduces network round trips from 4
 * (BEGIN → UPSERT → INSERT delivery → COMMIT) to 1, which directly
 * lowers p95 latency under high concurrency.
 */
const UPSERT_AND_DELIVER_SQL = `
WITH evt AS (
  INSERT INTO webhook_events (
    event_id, order_id, event_type, sequence, occurred_at,
    payload, payload_hash, received_at, processing_status,
    outcome_reason, processed_at, correlation_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (event_id)
  DO UPDATE SET
    delivery_count = webhook_events.delivery_count + 1
  RETURNING id, delivery_count, payload_hash, processing_status
),
resolved AS (
  SELECT
    id,
    delivery_count,
    payload_hash,
    processing_status,
    CASE
      WHEN delivery_count = 1 AND $13::boolean THEN 'IGNORED'
      WHEN delivery_count = 1 THEN 'CREATED'
      WHEN payload_hash = $14 THEN 'DUPLICATE'
      ELSE 'REJECTED'
    END AS delivery_result
  FROM evt
),
dlv AS (
  INSERT INTO webhook_deliveries (
    event_id, received_at, latency_ms, result, correlation_id
  )
  SELECT
    $1,
    $15::timestamptz,
    GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - $15::timestamptz)) * 1000)::numeric(10,2),
    delivery_result,
    $16
  FROM resolved
)
SELECT id, delivery_count, payload_hash, processing_status, delivery_result
FROM resolved
`;

interface CteRow {
  id: number;
  delivery_count: number;
  payload_hash: string;
  processing_status: string;
  delivery_result: string;
}

@Injectable()
export class WebhookIngestionRepository {
  private readonly logger = new Logger(WebhookIngestionRepository.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
  ) {}

  /**
   * Upserts the event and inserts the delivery record in a single SQL
   * statement (CTE).  The statement is implicitly atomic so no explicit
   * transaction management is required.
   *
   * latency_ms is computed inside PostgreSQL using
   * clock_timestamp() − received_at immediately before the delivery INSERT.
   * It captures prior request processing, pool-wait time, the upsert, and
   * row-level contention on event_id.  It does not include the delivery
   * INSERT itself nor the HTTP response write.
   */
  async saveEventAndDelivery(
    event: EventInsertParams,
    deliveryBase: DeliveryBaseParams,
  ): Promise<{ upsert: UpsertResult; deliveryResult: string }> {
    const isStale = event.processing_status === 'IGNORED';

    try {
      const { rows } = await this.pool.query<CteRow>(
        UPSERT_AND_DELIVER_SQL,
        [
          event.event_id,        // $1
          event.order_id,        // $2
          event.event_type,      // $3
          event.sequence,        // $4
          event.occurred_at,     // $5
          event.payload,         // $6
          event.payload_hash,    // $7
          event.received_at,     // $8
          event.processing_status, // $9
          event.outcome_reason,  // $10
          event.processed_at,    // $11
          event.correlation_id,  // $12
          isStale,               // $13 — is_stale flag
          event.payload_hash,    // $14 — current payload hash for comparison
          deliveryBase.received_at, // $15
          deliveryBase.correlation_id, // $16
        ],
      );

      const row = rows[0]!;

      const upsert: UpsertResult = {
        id: row.id,
        delivery_count: row.delivery_count,
        payload_hash: row.payload_hash,
        processing_status: row.processing_status,
      };

      return { upsert, deliveryResult: row.delivery_result };
    } catch (err) {
      this.logger.error('Ingestion query failed', (err as Error).stack);
      throw err;
    }
  }
}
