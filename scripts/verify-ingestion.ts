/**
 * Verification script for webhook ingestion (Phase 2).
 * Requires the API running on localhost:3000 and PostgreSQL accessible.
 *
 * IMPORTANT: Run with the API active and workers STOPPED, because this script
 * verifies that the ingestion layer does not process orders inline.
 *
 * Usage: tsx scripts/verify-ingestion.ts
 */

import { createHmac, createHash } from 'node:crypto';
import pg from 'pg';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const SECRET = process.env['WEBHOOK_SECRET'] ?? 'dev-webhook-secret-change-me';
const RUN_PREFIX = `vi-${Date.now()}`;

const DB_CONFIG = {
  host: process.env['DB_HOST'] ?? 'localhost',
  port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
  user: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? 'postgres',
  database: process.env['DB_NAME'] ?? 'webhooks',
};

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

async function sendWebhook(
  payload: object,
  options: { signature?: string; skipSign?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> | null; latency: number }> {
  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!options.skipSign) {
    headers['X-Signature'] = options.signature ?? sign(bodyStr);
  }

  const start = performance.now();
  const res = await fetch(`${API_URL}/webhooks/payments`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });
  const latency = performance.now() - start;
  const resBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  return { status: res.status, body: resBody, latency };
}

/**
 * Run up to `concurrency` promises at a time from `tasks`.
 */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]!();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function computeP95(latencies: number[]): number {
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[idx]!;
}

