/**
 * Verification script for observability (Phase 6).
 * Requires the API + workers running on localhost:3000 and PostgreSQL accessible.
 *
 * Usage: tsx scripts/verify-observability.ts
 */

import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const SECRET = process.env['WEBHOOK_SECRET'] ?? 'dev-webhook-secret-change-me';
const RUN_PREFIX = `vo-${Date.now()}`;

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
  correlationId?: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Signature': sign(bodyStr),
  };
  if (correlationId) {
    headers['X-Correlation-Id'] = correlationId;
  }

  const res = await fetch(`${API_URL}/webhooks/payments`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });
  const resBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: resBody };
}

async function fetchMetrics(): Promise<string> {
  const res = await fetch(`${API_URL}/metrics`);
  if (res.status !== 200) throw new Error(`GET /metrics returned ${res.status}`);
  return res.text();
}

function parseMetric(text: string, name: string): number {
  const regex = new RegExp(`^${name}\\s+(\\S+)`, 'm');
  const match = text.match(regex);
  if (!match) throw new Error(`Metric ${name} not found in output`);
  return Number(match[1]);
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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const pool = new pg.Pool(DB_CONFIG);
  let dlqCleanupId: string | null = null;

  try {
    console.log(`🔧 Observability verification script (prefix: ${RUN_PREFIX})`);
    console.log(`   API: ${API_URL}\n`);

    // ══════════════════════════════════════════════════════════════
    // Step 1: Fetch initial metrics
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 1: Fetch initial metrics');
    const initialMetrics = await fetchMetrics();
    const initialReceived = parseMetric(initialMetrics, 'webhook_events_received_total');
    const initialDuplicates = parseMetric(initialMetrics, 'webhook_duplicate_events_total');
    const initialOutOfOrder = parseMetric(initialMetrics, 'webhook_out_of_order_events_total');
    const initialDlq = parseMetric(initialMetrics, 'webhook_dlq_size');
    console.log(`   Initial received=${initialReceived} duplicates=${initialDuplicates} out_of_order=${initialOutOfOrder} dlq=${initialDlq}`);
    assert(true, 'Initial metrics fetched successfully');

    // ══════════════════════════════════════════════════════════════
    // Step 2: Send valid event with unique IDs and correlation_id
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 2: Send valid event');
    const correlationId = randomUUID();
    const eventId1 = `${RUN_PREFIX}-evt-001`;
    const orderId1 = `${RUN_PREFIX}-order-001`;
    const payload1 = {
      event_id: eventId1,
      order_id: orderId1,
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date().toISOString(),
      data: { amount: '100.00', currency: 'MXN' },
    };
    const res1 = await sendWebhook(payload1, correlationId);
    assert(res1.status === 202, `Valid event returns 202 (got ${res1.status})`);
    assert(res1.body?.result === 'CREATED', `Result is CREATED (got ${res1.body?.result})`);

    // ══════════════════════════════════════════════════════════════
    // Step 3: Send duplicate event
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 3: Send duplicate event');
    const res2 = await sendWebhook(payload1, correlationId);
    assert(res2.status === 202, `Duplicate returns 202 (got ${res2.status})`);
    assert(res2.body?.result === 'DUPLICATE', `Result is DUPLICATE (got ${res2.body?.result})`);

    // ══════════════════════════════════════════════════════════════
    // Step 4: Send out-of-order event (lower sequence) and wait for worker
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 4: Send out-of-order event');
    const eventId2 = `${RUN_PREFIX}-evt-002`;
    const payload2 = {
      event_id: eventId2,
      order_id: orderId1,
      event_type: 'payment.pending',
      sequence: 0,
      occurred_at: new Date().toISOString(),
      data: { amount: '100.00', currency: 'MXN' },
    };
    const res3 = await sendWebhook(payload2, correlationId);
    assert(res3.status === 202, `Out-of-order event returns 202 (got ${res3.status})`);

    // Wait for worker to process both events
    console.log('   Waiting for worker to process events...');
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS pending FROM webhook_events
         WHERE event_id IN ($1, $2) AND processing_status IN ('PENDING', 'RETRY_SCHEDULED')`,
        [eventId1, eventId2],
      );
      if (rows[0]?.pending === 0) break;
    }

    // Check that out-of-order event was marked STALE_SEQUENCE
    const { rows: oooRows } = await pool.query(
      `SELECT processing_status, outcome_reason FROM webhook_events WHERE event_id = $1`,
      [eventId2],
    );
    assert(
      oooRows[0]?.outcome_reason === 'STALE_SEQUENCE',
      `Out-of-order marked STALE_SEQUENCE (got ${oooRows[0]?.outcome_reason})`,
    );

    // ══════════════════════════════════════════════════════════════
    // Step 5: Verify relative metric increments
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 5: Verify metric increments');
    const afterMetrics = await fetchMetrics();
    const afterReceived = parseMetric(afterMetrics, 'webhook_events_received_total');
    const afterDuplicates = parseMetric(afterMetrics, 'webhook_duplicate_events_total');
    const afterOutOfOrder = parseMetric(afterMetrics, 'webhook_out_of_order_events_total');

    const receivedDelta = afterReceived - initialReceived;
    const duplicateDelta = afterDuplicates - initialDuplicates;
    const outOfOrderDelta = afterOutOfOrder - initialOutOfOrder;

    assert(receivedDelta >= 3, `events_received increased by >= 3 (delta=${receivedDelta})`);
    assert(duplicateDelta >= 1, `duplicate_events increased by >= 1 (delta=${duplicateDelta})`);
    assert(outOfOrderDelta >= 1, `out_of_order_events increased by >= 1 (delta=${outOfOrderDelta})`);

    // ══════════════════════════════════════════════════════════════
    // Step 6: Insert temporary DLQ event, verify dlq_size increases
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 6: DLQ size metric');
    const dlqEventId = `${RUN_PREFIX}-dlq-temp`;
    await pool.query(
      `INSERT INTO webhook_events
        (event_id, order_id, event_type, sequence, occurred_at, payload, payload_hash,
         processing_status, outcome_reason, attempt_count, correlation_id, processed_at)
       VALUES ($1, $2, 'payment.failed', 0, now(), '{}', 'temp', 'DLQ', 'MAX_ATTEMPTS_EXHAUSTED', 5, $3, now())`,
      [dlqEventId, `${RUN_PREFIX}-order-dlq`, correlationId],
    );
    dlqCleanupId = dlqEventId;

    const dlqMetrics = await fetchMetrics();
    const dlqAfter = parseMetric(dlqMetrics, 'webhook_dlq_size');
    assert(dlqAfter === initialDlq + 1, `dlq_size increased by 1 (was=${initialDlq} now=${dlqAfter})`);

    // ══════════════════════════════════════════════════════════════
    // Step 7: Remove temporary DLQ event, verify dlq_size returns
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 7: DLQ size returns after cleanup');
    await pool.query(`DELETE FROM webhook_events WHERE event_id = $1`, [dlqEventId]);
    dlqCleanupId = null;

    const afterCleanupMetrics = await fetchMetrics();
    const dlqAfterCleanup = parseMetric(afterCleanupMetrics, 'webhook_dlq_size');
    assert(dlqAfterCleanup === initialDlq, `dlq_size returned to initial (was=${initialDlq} now=${dlqAfterCleanup})`);

    // ══════════════════════════════════════════════════════════════
    // Step 8: Verify both p95 are finite non-negative numbers
    // ══════════════════════════════════════════════════════════════
    console.log('\n📋 Step 8: p95 latency metrics');
    const ingestP95 = parseMetric(afterMetrics, 'webhook_ingest_latency_p95_ms');
    const processingP95 = parseMetric(afterMetrics, 'webhook_processing_latency_p95_ms');

    assert(Number.isFinite(ingestP95) && ingestP95 >= 0, `ingest_latency_p95_ms is finite and non-negative (${ingestP95})`);
    assert(Number.isFinite(processingP95) && processingP95 >= 0, `processing_latency_p95_ms is finite and non-negative (${processingP95})`);

    // ══════════════════════════════════════════════════════════════
    // Step 9: Print correlation_id for log search
    // ══════════════════════════════════════════════════════════════
    console.log(`\n📋 Step 9: Correlation ID for log search`);
    console.log(`   🔍 Search for correlation_id: ${correlationId}`);
    console.log(`   Run: docker compose logs api worker | grep ${correlationId}`);

    // ══════════════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════════════
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`  correlation_id: ${correlationId}`);
    console.log(`${'═'.repeat(55)}\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    // Step 10: Clean up only our RUN_PREFIX data
    if (dlqCleanupId) {
      await pool.query(`DELETE FROM webhook_events WHERE event_id = $1`, [dlqCleanupId]).catch(() => {});
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
