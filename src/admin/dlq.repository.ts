import { Inject, Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

const { Pool } = pg;

export interface DlqEventRow {
  id: string;
  event_id: string;
  order_id: string;
  event_type: string;
  sequence: number;
  processing_status: string;
  attempt_count: number;
  last_error: string | null;
  outcome_reason: string | null;
  received_at: Date;
  processed_at: Date | null;
  replay_count: number;
  correlation_id: string;
}

export interface DlqListResult {
  items: DlqEventRow[];
  total: number;
}

export interface ReplayResult {
  id: string;
  event_id: string;
  result: 'REPLAYED' | 'NOT_IN_DLQ';
  processing_status: string;
  replay_count?: number;
}

@Injectable()
export class DlqRepository {
  private readonly logger = new Logger(DlqRepository.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
  ) {}

  async list(limit: number, offset: number): Promise<DlqListResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');

      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM webhook_events WHERE processing_status = 'DLQ'`,
      );
      const total = parseInt(countResult.rows[0]!.count, 10);

      const itemsResult = await client.query<DlqEventRow>(
        `SELECT id::text AS id, event_id, order_id, event_type, sequence,
                processing_status, attempt_count, last_error, outcome_reason,
                received_at, processed_at, replay_count, correlation_id
         FROM webhook_events
         WHERE processing_status = 'DLQ'
         ORDER BY processed_at DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      await client.query('COMMIT');

      return { items: itemsResult.rows, total };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<DlqEventRow | null> {
    const result = await this.pool.query<DlqEventRow>(
      `SELECT id::text AS id, event_id, order_id, event_type, sequence,
              processing_status, attempt_count, last_error, outcome_reason,
              received_at, processed_at, replay_count, correlation_id
       FROM webhook_events
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async replay(id: string): Promise<ReplayResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const selectResult = await client.query<DlqEventRow>(
        `SELECT id::text AS id, event_id, order_id, event_type, sequence,
                processing_status, attempt_count, last_error, outcome_reason,
                received_at, processed_at, replay_count, correlation_id
         FROM webhook_events
         WHERE id = $1
         FOR UPDATE`,
        [id],
      );

      if (selectResult.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const event = selectResult.rows[0]!;

      if (event.processing_status === 'DLQ') {
        const updateResult = await client.query<DlqEventRow>(
          `UPDATE webhook_events
           SET processing_status = 'PENDING',
               attempt_count = 0,
               next_attempt_at = NULL,
               last_error = NULL,
               outcome_reason = NULL,
               processed_at = NULL,
               replay_count = replay_count + 1
           WHERE id = $1
           RETURNING id::text AS id, event_id, replay_count, processing_status`,
          [id],
        );

        await client.query('COMMIT');

        const updated = updateResult.rows[0]!;

        this.logger.log(
          `REPLAYED id=${updated.id} event_id=${updated.event_id} ` +
          `replay_count=${updated.replay_count}`,
        );

        return {
          id: updated.id,
          event_id: updated.event_id,
          result: 'REPLAYED',
          processing_status: updated.processing_status,
          replay_count: updated.replay_count,
        };
      } else {
        // Not in DLQ — don't modify
        await client.query('COMMIT');

        this.logger.log(
          `NOT_IN_DLQ id=${event.id} event_id=${event.event_id} ` +
          `processing_status=${event.processing_status}`,
        );

        return {
          id: event.id,
          event_id: event.event_id,
          result: 'NOT_IN_DLQ',
          processing_status: event.processing_status,
        };
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
