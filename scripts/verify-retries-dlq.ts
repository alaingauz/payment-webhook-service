/**
 * Verification script for retries, DLQ, and replay (Phase 4).
 * Requires: API running on localhost:3000, PostgreSQL accessible, workers running.
 *
 * Usage: tsx scripts/verify-retries-dlq.ts
 */

import pg from 'pg';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

const DB_CONFIG = {
  host: process.env['DB_HOST'] ?? 'localhost',
  port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
  user: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? 'postgres',
  database: process.env['DB_NAME'] ?? 'webhooks',
};

const RUN_PREFIX = `vr-${Date.now()}`;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ❌ ${message}`);
  }
}

async function pollUntil(
  pool: pg.Pool,
  eventId: string,
  targetStatuses: string[],
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query(
      `SELECT * FROM webhook_events WHERE event_id = $1`,
      [eventId],
    );
    if (result.rows.length > 0 && targetStatuses.includes(result.rows[0].processing_status)) {
      return result.rows[0] as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for event ${eventId} to reach ${targetStatuses.join('|')}`);
}

async function pollById(
  pool: pg.Pool,
  id: string,
  targetStatuses: string[],
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pool.query(
      `SELECT * FROM webhook_events WHERE id = $1`,
      [id],
    );
    if (result.rows.length > 0 && targetStatuses.includes(result.rows[0].processing_status)) {
      return result.rows[0] as Record<string, unknown>;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for event id=${id} to reach ${targetStatuses.join('|')}`);
}

// Read WORKER_MAX_ATTEMPTS from env or default
const MAX_ATTEMPTS = parseInt(process.env['WORKER_MAX_ATTEMPTS'] ?? '5', 10);

async function scenarioA(pool: pg.Pool): Promise<string> {
  console.log('\n📋 Scenario A: DLQ after max attempts');

  const eventId = `${RUN_PREFIX}-evt-dlq`;
  const orderId = `${RUN_PREFIX}-order-dlq`;

  // Insert event directly with attempt_count = MAX_ATTEMPTS - 1
  // Use an amount too large for NUMERIC(12,2) to cause a controlled error
  const insertResult = await pool.query(
    `INSERT INTO webhook_events
       (event_id, order_id, event_type, sequence, occurred_at, payload, payload_hash,
        processing_status, attempt_count, correlation_id)
     VALUES ($1, $2, $3, $4, clock_timestamp(), $5, $6, 'PENDING', $7, $8)
     RETURNING id::text AS id`,
    [
      eventId,
      orderId,
      'payment.captured',
      1,
      JSON.stringify({
        event_id: eventId,
        order_id: orderId,
        event_type: 'payment.captured',
        sequence: 1,
        occurred_at: new Date().toISOString(),
        data: { amount: 99999999999999.99, currency: 'MXN' },
      }),
      'verify-hash-dlq',
      MAX_ATTEMPTS - 1,
      `${RUN_PREFIX}-corr-dlq`,
    ],
  );

  const internalId = insertResult.rows[0].id;
  console.log(`  Inserted event id=${internalId} event_id=${eventId} attempt_count=${MAX_ATTEMPTS - 1}`);

  // Wait for worker to pick it up and move to DLQ
  const row = await pollUntil(pool, eventId, ['DLQ'], 20000);

  assert(
    (row['attempt_count'] as number) === MAX_ATTEMPTS,
    `attempt_count = ${MAX_ATTEMPTS} (got ${row['attempt_count']})`,
  );
  assert(
    row['outcome_reason'] === 'MAX_ATTEMPTS_EXHAUSTED',
    `outcome_reason = MAX_ATTEMPTS_EXHAUSTED (got ${row['outcome_reason']})`,
  );
  assert(
    row['last_error'] != null && (row['last_error'] as string).length > 0,
    `last_error is informed (got: ${(row['last_error'] as string)?.substring(0, 80)})`,
  );
  assert(
    row['next_attempt_at'] === null || row['next_attempt_at'] === undefined,
    `next_attempt_at is NULL`,
  );

  // No order_status_history for this event
  const histResult = await pool.query(
    `SELECT * FROM order_status_history WHERE event_id = $1`,
    [eventId],
  );
  assert(histResult.rows.length === 0, `no order_status_history for DLQ event`);

  // No partial effect on order — orderId uses a unique RUN_PREFIX, so any existence is a real partial effect
  const orderResult = await pool.query(
    `SELECT * FROM orders WHERE id = $1`,
    [orderId],
  );
  assert(orderResult.rows.length === 0, `no partial order created`);

  return internalId;
}

async function scenarioB(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Scenario B: DLQ listing');

  const res = await fetch(`${API_URL}/admin/dlq`);
  assert(res.status === 200, `GET /admin/dlq returns 200 (got ${res.status})`);

  const body = (await res.json()) as Record<string, unknown>;
  const items = body['items'] as Record<string, unknown>[];

  assert(Array.isArray(items), `items is array`);
  assert(typeof body['total'] === 'number', `total is number`);
  assert(body['limit'] === 50, `default limit is 50`);
  assert(body['offset'] === 0, `default offset is 0`);

  // Find our event
  const ourEvent = items.find(
    (item) => (item['event_id'] as string)?.startsWith(RUN_PREFIX),
  );
  assert(ourEvent != null, `DLQ event from this run is listed`);

  if (ourEvent) {
    assert(typeof ourEvent['id'] === 'string', `id is string (got type: ${typeof ourEvent['id']})`);
    assert(ourEvent['processing_status'] === 'DLQ', `processing_status is DLQ`);
    assert(!('payload' in ourEvent), `payload not exposed`);
    assert(!('WEBHOOK_SECRET' in ourEvent), `WEBHOOK_SECRET not exposed`);
    assert(!('payload_hash' in ourEvent), `payload_hash not exposed`);
  }
}

async function scenarioC(pool: pg.Pool, internalId: string): Promise<void> {
  console.log('\n📋 Scenario C: Replay');

  // 1. Replay
  const res1 = await fetch(`${API_URL}/admin/dlq/${internalId}/replay`, { method: 'POST' });
  assert(res1.status === 202, `POST replay returns 202 (got ${res1.status})`);

  const body1 = (await res1.json()) as Record<string, unknown>;
  assert(body1['result'] === 'REPLAYED', `result is REPLAYED`);
  assert(body1['replay_count'] === 1, `replay_count is 1 (got ${body1['replay_count']})`);
  assert(body1['processing_status'] === 'PENDING', `processing_status is PENDING`);

  // 2. Immediate second replay — should be NOT_IN_DLQ (event is now PENDING)
  const res2 = await fetch(`${API_URL}/admin/dlq/${internalId}/replay`, { method: 'POST' });
  assert(res2.status === 200, `second replay returns 200 (got ${res2.status})`);

  const body2 = (await res2.json()) as Record<string, unknown>;
  assert(body2['result'] === 'NOT_IN_DLQ', `second replay result is NOT_IN_DLQ`);

  // 3. Check that replay_count was not incremented again
  const eventResult = await pool.query(
    `SELECT replay_count FROM webhook_events WHERE id = $1`,
    [internalId],
  );
  assert(
    eventResult.rows[0].replay_count === 1,
    `replay_count still 1 after second replay (got ${eventResult.rows[0].replay_count})`,
  );

  // 4. Verify the endpoint did not create history or modify orders
  const eventRow = await pool.query(
    `SELECT event_id FROM webhook_events WHERE id = $1`,
    [internalId],
  );
  const eventId = eventRow.rows[0].event_id;
  const histResult = await pool.query(
    `SELECT * FROM order_status_history WHERE event_id = $1`,
    [eventId],
  );
  assert(
    histResult.rows.length === 0,
    `replay endpoint did not create history (count: ${histResult.rows.length})`,
  );
}

async function scenarioD(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Scenario D: Retry scheduled');

  const eventId = `${RUN_PREFIX}-evt-retry`;
  const orderId = `${RUN_PREFIX}-order-retry`;

  // Insert event with attempt_count=0 and an oversized amount
  await pool.query(
    `INSERT INTO webhook_events
       (event_id, order_id, event_type, sequence, occurred_at, payload, payload_hash,
        processing_status, attempt_count, correlation_id)
     VALUES ($1, $2, $3, $4, clock_timestamp(), $5, $6, 'PENDING', 0, $7)`,
    [
      eventId,
      orderId,
      'payment.captured',
      1,
      JSON.stringify({
        event_id: eventId,
        order_id: orderId,
        event_type: 'payment.captured',
        sequence: 1,
        occurred_at: new Date().toISOString(),
        data: { amount: 99999999999999.99, currency: 'MXN' },
      }),
      'verify-hash-retry',
      `${RUN_PREFIX}-corr-retry`,
    ],
  );

  console.log(`  Inserted event event_id=${eventId} attempt_count=0`);

  // Wait for worker to attempt — poll until we see evidence of a real retry
  // Valid evidence: RETRY_SCHEDULED with next_attempt_at, OR attempt_count >= 2
  // (reaching attempt_count >= 2 proves the first retry was scheduled and reclaimed)
  const timeout = 20000;
  const start = Date.now();
  let retryEvidenceFound = false;
  let lastRow: Record<string, unknown> | null = null;

  while (Date.now() - start < timeout) {
    const result = await pool.query(
      `SELECT * FROM webhook_events WHERE event_id = $1`,
      [eventId],
    );
    if (result.rows.length > 0) {
      lastRow = result.rows[0] as Record<string, unknown>;
      const status = lastRow['processing_status'] as string;
      const attemptCount = lastRow['attempt_count'] as number;
      const nextAttemptAt = lastRow['next_attempt_at'];

      // Evidence 1: currently RETRY_SCHEDULED with next_attempt_at set
      if (status === 'RETRY_SCHEDULED' && nextAttemptAt != null) {
        retryEvidenceFound = true;
        break;
      }
      // Evidence 2: attempt_count >= 2 means first retry was scheduled AND reclaimed
      if (attemptCount >= 2) {
        retryEvidenceFound = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  assert(lastRow != null, `event exists in database`);

  if (lastRow) {
    const attemptCount = lastRow['attempt_count'] as number;
    const lastError = lastRow['last_error'] as string | null;
    const status = lastRow['processing_status'] as string;

    assert(
      retryEvidenceFound,
      `retry evidence found: RETRY_SCHEDULED with next_attempt_at OR attempt_count >= 2 ` +
      `(got attempt_count=${attemptCount}, status=${status})`,
    );
    assert(
      lastError != null && lastError.length > 0,
      `last_error is informed`,
    );

    // No partial effect
    const histResult = await pool.query(
      `SELECT * FROM order_status_history WHERE event_id = $1`,
      [eventId],
    );
    assert(
      histResult.rows.length === 0,
      `no partial order_status_history (count: ${histResult.rows.length})`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`🔧 Retries/DLQ verification script (prefix: ${RUN_PREFIX})`);
  console.log(`   API: ${API_URL}`);
  console.log(`   DB: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  console.log(`   MAX_ATTEMPTS: ${MAX_ATTEMPTS}`);

  const pool = new pg.Pool(DB_CONFIG);

  try {
    // Health check
    const healthRes = await fetch(`${API_URL}/health`);
    if (healthRes.status !== 200) {
      throw new Error(`API health check failed: ${healthRes.status}`);
    }
    console.log('✅ API health check passed');

    const internalId = await scenarioA(pool);
    await scenarioB(pool);
    await scenarioC(pool, internalId);
    await scenarioD(pool);

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`  Results: ${testsPassed} passed, ${testsFailed} failed`);
    console.log(`${'═'.repeat(55)}\n`);

    if (testsFailed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('\n💥 Fatal error:', (err as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
