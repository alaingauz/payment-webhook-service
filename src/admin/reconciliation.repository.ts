import { Inject, Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';
import type { ProviderOrder } from '../provider/provider-client.js';

const { Pool } = pg;

/**
 * Advisory lock key for reconciliation serialization.
 * Arbitrary constant: 0x5245434F4E = ASCII "RECON" truncated to fit int8.
 */
const ADVISORY_LOCK_KEY = 900_000_001;

export type ReconciliationAction = 'REPAIRED' | 'ALREADY_OK' | 'STALE_PROVIDER_SNAPSHOT';

export interface ReconciliationDetail {
  order_id: string;
  local_status: string | null;
  local_sequence: number | null;
  provider_status: string;
  provider_sequence: number;
  action: ReconciliationAction;
}

export interface ReconciliationRunResult {
  run_id: string;
  status: string;
  orders_checked: number;
  divergences: number;
  repaired: number;
  already_ok: number;
  stale_provider_snapshots: number;
  started_at: string;
  finished_at: string;
  details: ReconciliationDetail[];
}

/**
 * Normalize a NUMERIC/string amount to a canonical 2-decimal string
 * for safe comparison. Uses pure string manipulation, never Number
 * for money.
 *
 * NULL remains NULL (not "0.00").
 */
export function normalizeAmount(value: string | null | undefined): string | null {
  if (value == null) return null;
  const str = value.trim();
  if (str === '') return null;
  const dotIdx = str.indexOf('.');
  let intPart: string;
  let decPart: string;
  if (dotIdx === -1) {
    intPart = str;
    decPart = '00';
  } else {
    intPart = str.slice(0, dotIdx);
    decPart = str.slice(dotIdx + 1).padEnd(2, '0').slice(0, 2);
  }
  // Strip leading zeros, keep at least one digit
  intPart = intPart.replace(/^0+/, '') || '0';
  return `${intPart}.${decPart}`;
}

@Injectable()
export class ReconciliationRepository {
  private readonly logger = new Logger(ReconciliationRepository.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>,
  ) {}

  async executeReconciliation(
    providerOrders: ProviderOrder[],
  ): Promise<ReconciliationRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Serialize reconciliations with advisory lock (within transaction)
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);

      // Create reconciliation run
      const runResult = await client.query<{ id: string; started_at: Date }>(
        `INSERT INTO reconciliation_runs (status) VALUES ('RUNNING')
         RETURNING id::text, started_at`,
      );
      const runId = runResult.rows[0]!.id;
      const startedAt = runResult.rows[0]!.started_at;

      const details: ReconciliationDetail[] = [];
      let repaired = 0;
      let alreadyOk = 0;
      let staleProviderSnapshots = 0;

      for (const provOrder of providerOrders) {
        // 1. INSERT ... ON CONFLICT DO NOTHING RETURNING id
        const insertResult = await client.query<{ id: string }>(
          `INSERT INTO orders (id, status, last_sequence, amount, currency)
           VALUES ($1, 'pending', 0, NULL, NULL)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [provOrder.id],
        );
        const isNewOrder = insertResult.rows.length === 1;

        // 2. SELECT FOR UPDATE
        const orderResult = await client.query<{
          id: string;
          status: string;
          last_sequence: number;
          amount: string | null;
          currency: string | null;
        }>(
          `SELECT id, status, last_sequence, amount::text, currency
           FROM orders WHERE id = $1 FOR UPDATE`,
          [provOrder.id],
        );

        const local = orderResult.rows[0]!;
        const localSeq = local.last_sequence;
        const provSeq = provOrder.sequence;

        // Case A: provider_sequence < local_sequence -> STALE_PROVIDER_SNAPSHOT
        if (provSeq < localSeq) {
          details.push({
            order_id: provOrder.id,
            local_status: local.status,
            local_sequence: localSeq,
            provider_status: provOrder.status,
            provider_sequence: provSeq,
            action: 'STALE_PROVIDER_SNAPSHOT',
          });
          staleProviderSnapshots++;
          continue;
        }

        // Normalize amounts for comparison
        const localAmount = normalizeAmount(local.amount);
        const provAmount = normalizeAmount(provOrder.amount);

        // Case B: Everything matches -> ALREADY_OK
        if (
          local.status === provOrder.status &&
          localSeq === provSeq &&
          localAmount === provAmount &&
          (local.currency ?? null) === (provOrder.currency ?? null)
        ) {
          details.push({
            order_id: provOrder.id,
            local_status: local.status,
            local_sequence: localSeq,
            provider_status: provOrder.status,
            provider_sequence: provSeq,
            action: 'ALREADY_OK',
          });
          alreadyOk++;
          continue;
        }

        // Case C: Divergence or new order with provider_sequence >= local_sequence -> REPAIRED
        const previousStatus = isNewOrder ? null : local.status;

        // Update order
        await client.query(
          `UPDATE orders
           SET status = $1, last_sequence = $2, amount = $3, currency = $4, updated_at = now()
           WHERE id = $5`,
          [provOrder.status, provSeq, provOrder.amount, provOrder.currency, provOrder.id],
        );

        // Insert exactly one order_status_history row
        await client.query(
          `INSERT INTO order_status_history
           (order_id, event_id, sequence, previous_status, new_status, outcome, outcome_reason, source)
           VALUES ($1, NULL, $2, $3, $4, 'RECONCILED', 'PROVIDER_SOURCE_OF_TRUTH', 'RECONCILIATION')`,
          [provOrder.id, provSeq, previousStatus, provOrder.status],
        );

        details.push({
          order_id: provOrder.id,
          local_status: previousStatus,
          local_sequence: isNewOrder ? null : localSeq,
          provider_status: provOrder.status,
          provider_sequence: provSeq,
          action: 'REPAIRED',
        });
        repaired++;
      }

      const divergences = repaired + staleProviderSnapshots;

      // Insert reconciliation_details BEFORE marking run as COMPLETED
      for (const detail of details) {
        if (detail.action === 'REPAIRED') {
          await client.query(
            `INSERT INTO reconciliation_details
             (run_id, order_id, local_status, local_sequence, provider_status, provider_sequence, action, repaired_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
            [
              runId,
              detail.order_id,
              detail.local_status,
              detail.local_sequence,
              detail.provider_status,
              detail.provider_sequence,
              detail.action,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO reconciliation_details
             (run_id, order_id, local_status, local_sequence, provider_status, provider_sequence, action, repaired_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
            [
              runId,
              detail.order_id,
              detail.local_status,
              detail.local_sequence,
              detail.provider_status,
              detail.provider_sequence,
              detail.action,
            ],
          );
        }
      }

      // Update run as COMPLETED — finished_at is the last write of the run
      const finishResult = await client.query<{ finished_at: Date }>(
        `UPDATE reconciliation_runs
         SET status = 'COMPLETED',
             orders_checked = $1,
             divergences = $2,
             repaired = $3,
             finished_at = clock_timestamp()
         WHERE id = $4
         RETURNING finished_at`,
        [providerOrders.length, divergences, repaired, runId],
      );

      await client.query('COMMIT');

      return {
        run_id: runId,
        status: 'COMPLETED',
        orders_checked: providerOrders.length,
        divergences,
        repaired,
        already_ok: alreadyOk,
        stale_provider_snapshots: staleProviderSnapshots,
        started_at: startedAt.toISOString(),
        finished_at: finishResult.rows[0]!.finished_at.toISOString(),
        details,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