async function main() {
  const pool = new pg.Pool(DB_CONFIG);

  try {
    console.log(`🔧 Ingestion verification script (prefix: ${RUN_PREFIX})`);
    console.log(`   API: ${API_URL}`);
    console.log(`   Workers must be STOPPED for this test.\n`);

    // ══════════════════════════════════════════════════════════════
    // Test 1: Hot-key idempotency and contention test
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 1: Hot-key idempotency and contention test (100 concurrent, same event_id)');
    const hotKeyEventId = `${RUN_PREFIX}-hotkey-001`;
    const hotKeyPayload = {
      event_id: hotKeyEventId,
      order_id: `${RUN_PREFIX}-order-hotkey`,
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date().toISOString(),
      data: { amount: 500, currency: 'MXN' },
    };

    const hotKeyLatencies: number[] = [];
    const hotKeyPromises = Array.from({ length: 100 }, () =>
      sendWebhook(hotKeyPayload).then((r) => {
        hotKeyLatencies.push(r.latency);
        return r;
      }),
    );
    const hotKeyResults = await Promise.all(hotKeyPromises);

    const all202 = hotKeyResults.every((r) => r.status === 202);
    assert(all202, 'All 100 requests returned 202');

    const { rows: hotKeyEvents } = await pool.query(
      'SELECT delivery_count FROM webhook_events WHERE event_id = $1',
      [hotKeyEventId],
    );
    assert(hotKeyEvents.length === 1, `Exactly 1 row in webhook_events (got ${hotKeyEvents.length})`);
    assert(
      hotKeyEvents[0]?.delivery_count === 100,
      `delivery_count = 100 (got ${hotKeyEvents[0]?.delivery_count})`,
    );

    const { rows: hotKeyDeliveries } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM webhook_deliveries WHERE event_id = $1',
      [hotKeyEventId],
    );
    assert(
      hotKeyDeliveries[0]?.count === 100,
      `100 rows in webhook_deliveries (got ${hotKeyDeliveries[0]?.count})`,
    );

    const hotKeyP95 = computeP95(hotKeyLatencies);

    // ══════════════════════════════════════════════════════════════
    // Test 2: Stale event
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 2: Stale event');
    const stalePayload = {
      event_id: `${RUN_PREFIX}-stale-001`,
      order_id: `${RUN_PREFIX}-order-stale`,
      event_type: 'payment.pending',
      sequence: 0,
      occurred_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      data: { amount: 100, currency: 'USD' },
    };

    const staleResult = await sendWebhook(stalePayload);
    assert(staleResult.status === 202, `Stale event returns 202 (got ${staleResult.status})`);
    assert(
      staleResult.body?.result === 'IGNORED',
      `Stale event result = IGNORED (got ${staleResult.body?.result})`,
    );

    const { rows: staleEvents } = await pool.query(
      'SELECT processing_status, outcome_reason FROM webhook_events WHERE event_id = $1',
      [stalePayload.event_id],
    );
    assert(
      staleEvents[0]?.processing_status === 'IGNORED',
      `processing_status = IGNORED (got ${staleEvents[0]?.processing_status})`,
    );
    assert(
      staleEvents[0]?.outcome_reason === 'STALE_TIMESTAMP',
      `outcome_reason = STALE_TIMESTAMP (got ${staleEvents[0]?.outcome_reason})`,
    );

    // ══════════════════════════════════════════════════════════════
    // Test 3: Invalid signature — no webhook_events, no webhook_deliveries
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 3: Invalid signature');
    const invalidPayload = {
      event_id: `${RUN_PREFIX}-invalid-sig-001`,
      order_id: `${RUN_PREFIX}-order-invalid`,
      event_type: 'payment.failed',
      sequence: 0,
      occurred_at: new Date().toISOString(),
      data: { amount: 0, currency: 'USD' },
    };

    const invalidResult = await sendWebhook(invalidPayload, { signature: 'a'.repeat(64) });
    assert(invalidResult.status === 401, `Invalid sig returns 401 (got ${invalidResult.status})`);

    const { rows: invalidEvents } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM webhook_events WHERE event_id = $1',
      [invalidPayload.event_id],
    );
    assert(
      invalidEvents[0]?.count === 0,
      `No rows in webhook_events for invalid sig (got ${invalidEvents[0]?.count})`,
    );

    const { rows: invalidDeliveries } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM webhook_deliveries WHERE event_id = $1',
      [invalidPayload.event_id],
    );
    assert(
      invalidDeliveries[0]?.count === 0,
      `No rows in webhook_deliveries for invalid sig (got ${invalidDeliveries[0]?.count})`,
    );

    // ══════════════════════════════════════════════════════════════
    // Test 4: Absent signature — no webhook_events, no webhook_deliveries
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 4: Missing signature');
    const noSigPayload = {
      event_id: `${RUN_PREFIX}-no-sig-001`,
      order_id: `${RUN_PREFIX}-order-nosig`,
      event_type: 'payment.captured',
      sequence: 0,
      occurred_at: new Date().toISOString(),
      data: { amount: 50, currency: 'EUR' },
    };

    const noSigResult = await sendWebhook(noSigPayload, { skipSign: true });
    assert(noSigResult.status === 401, `Missing sig returns 401 (got ${noSigResult.status})`);

    const { rows: noSigEvents } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM webhook_events WHERE event_id = $1',
      [noSigPayload.event_id],
    );
    assert(
      noSigEvents[0]?.count === 0,
      `No rows in webhook_events for absent sig (got ${noSigEvents[0]?.count})`,
    );

    const { rows: noSigDeliveries } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM webhook_deliveries WHERE event_id = $1',
      [noSigPayload.event_id],
    );
    assert(
      noSigDeliveries[0]?.count === 0,
      `No rows in webhook_deliveries for absent sig (got ${noSigDeliveries[0]?.count})`,
    );

    // ══════════════════════════════════════════════════════════════
    // Test 5: Same event_id with different payload → REJECTED, original preserved
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 5: Same event_id with different payload → REJECTED');
    const rejectedEventId = `${RUN_PREFIX}-rejected-001`;
    const originalPayload = {
      event_id: rejectedEventId,
      order_id: `${RUN_PREFIX}-order-rejected`,
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date().toISOString(),
      data: { amount: 999, currency: 'MXN' },
    };

    // First: create the event
    const firstResult = await sendWebhook(originalPayload);
    assert(firstResult.status === 202, `First delivery returns 202 (got ${firstResult.status})`);
    assert(firstResult.body?.result === 'CREATED', `First delivery result = CREATED (got ${firstResult.body?.result})`);

    // Second: send with different payload (different amount)
    const alteredPayload = {
      ...originalPayload,
      data: { amount: 1, currency: 'USD' },
    };
    const rejectedResult = await sendWebhook(alteredPayload);
    assert(rejectedResult.status === 202, `REJECTED delivery returns 202 (got ${rejectedResult.status})`);
    assert(rejectedResult.body?.result === 'REJECTED', `Altered payload result = REJECTED (got ${rejectedResult.body?.result})`);

    // Verify original payload is not modified
    const { rows: rejectedEvents } = await pool.query(
      'SELECT payload, payload_hash FROM webhook_events WHERE event_id = $1',
      [rejectedEventId],
    );
    const storedPayload = rejectedEvents[0]?.payload;
    const originalBodyStr = JSON.stringify(originalPayload);
    const originalHash = createHash('sha256').update(originalBodyStr).digest('hex');
    assert(
      rejectedEvents[0]?.payload_hash === originalHash,
      `Original payload_hash preserved after REJECTED delivery`,
    );
    assert(
      storedPayload?.amount === 999 || storedPayload?.data?.amount === 999,
      `Original payload data preserved (amount=999)`,
    );

    // ══════════════════════════════════════════════════════════════
    // Test 6: No orders created by this ingestion run
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 6: No orders created by this ingestion run');
    const { rows: orders } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders WHERE id LIKE $1`,
      [`${RUN_PREFIX}-%`],
    );
    assert(orders[0]?.count === 0, `No orders created by this run (got ${orders[0]?.count})`);

    // ══════════════════════════════════════════════════════════════
    // Test 7: Representative burst test
    // 1,000 deliveries: 800 unique + 200 exact duplicates, max 100 concurrent
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Test 7: Representative burst test (1,000 deliveries, 800 unique, 200 duplicates)');

    // Build 800 unique events
    const uniquePayloads: { payload: Record<string, unknown>; bodyStr: string }[] = [];
    for (let i = 0; i < 800; i++) {
      const p = {
        event_id: `${RUN_PREFIX}-burst-${String(i).padStart(4, '0')}`,
        order_id: `${RUN_PREFIX}-order-burst-${String(i).padStart(4, '0')}`,
        event_type: 'payment.authorized',
        sequence: 1,
        occurred_at: new Date().toISOString(),
        data: { amount: 100 + i, currency: 'MXN' },
      };
      uniquePayloads.push({ payload: p, bodyStr: JSON.stringify(p) });
    }

    // Pick 200 random duplicates from the 800 unique
    const duplicatePayloads: { payload: Record<string, unknown>; bodyStr: string }[] = [];
    for (let i = 0; i < 200; i++) {
      const idx = Math.floor(Math.random() * 800);
      duplicatePayloads.push(uniquePayloads[idx]!);
    }

    // Combine and shuffle
    const allPayloads = [...uniquePayloads, ...duplicatePayloads];
    for (let i = allPayloads.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allPayloads[i], allPayloads[j]] = [allPayloads[j]!, allPayloads[i]!];
    }

    // Build tasks
    const burstTasks = allPayloads.map((item) => {
      return () => sendWebhook(item.payload);
    });

    // Run with max 100 concurrency
    const burstResults = await runWithConcurrency(burstTasks, 100);

    const burstAll202 = burstResults.every((r) => r.status === 202);
    assert(burstAll202, `All 1,000 burst requests returned 202`);

    const burstLatencies = burstResults.map((r) => r.latency);
    const burstP95 = computeP95(burstLatencies);

    // ══════════════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════════════
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`  Hot-key p95: ${hotKeyP95.toFixed(2)} ms`);
    console.log(`  Representative burst p95: ${burstP95.toFixed(2)} ms`);
    console.log(`  SLA target: < 100 ms`);
    console.log(`${'═'.repeat(55)}\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
