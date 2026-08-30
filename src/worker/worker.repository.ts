import { Inject, Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { PaymentEventProcessor } from './payment-event-processor.js';
import type { ClaimedEvent, OrderRow, ProcessingResult } from './types/worker.types.js';

const { Pool } = pg;

export interface ProcessOneResult {
  found: boolean;
  event_id?: string;
  order_id?: string;
  outcome?: string;
  outcome_reason?: string | null;
  correlation_id?: string;
  sequence?: number;
}

@Injectable()
export class WorkerRepository {
  private readonly logger = new Logger(WorkerRepository.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
    private readonly processor: PaymentEventProcessor,
  ) {}

  async processOne(): Promise<ProcessOneResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimResult = await client.query<ClaimedEvent>(
        `SELECT id, event_id, order_id, event_type, sequence, occurred_at, payload, correlation_id
         FROM webhook_events
         WHERE processing_status = 'PENDING'
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );

      if (claimResult.rows.length === 0) {
        await client.query('COMMIT');
        return { found: false };
      }

      const event = claimResult.rows[0]!;

      // Create order if not exists
      await client.query(
        `INSERT INTO orders (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [event.order_id],
      );

      // Lock order
      const orderResult = await client.query<OrderRow>(
        `SELECT id, status, last_sequence, amount, currency
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [event.order_id],
      );

      const order = orderResult.rows[0]!;
      const result: ProcessingResult = this.processor.process(event, order);

      if (result.outcome === 'APPLIED') {
        // Update order
        await client.query(
          `UPDATE orders
           SET status = $1,
               last_sequence = $2,
               amount = COALESCE($3, amount),
               currency = COALESCE($4, currency),
               updated_at = clock_timestamp()
           WHERE id = $5`,
          [result.new_status, result.new_sequence, result.amount, result.currency, event.order_id],
        );

        // Insert history
        await client.query(
          `INSERT INTO order_status_history
             (event_id, order_id, sequence, previous_status, new_status, outcome, outcome_reason, source)
           VALUES ($1, $2, $3, $4, $5, 'APPLIED', NULL, 'WEBHOOK')`,
          [event.event_id, event.order_id, event.sequence, result.previous_status, result.new_status],
        );

        // Mark event
        await client.query(
          `UPDATE webhook_events
           SET processing_status = 'APPLIED',
               outcome_reason = NULL,
               processed_at = clock_timestamp()
           WHERE id = $1`,
          [event.id],
        );
      } else {
        // IGNORED
        // Insert history
        await client.query(
          `INSERT INTO order_status_history
             (event_id, order_id, sequence, previous_status, new_status, outcome, outcome_reason, source)
           VALUES ($1, $2, $3, $4, $5, 'IGNORED', $6, 'WEBHOOK')`,
          [event.event_id, event.order_id, event.sequence, result.previous_status, result.new_status, result.outcome_reason],
        );

        // Mark event
        await client.query(
          `UPDATE webhook_events
           SET processing_status = 'IGNORED',
               outcome_reason = $1,
               processed_at = clock_timestamp()
           WHERE id = $2`,
          [result.outcome_reason, event.id],
        );
      }

      await client.query('COMMIT');

      return {
        found: true,
        event_id: event.event_id,
        order_id: event.order_id,
        outcome: result.outcome,
        outcome_reason: result.outcome_reason,
        correlation_id: event.correlation_id,
        sequence: event.sequence,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      this.logger.error('Worker transaction failed', (err as Error).stack);
      throw err;
    } finally {
      client.release();
    }
  }
}
