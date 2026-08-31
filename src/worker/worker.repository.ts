import { Inject, Injectable } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { PaymentEventProcessor } from './payment-event-processor.js';
import { RetryPolicy } from './retry-policy.js';
import type { ClaimedEvent, OrderRow, ProcessingResult } from './types/worker.types.js';

const { Pool } = pg;

const MAX_ERROR_LENGTH = 2000;

export interface ClaimedEventInfo {
  event_id: string;
  order_id: string;
  correlation_id: string;
  sequence: number;
}

export interface ProcessOneResult {
  found: boolean;
  event_id?: string;
  order_id?: string;
  outcome?: string;
  outcome_reason?: string | null;
  correlation_id?: string;
  sequence?: number;
  attempt_count?: number;
  next_attempt_at?: Date | null;
}

function sanitizeError(err: unknown): string {
  let message: string;
  if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  // Remove potential secrets
  message = message.replace(/WEBHOOK_SECRET[^\s]*/gi, '[REDACTED]');
  message = message.replace(/password[^\s]*/gi, '[REDACTED]');
  message = message.replace(/secret[^\s]*/gi, '[REDACTED]');
  // Remove potential payload dumps (JSON-like large strings)
  message = message.replace(/\{[\s\S]{200,}\}/g, '{[PAYLOAD_REDACTED]}');
  if (message.length > MAX_ERROR_LENGTH) {
    message = message.substring(0, MAX_ERROR_LENGTH - 3) + '...';
  }
  return message;
}

@Injectable()
export class WorkerRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
    private readonly processor: PaymentEventProcessor,
    private readonly retryPolicy: RetryPolicy,
  ) {}

  async processOne(onClaimed?: (info: ClaimedEventInfo) => void): Promise<ProcessOneResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimResult = await client.query<ClaimedEvent>(
        `SELECT id, event_id, order_id, event_type, sequence, occurred_at, payload,
                correlation_id, attempt_count, next_attempt_at
         FROM webhook_events
         WHERE processing_status = 'PENDING'
            OR (
                processing_status = 'RETRY_SCHEDULED'
                AND next_attempt_at <= clock_timestamp()
            )
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );

      if (claimResult.rows.length === 0) {
        await client.query('COMMIT');
        return { found: false };
      }

      const event = claimResult.rows[0]!;

      // Notify observer that event has been claimed (before business logic)
      if (onClaimed) {
        try {
          onClaimed({
            event_id: event.event_id,
            order_id: event.order_id,
            correlation_id: event.correlation_id,
            sequence: event.sequence,
          });
        } catch {
          // Observability callback must never interrupt the transaction
        }
      }

      // SAVEPOINT protects the business logic block
      await client.query('SAVEPOINT business_processing');

      let result: ProcessingResult;
      try {
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
        result = this.processor.process(event, order);

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

          // Mark event APPLIED
          await client.query(
            `UPDATE webhook_events
             SET processing_status = 'APPLIED',
                 outcome_reason = NULL,
                 next_attempt_at = NULL,
                 processed_at = clock_timestamp()
             WHERE id = $1`,
            [event.id],
          );
        } else {
          // IGNORED (STALE_SEQUENCE or UNKNOWN_EVENT_TYPE)
          // Insert history
          await client.query(
            `INSERT INTO order_status_history
               (event_id, order_id, sequence, previous_status, new_status, outcome, outcome_reason, source)
             VALUES ($1, $2, $3, $4, $5, 'IGNORED', $6, 'WEBHOOK')`,
            [event.event_id, event.order_id, event.sequence, result.previous_status, result.new_status, result.outcome_reason],
          );

          // Mark event IGNORED
          await client.query(
            `UPDATE webhook_events
             SET processing_status = 'IGNORED',
                 outcome_reason = $1,
                 next_attempt_at = NULL,
                 processed_at = clock_timestamp()
             WHERE id = $2`,
            [result.outcome_reason, event.id],
          );
        }
      } catch (businessError) {
        // Business processing failed — rollback SAVEPOINT
        await client.query('ROLLBACK TO SAVEPOINT business_processing');
        await client.query('RELEASE SAVEPOINT business_processing');

        // Still within the outer transaction, event lock is held
        const errorMessage = sanitizeError(businessError);
        const decision = this.retryPolicy.evaluate(event.attempt_count);

        if (decision.isDlq) {
          // DLQ
          await client.query(
            `UPDATE webhook_events
             SET processing_status = 'DLQ',
                 attempt_count = $1,
                 next_attempt_at = NULL,
                 last_error = $2,
                 outcome_reason = 'MAX_ATTEMPTS_EXHAUSTED',
                 processed_at = clock_timestamp()
             WHERE id = $3`,
            [decision.attemptCount, errorMessage, event.id],
          );

          await client.query('COMMIT');

          return {
            found: true,
            event_id: event.event_id,
            order_id: event.order_id,
            outcome: 'DLQ',
            outcome_reason: 'MAX_ATTEMPTS_EXHAUSTED',
            correlation_id: event.correlation_id,
            sequence: event.sequence,
            attempt_count: decision.attemptCount,
            next_attempt_at: null,
          };
        } else {
          // RETRY_SCHEDULED
          await client.query(
            `UPDATE webhook_events
             SET processing_status = 'RETRY_SCHEDULED',
                 attempt_count = $1,
                 next_attempt_at = $2,
                 last_error = $3,
                 outcome_reason = 'TRANSIENT_ERROR',
                 processed_at = NULL
             WHERE id = $4`,
            [decision.attemptCount, decision.nextAttemptAt, errorMessage, event.id],
          );

          await client.query('COMMIT');

          return {
            found: true,
            event_id: event.event_id,
            order_id: event.order_id,
            outcome: 'RETRY_SCHEDULED',
            outcome_reason: 'TRANSIENT_ERROR',
            correlation_id: event.correlation_id,
            sequence: event.sequence,
            attempt_count: decision.attemptCount,
            next_attempt_at: decision.nextAttemptAt,
          };
        }
      }

      // Deterministic success — RELEASE SAVEPOINT and COMMIT outside business catch
      await client.query('RELEASE SAVEPOINT business_processing');
      await client.query('COMMIT');

      return {
        found: true,
        event_id: event.event_id,
        order_id: event.order_id,
        outcome: result.outcome,
        outcome_reason: result.outcome_reason,
        correlation_id: event.correlation_id,
        sequence: event.sequence,
        attempt_count: event.attempt_count,
        next_attempt_at: null,
      };
    } catch (err) {
      // Outer transaction failure (BEGIN, claim, SAVEPOINT, ROLLBACK TO, retry/DLQ update, COMMIT, connection)
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
