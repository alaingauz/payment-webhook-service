/**
 * Verification script for worker processing (Phase 3).
 * Requires the API running on localhost:3000, PostgreSQL accessible, and workers running.
 *
 * Usage: tsx scripts/verify-worker.ts
 */

import { createHmac, createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const SECRET = process.env['WEBHOOK_SECRET'] ?? 'dev-webhook-secret-change-me';

const DB_CONFIG = {
  host: process.env['DB_HOST'] ?? 'localhost',
  port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
  user: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? 'postgres',
  database: process.env['DB_NAME'] ?? 'webhooks',
};

const RUN_PREFIX = `vw-${Date.now()}`;
let testsPassed = 0;
let testsFailed = 0;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

async function sendWebhook(
  payload: object,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const bodyStr = JSON.stringify(payload);
  const signature = sign(bodyStr);

  const res = await fetch(`${API_URL}/webhooks/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature': signature,
    },
    body: bodyStr,
  });

  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // ignore
  }

  return { status: res.status, body };
}

function makePayload(
  eventId: string,
  orderId: string,
  eventType: string,
  sequence: number,
  data: Record<string, unknown> = { amount: '1000.00', currency: 'MXN' },
) {
  return {
    event_id: eventId,
    order_id: orderId,
    event_type: eventType,
    sequence,
    occurred_at: new Date().toISOString(),
    data,
  };
}

async function pollUntil(
  pool: pg.Pool,
  eventId: string,
  targetStatuses: string[],
  timeoutMs = 10000,
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for event ${eventId} to reach ${targetStatuses.join('|')}`);
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ❌ ${message}`);
  }
}

async function testA(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Test A: Proyección directa y desorden');

  const orderId = `${RUN_PREFIX}-order-a`;
  const evtRefunded = `${RUN_PREFIX}-evt-a-refund`;
  const evtCaptured = `${RUN_PREFIX}-evt-a-capture`;

  // 1. Send payment.refunded with sequence=3
  const res1 = await sendWebhook(makePayload(evtRefunded, orderId, 'payment.refunded', 3));
  assert(res1.status === 202, `payment.refunded accepted (${res1.status})`);

  // 2. Wait until APPLIED
  const evtRow1 = await pollUntil(pool, evtRefunded, ['APPLIED']);
  assert(evtRow1['processing_status'] === 'APPLIED', `event ${evtRefunded} is APPLIED`);

  // 3. Check order
  const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = orderResult.rows[0];
  assert(order.status === 'refunded', `order status is refunded (got ${order.status})`);
  assert(order.last_sequence === 3, `order last_sequence is 3 (got ${order.last_sequence})`);

  // 4. Send payment.captured with sequence=2 (stale)
  const res2 = await sendWebhook(makePayload(evtCaptured, orderId, 'payment.captured', 2));
  assert(res2.status === 202, `payment.captured accepted (${res2.status})`);

  // 5. Wait until IGNORED
  const evtRow2 = await pollUntil(pool, evtCaptured, ['IGNORED']);
  assert(evtRow2['processing_status'] === 'IGNORED', `event ${evtCaptured} is IGNORED`);
  assert(evtRow2['outcome_reason'] === 'STALE_SEQUENCE', `outcome_reason is STALE_SEQUENCE`);

  // 6. Order should still be refunded/3
  const orderResult2 = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order2 = orderResult2.rows[0];
  assert(order2.status === 'refunded', `order still refunded (got ${order2.status})`);
  assert(order2.last_sequence === 3, `order still seq 3 (got ${order2.last_sequence})`);

  // 7. Both events have history
  const histResult = await pool.query(
    'SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY id',
    [orderId],
  );
  assert(histResult.rows.length === 2, `two history entries (got ${histResult.rows.length})`);
}

async function testB(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Test B: Flujo normal');

  const orderId = `${RUN_PREFIX}-order-b`;
  const evtAuth = `${RUN_PREFIX}-evt-b-auth`;
  const evtCapture = `${RUN_PREFIX}-evt-b-capture`;

  // 1. Send payment.authorized sequence=1
  await sendWebhook(makePayload(evtAuth, orderId, 'payment.authorized', 1));
  await pollUntil(pool, evtAuth, ['APPLIED']);

  // 2. Send payment.captured sequence=2
  await sendWebhook(makePayload(evtCapture, orderId, 'payment.captured', 2));
  await pollUntil(pool, evtCapture, ['APPLIED']);

  // 3. Check order
  const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = orderResult.rows[0];
  assert(order.status === 'captured', `order status is captured (got ${order.status})`);
  assert(order.last_sequence === 2, `order last_sequence is 2 (got ${order.last_sequence})`);
}

async function testC(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Test C: Duplicado después del procesamiento');

  const orderId = `${RUN_PREFIX}-order-c`;
  const evtId = `${RUN_PREFIX}-evt-c`;

  const payload = makePayload(evtId, orderId, 'payment.authorized', 1);

  // 1. Send original
  await sendWebhook(payload);
  await pollUntil(pool, evtId, ['APPLIED']);

  // 2. Send duplicate
  const res = await sendWebhook(payload);
  assert(res.status === 202, `duplicate returns 202 (got ${res.status})`);
  assert(
    res.body?.['result'] === 'DUPLICATE',
    `duplicate response indicates DUPLICATE (got ${res.body?.['result']})`,
  );

  // 3. delivery_count incremented
  const evtResult = await pool.query(
    'SELECT * FROM webhook_events WHERE event_id = $1',
    [evtId],
  );
  assert(
    evtResult.rows[0].delivery_count === 2,
    `delivery_count is 2 (got ${evtResult.rows[0].delivery_count})`,
  );

  // 4. Only one history entry
  const histResult = await pool.query(
    'SELECT * FROM order_status_history WHERE event_id = $1',
    [evtId],
  );
  assert(histResult.rows.length === 1, `one history entry (got ${histResult.rows.length})`);

  // 5. Order not modified again
  const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  assert(orderResult.rows[0].status === 'authorized', `order still authorized`);
}

async function testD(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Test D: Concurrencia');

  const numOrders = 5;
  const eventIds: string[] = [];

  for (let i = 0; i < numOrders; i++) {
    const orderId = `${RUN_PREFIX}-order-d-${i}`;
    const evtId = `${RUN_PREFIX}-evt-d-${i}`;
    eventIds.push(evtId);

    await sendWebhook(makePayload(evtId, orderId, 'payment.authorized', 1));
  }

  // Wait for all events to be processed
  for (const evtId of eventIds) {
    await pollUntil(pool, evtId, ['APPLIED', 'IGNORED']);
  }

  // Check: one history entry per event_id
  for (const evtId of eventIds) {
    const histResult = await pool.query(
      'SELECT * FROM order_status_history WHERE event_id = $1',
      [evtId],
    );
    assert(histResult.rows.length === 1, `event ${evtId}: one history entry`);
  }

  // Check: no PENDING events from this run
  const pendingResult = await pool.query(
    `SELECT COUNT(*) as cnt FROM webhook_events
     WHERE event_id LIKE $1 AND processing_status = 'PENDING'`,
    [`${RUN_PREFIX}-evt-d-%`],
  );
  assert(
    parseInt(pendingResult.rows[0].cnt, 10) === 0,
    `no pending events from this run`,
  );
}

async function testE(pool: pg.Pool): Promise<void> {
  console.log('\n📋 Test E: GET /orders/:id');

  // Use order from test A
  const orderId = `${RUN_PREFIX}-order-a`;

  const res = await fetch(`${API_URL}/orders/${orderId}`);
  assert(res.status === 200, `GET /orders/${orderId} returns 200`);

  const body = (await res.json()) as Record<string, unknown>;
  assert(body['id'] === orderId, `response id matches`);
  assert(body['status'] === 'refunded', `response status is refunded`);
  assert(body['last_sequence'] === 3, `response last_sequence is 3`);

  const history = body['history'] as Record<string, unknown[]>;
  assert(Array.isArray(history['events']), `history.events is array`);
  assert(Array.isArray(history['status_changes']), `history.status_changes is array`);
  assert(history['events'].length >= 2, `at least 2 events`);
  assert(history['status_changes'].length >= 2, `at least 2 status_changes`);

  // Check STALE_SEQUENCE visible
  const ignoredChange = (history['status_changes'] as Record<string, unknown>[]).find(
    (sc) => sc['outcome'] === 'IGNORED',
  );
  assert(ignoredChange != null, `IGNORED status change exists`);
  assert(
    ignoredChange?.['outcome_reason'] === 'STALE_SEQUENCE',
    `STALE_SEQUENCE visible in history`,
  );

  // Check non-existent order
  const res404 = await fetch(`${API_URL}/orders/non-existent-${RUN_PREFIX}`);
  assert(res404.status === 404, `non-existent order returns 404`);

  // Verify against DB
  const dbOrder = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  assert(body['status'] === dbOrder.rows[0].status, `API status matches DB`);
  assert(body['last_sequence'] === dbOrder.rows[0].last_sequence, `API last_sequence matches DB`);
}

async function main(): Promise<void> {
  console.log(`🔧 Worker verification script (prefix: ${RUN_PREFIX})`);
  console.log(`   API: ${API_URL}`);
  console.log(`   DB: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);

  const pool = new pg.Pool(DB_CONFIG);

  try {
    // Health check
    const healthRes = await fetch(`${API_URL}/health`);
    if (healthRes.status !== 200) {
      throw new Error(`API health check failed: ${healthRes.status}`);
    }
    console.log('✅ API health check passed');

    await testA(pool);
    await testB(pool);
    await testC(pool);
    await testD(pool);
    await testE(pool);

    console.log(`\n📊 Results: ${testsPassed} passed, ${testsFailed} failed`);

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
