// @ts-check
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { generate, shuffle as shuffleArray, createRng } from './generator.js';
import { checkOrderConvergence } from './convergence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ── CLI args ────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    events: 5000,
    duplicateRate: 0.2,
    shuffle: false,
    concurrency: 100,
    seed: 42,
    invalidRate: 0.01,
    staleRate: 0.01,
    apiUrl: 'http://localhost:3000',
    secret: 'dev-webhook-secret-change-me',
    timeoutMs: 60000,
    runId: '',
  };

  for (const arg of args) {
    if (arg.startsWith('--events=')) opts.events = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--duplicate-rate=')) opts.duplicateRate = parseFloat(arg.split('=')[1]);
    else if (arg === '--shuffle') opts.shuffle = true;
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--seed=')) opts.seed = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--invalid-rate=')) opts.invalidRate = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--stale-rate=')) opts.staleRate = parseFloat(arg.split('=')[1]);
    else if (arg.startsWith('--api-url=')) opts.apiUrl = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--secret=')) opts.secret = arg.split('=').slice(1).join('=');
    else if (arg.startsWith('--timeout-ms=')) opts.timeoutMs = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--run-id=')) opts.runId = arg.split('=').slice(1).join('=');
  }

  return opts;
}

function validateArgs(opts) {
  const errors = [];
  if (!Number.isInteger(opts.events) || opts.events <= 0) errors.push('--events must be an integer > 0');
  if (!Number.isInteger(opts.concurrency) || opts.concurrency <= 0) errors.push('--concurrency must be an integer > 0');
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) errors.push('--timeout-ms must be an integer > 0');
  if (!Number.isInteger(opts.seed)) errors.push('--seed must be an integer');
  if (typeof opts.duplicateRate !== 'number' || isNaN(opts.duplicateRate) || opts.duplicateRate < 0 || opts.duplicateRate > 1) errors.push('--duplicate-rate must be between 0 and 1');
  if (typeof opts.invalidRate !== 'number' || isNaN(opts.invalidRate) || opts.invalidRate < 0 || opts.invalidRate > 1) errors.push('--invalid-rate must be between 0 and 1');
  if (typeof opts.staleRate !== 'number' || isNaN(opts.staleRate) || opts.staleRate < 0 || opts.staleRate > 1) errors.push('--stale-rate must be between 0 and 1');
  if (!opts.secret || opts.secret.trim() === '') errors.push('--secret must not be empty');
  try {
    const u = new URL(opts.apiUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push('--api-url must be a valid HTTP URL');
  } catch {
    errors.push('--api-url must be a valid HTTP URL');
  }
  return errors;
}

// ── Atomic file write ───────────────────────────────────────
async function atomicWrite(filePath, data) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = filePath + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmp, filePath);
}

// ── HTTP helpers ────────────────────────────────────────────
function httpPost(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const start = performance.now();
    const req = request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const latency = performance.now() - start;
          resolve({ status: res.statusCode, body: data, latency });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end(body);
  });
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// ── Concurrency pool ────────────────────────────────────────
async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}


