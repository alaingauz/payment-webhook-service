import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

const { Pool } = pg;

export interface OrderDetailRow {
  id: string;
  status: string;
  last_sequence: number;
  amount: string | null;
  currency: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderEventRow {
  event_id: string;
  event_type: string;
  sequence: number;
  occurred_at: Date;
  received_at: Date;
  processing_status: string;
  outcome_reason: string | null;
  attempt_count: number;
  delivery_count: number;
  processed_at: Date | null;
  next_attempt_at: Date | null;
  last_error: string | null;
  replay_count: number;
}

export interface StatusChangeRow {
  event_id: string | null;
  sequence: number;
  previous_status: string | null;
  new_status: string | null;
  outcome: string;
  outcome_reason: string | null;
  source: string;
  changed_at: Date;
}

export interface OrderDetail {
  order: OrderDetailRow;
  events: OrderEventRow[];
  statusChanges: StatusChangeRow[];
}

@Injectable()
export class OrdersRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
  ) {}

  async findById(orderId: string): Promise<OrderDetail | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY ISOLATION LEVEL REPEATABLE READ');

      const orderResult = await client.query<OrderDetailRow>(
        `SELECT id, status, last_sequence, amount, currency, created_at, updated_at
         FROM orders WHERE id = $1`,
        [orderId],
      );

      if (orderResult.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const order = orderResult.rows[0]!;

      const eventsResult = await client.query<OrderEventRow>(
        `SELECT event_id, event_type, sequence, occurred_at, received_at,
                processing_status, outcome_reason, attempt_count, delivery_count, processed_at,
                next_attempt_at, last_error, replay_count
         FROM webhook_events
         WHERE order_id = $1
         ORDER BY received_at, id`,
        [orderId],
      );

      const historyResult = await client.query<StatusChangeRow>(
        `SELECT event_id, sequence, previous_status, new_status, outcome,
                outcome_reason, source, changed_at
         FROM order_status_history
         WHERE order_id = $1
         ORDER BY changed_at, id`,
        [orderId],
      );

      await client.query('COMMIT');

      return {
        order,
        events: eventsResult.rows,
        statusChanges: historyResult.rows,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
