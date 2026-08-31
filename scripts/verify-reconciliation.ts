/**
 * Verification script for reconciliation (Phase 5).
 * Requires: API running on localhost:3000, PostgreSQL accessible, provider-simulator data dir.
 *
 * Usage: tsx scripts/verify-reconciliation.ts
 */

import pg from 'pg';
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const DATA_DIR = join(__dirname, '..', 'provider-simulator', 'data');
const PROVIDER_ORDERS_PATH = join(DATA_DIR, 'provider-orders.json');

const DB_CONFIG = {
  host: process.env['DB_HOST'] ?? 'localhost',
  port: parseInt(process.env['DB_PORT'] ?? '5432', 10),
  user: process.env['DB_USER'] ?? 'postgres',
  password: process.env['DB_PASSWORD'] ?? 'postgres',
  database: process.env['DB_NAME'] ?? 'webhooks',
};

const RUN_PREFIX = `recon-${Date.now()}`;
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

async function httpPost(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'POST' });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

function atomicWriteSync(filePath: string, content: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

async function main() {
  const pool = new pg.Pool(DB_CONFIG);

  // Create data/ recursively if it doesn't exist
  mkdirSync(DATA_DIR, { recursive: true });

  // Save existing provider-orders.json
  let previousContent: string | null = null;
  let fileExistedBefore = false;
  if (existsSync(PROVIDER_ORDERS_PATH)) {
    previousContent = readFileSync(PROVIDER_ORDERS_PATH, 'utf-8');
    fileExistedBefore = true;
  }

  let failed = false;

  try {
    console.log('═══════════════════════════════════════');
    console.log('  RECONCILIATION VERIFICATION');
    console.log('═══════════════════════════════════════\n');

    // Prepare unique IDs per execution
    const orderId1 = `${RUN_PREFIX}-missing`;     // Case 1: non-existent locally
    const orderId2 = `${RUN_PREFIX}-divergent`;    // Case 2: divergent (local seq < provider seq)
    const orderId3 = `${RUN_PREFIX}-identical`;    // Case 3: identical
    const orderId4 = `${RUN_PREFIX}-stale`;        // Case 4: local seq > provider seq

    // Setup local orders for cases 2, 3, 4
    console.log('Setting up local orders...');

    // Case 2: divergent order (local: authorized seq=2 amount=50.00, provider will have captured seq=3 amount=100.00)
    await pool.query(
      `INSERT INTO orders (id, status, last_sequence, amount, currency)
       VALUES ($1, 'authorized', 2, '50.00', 'MXN')
       ON CONFLICT (id) DO NOTHING`,
      [orderId2],
    );

    // Case 3: identical order (local matches provider exactly)
    await pool.query(
      `INSERT INTO orders (id, status, last_sequence, amount, currency)
       VALUES ($1, 'captured', 3, '200.00', 'USD')
       ON CONFLICT (id) DO NOTHING`,
      [orderId3],
    );

    // Case 4: local has higher sequence than provider
    await pool.query(
      `INSERT INTO orders (id, status, last_sequence, amount, currency)
       VALUES ($1, 'refunded', 5, '300.00', 'EUR')
       ON CONFLICT (id) DO NOTHING`,
      [orderId4],
    );

    // Write provider-orders.json with our test data
    const providerOrders = {
      generated_at: new Date().toISOString(),
      orders: [
        { id: orderId1, status: 'captured', sequence: 3, amount: '150.00', currency: 'MXN', updated_at: new Date().toISOString() },
        { id: orderId2, status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN', updated_at: new Date().toISOString() },
        { id: orderId3, status: 'captured', sequence: 3, amount: '200.00', currency: 'USD', updated_at: new Date().toISOString() },
        { id: orderId4, status: 'authorized', sequence: 2, amount: '300.00', currency: 'EUR', updated_at: new Date().toISOString() },
      ],
    };

    atomicWriteSync(PROVIDER_ORDERS_PATH, JSON.stringify(providerOrders, null, 2));
    console.log('Provider orders written.\n');

    // ── First reconciliation ──────────────────────────────────
    console.log('── First Reconciliation ──');
    const res1 = await httpPost(`${API_URL}/admin/reconcile`);
    assert(res1.status === 200, `POST /admin/reconcile returned ${res1.status} (expected 200)`);

    const body1 = res1.body;
    assert(body1['status'] === 'COMPLETED', `status = ${body1['status']}`);
    assert(body1['orders_checked'] === 4, `orders_checked = ${body1['orders_checked']} (expected 4)`);
    assert(body1['divergences'] === 3, `divergences = ${body1['divergences']} (expected 3)`);
    assert(body1['repaired'] === 2, `repaired = ${body1['repaired']} (expected 2)`);
    assert(body1['already_ok'] === 1, `already_ok = ${body1['already_ok']} (expected 1)`);
    assert(
      body1['stale_provider_snapshots'] === 1,
      `stale_provider_snapshots = ${body1['stale_provider_snapshots']} (expected 1)`,
    );

    // Verify exact distribution of actions
    const details1 = body1['details'] as Array<Record<string, unknown>>;
    if (details1) {
      const actions1 = details1.map((d) => d['action']);
      assert(
        actions1.filter((a) => a === 'REPAIRED').length === 2,
        `REPAIRED count in details = ${actions1.filter((a) => a === 'REPAIRED').length} (expected 2)`,
      );
      assert(
        actions1.filter((a) => a === 'ALREADY_OK').length === 1,
        `ALREADY_OK count in details = ${actions1.filter((a) => a === 'ALREADY_OK').length} (expected 1)`,
      );
      assert(
        actions1.filter((a) => a === 'STALE_PROVIDER_SNAPSHOT').length === 1,
        `STALE_PROVIDER_SNAPSHOT count in details = ${actions1.filter((a) => a === 'STALE_PROVIDER_SNAPSHOT').length} (expected 1)`,
      );
    }

    // Verify repaired orders in DB — amounts and currencies
    const order1 = await pool.query(`SELECT status, last_sequence, amount::text, currency FROM orders WHERE id = $1`, [orderId1]);
    assert(order1.rows.length === 1, `Order ${orderId1} exists`);
    if (order1.rows.length > 0) {
      const o = order1.rows[0]!;
      assert(o.status === 'captured', `${orderId1} status = ${o.status} (expected captured)`);
      assert(o.last_sequence === 3, `${orderId1} last_sequence = ${o.last_sequence} (expected 3)`);
      assert(o.amount === '150.00', `${orderId1} amount = ${o.amount} (expected 150.00)`);
      assert(o.currency === 'MXN', `${orderId1} currency = ${o.currency} (expected MXN)`);
    }

    const order2 = await pool.query(`SELECT status, last_sequence, amount::text, currency FROM orders WHERE id = $1`, [orderId2]);
    if (order2.rows.length > 0) {
      assert(order2.rows[0]!.status === 'captured', `${orderId2} status = ${order2.rows[0]!.status} (expected captured)`);
      assert(order2.rows[0]!.last_sequence === 3, `${orderId2} last_sequence = ${order2.rows[0]!.last_sequence} (expected 3)`);
      assert(order2.rows[0]!.amount === '100.00', `${orderId2} amount = ${order2.rows[0]!.amount} (expected 100.00)`);
      assert(order2.rows[0]!.currency === 'MXN', `${orderId2} currency = ${order2.rows[0]!.currency} (expected MXN)`);
    }

    // Verify order 4 was NOT modified (stale provider snapshot)
    const order4 = await pool.query(`SELECT status, last_sequence FROM orders WHERE id = $1`, [orderId4]);
    if (order4.rows.length > 0) {
      assert(order4.rows[0]!.status === 'refunded', `${orderId4} status unchanged = ${order4.rows[0]!.status}`);
      assert(order4.rows[0]!.last_sequence === 5, `${orderId4} last_sequence unchanged = ${order4.rows[0]!.last_sequence}`);
    }

    // Verify exactly 2 RECONCILIATION history entries
    const historyCount = await pool.query(
      `SELECT count(*)::int as cnt FROM order_status_history
       WHERE order_id = ANY($1) AND source = 'RECONCILIATION'`,
      [[orderId1, orderId2, orderId3, orderId4]],
    );
    assert(
      historyCount.rows[0]!.cnt === 2,
      `RECONCILIATION history entries = ${historyCount.rows[0]!.cnt} (expected 2)`,
    );

    // Verify reconciliation_runs
    const run1Id = body1['run_id'];
    const runResult = await pool.query(
      `SELECT status, orders_checked, divergences, repaired FROM reconciliation_runs WHERE id = $1`,
      [run1Id],
    );
    assert(runResult.rows.length === 1, `reconciliation_run ${run1Id} exists`);
    if (runResult.rows.length > 0) {
      assert(runResult.rows[0]!.status === 'COMPLETED', `run status = ${runResult.rows[0]!.status}`);
    }

    // Verify reconciliation_details
    const detailsResult = await pool.query(
      `SELECT order_id, action FROM reconciliation_details WHERE run_id = $1 ORDER BY order_id`,
      [run1Id],
    );
    assert(detailsResult.rows.length === 4, `reconciliation_details count = ${detailsResult.rows.length} (expected 4)`);

    // Save updated_at for later comparison
    const updatedAts1 = new Map<string, string>();
    for (const oid of [orderId1, orderId2, orderId3, orderId4]) {
      const r = await pool.query(`SELECT updated_at FROM orders WHERE id = $1`, [oid]);
      if (r.rows.length > 0) updatedAts1.set(oid, String(r.rows[0]!.updated_at));
    }

    console.log('');

    // ── Second reconciliation ─────────────────────────────────
    console.log('── Second Reconciliation ──');
    const res2 = await httpPost(`${API_URL}/admin/reconcile`);
    assert(res2.status === 200, `Second POST returned ${res2.status} (expected 200)`);

    const body2 = res2.body;
    assert(body2['repaired'] === 0, `second repaired = ${body2['repaired']} (expected 0)`);
    assert(body2['already_ok'] === 3, `second already_ok = ${body2['already_ok']} (expected 3)`);
    assert(
      body2['stale_provider_snapshots'] === 1,
      `second stale_provider_snapshots = ${body2['stale_provider_snapshots']} (expected 1)`,
    );

    // Verify no new RECONCILIATION history entries
    const historyCount2 = await pool.query(
      `SELECT count(*)::int as cnt FROM order_status_history
       WHERE order_id = ANY($1) AND source = 'RECONCILIATION'`,
      [[orderId1, orderId2, orderId3, orderId4]],
    );
    assert(
      historyCount2.rows[0]!.cnt === 2,
      `After second run, RECONCILIATION history entries still = ${historyCount2.rows[0]!.cnt} (expected 2)`,
    );

    // Verify updated_at of orders has NOT changed
    for (const oid of [orderId1, orderId2, orderId3, orderId4]) {
      const r = await pool.query(`SELECT updated_at FROM orders WHERE id = $1`, [oid]);
      if (r.rows.length > 0) {
        assert(
          String(r.rows[0]!.updated_at) === updatedAts1.get(oid),
          `${oid} updated_at unchanged after second reconciliation`,
        );
      }
    }

    // Verify orders unchanged after second reconciliation
    const order1After = await pool.query(`SELECT status, last_sequence FROM orders WHERE id = $1`, [orderId1]);
    if (order1After.rows.length > 0) {
      assert(order1After.rows[0]!.status === 'captured', `${orderId1} still captured after second run`);
    }

    // Second run created its own run and details
    const run2Id = body2['run_id'];
    const run2Details = await pool.query(
      `SELECT count(*)::int as cnt FROM reconciliation_details WHERE run_id = $1`,
      [run2Id],
    );
    assert(run2Details.rows[0]!.cnt === 4, `Second run has ${run2Details.rows[0]!.cnt} details (expected 4)`);

    console.log('');

    // ── Concurrent reconciliation test ────────────────────────
    console.log('── Concurrent Reconciliation ──');
    const concOrderId = `${RUN_PREFIX}-concurrent`;

    // Insert a divergent order for the concurrent test
    await pool.query(
      `INSERT INTO orders (id, status, last_sequence, amount, currency)
       VALUES ($1, 'pending', 0, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [concOrderId],
    );

    // Update provider-orders.json with only the concurrent test order
    const concProviderOrders = {
      generated_at: new Date().toISOString(),
      orders: [
        { id: concOrderId, status: 'captured', sequence: 3, amount: '500.00', currency: 'EUR', updated_at: new Date().toISOString() },
      ],
    };
    atomicWriteSync(PROVIDER_ORDERS_PATH, JSON.stringify(concProviderOrders, null, 2));

    // Execute two POST /admin/reconcile simultaneously
    const [resA, resB] = await Promise.all([
      httpPost(`${API_URL}/admin/reconcile`),
      httpPost(`${API_URL}/admin/reconcile`),
    ]);

    assert(resA.status === 200, `Concurrent A returned ${resA.status} (expected 200)`);
    assert(resB.status === 200, `Concurrent B returned ${resB.status} (expected 200)`);
    assert(
      (resA.body['status'] as string) === 'COMPLETED',
      `Concurrent A status = ${resA.body['status']}`,
    );
    assert(
      (resB.body['status'] as string) === 'COMPLETED',
      `Concurrent B status = ${resB.body['status']}`,
    );

    // Sum of repaired from both should be exactly 1
    const totalRepaired = ((resA.body['repaired'] as number) ?? 0) + ((resB.body['repaired'] as number) ?? 0);
    assert(totalRepaired === 1, `Sum of concurrent repaired = ${totalRepaired} (expected 1)`);

    // Only one RECONCILIATION history for that order
    const concHistory = await pool.query(
      `SELECT count(*)::int as cnt FROM order_status_history
       WHERE order_id = $1 AND source = 'RECONCILIATION'`,
      [concOrderId],
    );
    assert(
      concHistory.rows[0]!.cnt === 1,
      `Concurrent order has ${concHistory.rows[0]!.cnt} RECONCILIATION history entries (expected 1)`,
    );

    console.log('');

    // ── Summary ───────────────────────────────────────────────
    console.log('═══════════════════════════════════════');
    console.log(`  RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
    console.log('═══════════════════════════════════════\n');

    if (testsFailed > 0) {
      failed = true;
    }
  } finally {
    // Restore previous provider-orders.json atomically
    if (fileExistedBefore && previousContent !== null) {
      atomicWriteSync(PROVIDER_ORDERS_PATH, previousContent);
    } else if (!fileExistedBefore && existsSync(PROVIDER_ORDERS_PATH)) {
      unlinkSync(PROVIDER_ORDERS_PATH);
    }
    await pool.end();
  }

  // Set exit code after finally has run
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exitCode = 1;
});