// ── Main ────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  // Validate CLI arguments before doing anything
  const validationErrors = validateArgs(opts);
  if (validationErrors.length > 0) {
    console.error('Invalid arguments:');
    for (const e of validationErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // Generate runId if not provided
  if (!opts.runId) {
    opts.runId = `sim-${Date.now()}-${opts.seed}`;
  }

  const baseTimeMs = Date.now();

  console.log('Simulator config:', { ...opts, runId: opts.runId });

  // 1. Generate
  const result = generate({
    events: opts.events,
    duplicateRate: opts.duplicateRate,
    invalidRate: opts.invalidRate,
    staleRate: opts.staleRate,
    seed: opts.seed,
    secret: opts.secret,
    runId: opts.runId,
    baseTimeMs,
  });

  console.log(`Generated: ${result.stats.base} base, ${result.stats.duplicates} duplicates, ` +
    `${result.stats.invalidSignatures} invalid sigs, ${result.stats.staleTimestamps} stale timestamps, ` +
    `${result.stats.total} total, ${result.stats.orders} orders`);

  // 2. Write data files atomically
  await atomicWrite(join(DATA_DIR, 'provider-orders.json'), result.providerOrders);
  await atomicWrite(join(DATA_DIR, 'expected-states.json'), result.expectedStates);
  console.log('Data files written.');

  // 3. Prepare events to send
  let eventsToSend = result.allEvents;
  if (opts.shuffle) {
    const rng = createRng(opts.seed + 1); // Different seed for shuffle
    eventsToSend = shuffleArray(eventsToSend, rng);
  }

  // 4. Send events and track responses per event
  const webhookUrl = `${opts.apiUrl}/webhooks/payments`;
  const latencies = [];
  let sentCount = 0;

  // Response tracking
  let created = 0;
  let duplicateResp = 0;
  let ignoredResp = 0;
  let rejectedResp = 0;
  let http401 = 0;
  let unexpectedErrors = 0;

  const tasks = eventsToSend.map((evt, evtIdx) => async () => {
    try {
      const res = await httpPost(
        webhookUrl,
        evt.rawBody,
        { 'X-Signature': evt.signature },
        opts.timeoutMs,
      );
      latencies.push(res.latency);
      sentCount++;
      if (sentCount % 500 === 0) {
        console.log(`  Sent ${sentCount}/${eventsToSend.length}...`);
      }

      // Classify response
      if (res.status === 401) {
        http401++;
      } else if (res.status === 202) {
        let parsed;
        try {
          parsed = JSON.parse(res.body);
        } catch {
          console.error(`  Event ${evt.eventId}: invalid JSON body from server`);
          unexpectedErrors++;
          return res;
        }
        const resultField = parsed.result;
        if (resultField === 'CREATED') created++;
        else if (resultField === 'DUPLICATE') duplicateResp++;
        else if (resultField === 'IGNORED') ignoredResp++;
        else if (resultField === 'REJECTED') rejectedResp++;
        else {
          console.error(`  Event ${evt.eventId}: unexpected result "${resultField}"`);
          unexpectedErrors++;
        }
      } else if (res.status >= 500 || res.status === 0) {
        console.error(`  Event ${evt.eventId}: server error ${res.status}`);
        unexpectedErrors++;
      } else {
        console.error(`  Event ${evt.eventId}: unexpected status ${res.status}`);
        unexpectedErrors++;
      }

      return res;
    } catch (err) {
      console.error(`  Error sending ${evt.eventId}: ${err.message}`);
      unexpectedErrors++;
      return { status: 0, body: '', latency: 0 };
    }
  });

  console.log(`Sending ${eventsToSend.length} events with concurrency=${opts.concurrency}...`);
  await runWithConcurrency(tasks, opts.concurrency);
  console.log(`All ${eventsToSend.length} events sent.`);

  // 5. Concurrent polling for order convergence
  console.log('Waiting for orders to converge...');
  const expectedStates = result.expectedStates;
  const expectedEventsByOrder = result.expectedEventsByOrder;
  const orderIds = Object.keys(expectedStates);
  const pendingOrders = new Map(orderIds.map((id) => [id, true]));
  const finalResponses = new Map();
  const deadline = Date.now() + opts.timeoutMs;
  let divergences = 0;
  let staleSequenceCount = 0;
  let totalTerminalEvents = 0;
  let totalPendingEvents = 0;
  let totalDlqEvents = 0;
  let totalLostEvents = 0;
  let totalExpectedUniqueEvents = 0;

  // Count total expected unique events
  for (const orderId of orderIds) {
    totalExpectedUniqueEvents += (expectedEventsByOrder[orderId] || []).length;
  }

  while (pendingOrders.size > 0 && Date.now() < deadline) {
    const batch = [...pendingOrders.keys()];
    const pollTasks = batch.map((orderId) => async () => {
      try {
        const res = await httpGet(`${opts.apiUrl}/orders/${orderId}`, 5000);
        if (res.status === 200) {
          const order = JSON.parse(res.body);
          const expected = expectedStates[orderId];
          const expectedEvents = expectedEventsByOrder[orderId] || [];
          const conv = checkOrderConvergence(order, expected, expectedEvents);

          if (conv.converged) {
            pendingOrders.delete(orderId);
            finalResponses.set(orderId, order);
          } else if (conv.terminalFail) {
            // Divergence or DLQ — stop waiting for this order
            pendingOrders.delete(orderId);
            finalResponses.set(orderId, order);
          }
          // Otherwise keep polling (state not matched, or events still PENDING/RETRY_SCHEDULED)
        }
      } catch {
        // retry on next round
      }
    });
    await runWithConcurrency(pollTasks, Math.min(opts.concurrency, batch.length));
    if (pendingOrders.size > 0) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // Final validation: fetch any orders that timed out
  for (const orderId of orderIds) {
    if (!finalResponses.has(orderId)) {
      try {
        const res = await httpGet(`${opts.apiUrl}/orders/${orderId}`, 5000);
        if (res.status === 200) {
          finalResponses.set(orderId, JSON.parse(res.body));
        }
      } catch {
        // leave as missing
      }
    }
  }

  // Validate final responses and count convergence metrics
  for (const orderId of orderIds) {
    const expected = expectedStates[orderId];
    const expectedEvents = expectedEventsByOrder[orderId] || [];
    const order = finalResponses.get(orderId);
    if (!order) {
      console.error(`  ⚠ Order ${orderId} did not converge (timeout, no response)`);
      divergences++;
      totalLostEvents += expectedEvents.length;
      continue;
    }
    const conv = checkOrderConvergence(order, expected, expectedEvents);
    totalTerminalEvents += conv.terminal;
    totalPendingEvents += conv.pending;
    totalDlqEvents += conv.dlq;
    totalLostEvents += conv.lost;

    if (!conv.converged) {
      if (conv.terminalFail) {
        console.error(`  ⚠ Order ${orderId} diverged/DLQ: status=${order.status}, seq=${order.last_sequence}, dlq=${conv.dlq}`);
      } else {
        console.error(`  ⚠ Order ${orderId} did not converge: pending=${conv.pending}, lost=${conv.lost}`);
      }
      divergences++;
    }
  }

  // Count STALE_SEQUENCE from order history
  for (const orderId of orderIds) {
    const order = finalResponses.get(orderId);
    if (order && order.history && order.history.events) {
      for (const evt of order.history.events) {
        if (evt.outcome_reason === 'STALE_SEQUENCE') {
          staleSequenceCount++;
        }
      }
    }
  }

  // 6. Calculate p95
  latencies.sort((a, b) => a - b);
  const p95Index = Math.ceil(latencies.length * 0.95) - 1;
  const p95 = latencies[p95Index] ?? 0;

  // Unique base event IDs
  const uniqueBaseIds = new Set(result.baseEvents.map((e) => e.eventId)).size;

  console.log('\n══════════════════════════════════════');
  console.log('  SIMULATION REPORT');
  console.log('══════════════════════════════════════');
  console.log(`  Total deliveries:      ${eventsToSend.length}`);
  console.log(`  Base events:           ${result.stats.base}`);
  console.log(`  Duplicates:            ${result.stats.duplicates}`);
  console.log(`  Invalid signatures:    ${result.stats.invalidSignatures}`);
  console.log(`  Stale timestamps:      ${result.stats.staleTimestamps}`);
  console.log(`  ─── Actual responses ───`);
  console.log(`  CREATED:               ${created} (expected ${uniqueBaseIds})`);
  console.log(`  DUPLICATE:             ${duplicateResp} (expected ${result.stats.duplicates})`);
  console.log(`  IGNORED (stale ts):    ${ignoredResp} (expected ${result.stats.staleTimestamps})`);
  console.log(`  HTTP 401 (bad sig):    ${http401} (expected ${result.stats.invalidSignatures})`);
  console.log(`  REJECTED:              ${rejectedResp} (expected 0)`);
  console.log(`  STALE_SEQUENCE:        ${staleSequenceCount}`);
  console.log(`  ─── Convergence ───`);
  console.log(`  Expected unique events:${totalExpectedUniqueEvents}`);
  console.log(`  Terminal events:       ${totalTerminalEvents}`);
  console.log(`  Pending events:        ${totalPendingEvents}`);
  console.log(`  DLQ events:            ${totalDlqEvents}`);
  console.log(`  Lost events:           ${totalLostEvents}`);
  console.log(`  Divergences:           ${divergences}`);
  console.log(`  Unexpected errors:     ${unexpectedErrors}`);
  console.log(`  p95 HTTP latency:      ${p95.toFixed(2)} ms`);
  console.log('══════════════════════════════════════\n');

  // Exit criteria
  let exitCode = 0;

  if (divergences > 0) {
    console.error('FAIL: divergences detected');
    exitCode = 1;
  }
  if (rejectedResp > 0) {
    console.error('FAIL: REJECTED responses detected');
    exitCode = 1;
  }
  if (unexpectedErrors > 0) {
    console.error('FAIL: unexpected errors detected');
    exitCode = 1;
  }
  if (created !== uniqueBaseIds) {
    console.error(`FAIL: CREATED count mismatch: ${created} vs expected ${uniqueBaseIds}`);
    exitCode = 1;
  }
  if (duplicateResp !== result.stats.duplicates) {
    console.error(`FAIL: DUPLICATE count mismatch: ${duplicateResp} vs expected ${result.stats.duplicates}`);
    exitCode = 1;
  }
  if (ignoredResp !== result.stats.staleTimestamps) {
    console.error(`FAIL: IGNORED count mismatch: ${ignoredResp} vs expected ${result.stats.staleTimestamps}`);
    exitCode = 1;
  }
  if (http401 !== result.stats.invalidSignatures) {
    console.error(`FAIL: HTTP 401 count mismatch: ${http401} vs expected ${result.stats.invalidSignatures}`);
    exitCode = 1;
  }
  if (totalPendingEvents > 0) {
    console.error(`FAIL: ${totalPendingEvents} events still pending`);
    exitCode = 1;
  }
  if (totalDlqEvents > 0) {
    console.error(`FAIL: ${totalDlqEvents} events in DLQ`);
    exitCode = 1;
  }
  if (totalLostEvents > 0) {
    console.error(`FAIL: ${totalLostEvents} events lost`);
    exitCode = 1;
  }
  if (p95 >= 100) {
    console.error(`FAIL: p95 latency ${p95.toFixed(2)}ms >= 100ms`);
    exitCode = 1;
  }

  if (exitCode === 0) {
    console.log('SUCCESS: all orders converged to expected state');
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Simulator failed:', err);
  process.exit(1);
});
