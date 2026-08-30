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

@Injectable()
export class WebhookIngestionRepository {
  private readonly logger = new Logger(WebhookIngestionRepository.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
  ) {}

  /**
   * Upserts the event and inserts the delivery record in a single transaction.
   *
   * latency_ms is calculated **after** the upsert and immediately before
   * inserting webhook_deliveries.  This means the stored metric includes
   * pool-wait time, BEGIN, and the upsert itself (including any row-level
   * contention on event_id).  The external HTTP measurement from the
   * verification script remains the authoritative source for full
   * round-trip latency.
   */
  async saveEventAndDelivery(
    event: EventInsertParams,
    deliveryBase: DeliveryBaseParams,
    startTime: number,
    resolveResult: (upsert: UpsertResult) => string,
  ): Promise<{ upsert: UpsertResult; deliveryResult: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const upsertResult = await client.query<UpsertResult>(
        `INSERT INTO webhook_events (
          event_id, order_id, event_type, sequence, occurred_at,
          payload, payload_hash, received_at, processing_status,
          outcome_reason, processed_at, correlation_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (event_id)
        DO UPDATE SET
          delivery_count = webhook_events.delivery_count + 1
        RETURNING id, delivery_count, payload_hash, processing_status`,
        [
          event.event_id,
          event.order_id,
          event.event_type,
          event.sequence,
          event.occurred_at,
          event.payload,
          event.payload_hash,
          event.received_at,
          event.processing_status,
          event.outcome_reason,
          event.processed_at,
          event.correlation_id,
        ],
      );

      const row = upsertResult.rows[0]!;
      const deliveryResult = resolveResult(row);

      // Calculate latency AFTER the upsert, immediately before delivery insert
      const latencyMs = Math.max(0, parseFloat((performance.now() - startTime).toFixed(2)));

      await client.query(
        `INSERT INTO webhook_deliveries (
          event_id, received_at, latency_ms, result, correlation_id
        )
        VALUES ($1, $2, $3, $4, $5)`,
        [
          deliveryBase.event_id,
          deliveryBase.received_at,
          latencyMs,
          deliveryResult,
          deliveryBase.correlation_id,
        ],
      );

      await client.query('COMMIT');

      return { upsert: row, deliveryResult };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.logger.error('Transaction failed', (err as Error).stack);
      throw err;
    } finally {
      client.release();
    }
  }
}
