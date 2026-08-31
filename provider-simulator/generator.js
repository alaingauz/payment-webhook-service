// @ts-check
import { createHmac } from 'node:crypto';

/**
 * Seeded PRNG (mulberry32) for reproducible results.
 * @param {number} seed
 * @returns {() => number} random float in [0,1)
 */
export function createRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle using seeded RNG.
 * @template T
 * @param {T[]} arr
 * @param {() => number} rng
 * @returns {T[]}
 */
export function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Valid transition chains for payment orders. */
const CHAINS = [
  ['pending', 'authorized', 'captured', 'refunded'],
  ['pending', 'failed'],
  ['pending', 'authorized', 'failed'],
  ['pending', 'authorized', 'captured'],
  ['pending', 'authorized'],
  ['pending'],
];

const STATUS_TO_EVENT_TYPE = {
  pending: 'payment.pending',
  authorized: 'payment.authorized',
  captured: 'payment.captured',
  refunded: 'payment.refunded',
  failed: 'payment.failed',
};

/**
 * Normalize amount to 2-decimal string.
 * Strips leading zeros (keeps at least one digit).
 * Pure string manipulation, no Number/parseFloat.
 * @param {string} amount
 * @returns {string}
 */
export function normalizeAmount(amount) {
  const parts = amount.split('.');
  let intPart = parts[0] || '0';
  const decPart = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  // Strip leading zeros, keep at least one digit
  intPart = intPart.replace(/^0+/, '') || '0';
  return `${intPart}.${decPart}`;
}

/**
 * Generate events, expected states, and provider orders.
 * @param {object} opts
 * @param {number} opts.events
 * @param {number} opts.duplicateRate
 * @param {number} opts.invalidRate
 * @param {number} opts.staleRate
 * @param {number} opts.seed
 * @param {string} opts.secret
 * @param {string} opts.runId
 * @param {number} opts.baseTimeMs
 * @returns {{ baseEvents: object[], allEvents: object[], expectedStates: object, providerOrders: object, stats: object }}
 */
export function generate(opts) {
  const {
    events: totalEvents,
    duplicateRate = 0.2,
    invalidRate = 0.01,
    staleRate = 0.01,
    seed = 42,
    secret = 'dev-webhook-secret-change-me',
    runId = 'run',
    baseTimeMs = Date.now(),
  } = opts;

  const rng = createRng(seed);
  const baseEvents = [];
  const orderStates = {}; // orderId -> { status, sequence, amount, currency }
  let eventCounter = 0;

  // Generate orders and their event chains until we have enough base events
  while (baseEvents.length < totalEvents) {
    const orderId = `${runId}-order-${String(eventCounter + 1).padStart(6, '0')}`;
    const chain = CHAINS[Math.floor(rng() * CHAINS.length)];
    const amount = normalizeAmount(`${(Math.floor(rng() * 100000) + 100)}.${String(Math.floor(rng() * 100)).padStart(2, '0')}`);
    const currency = ['MXN', 'USD', 'EUR'][Math.floor(rng() * 3)];

    for (let i = 0; i < chain.length; i++) {
      if (baseEvents.length >= totalEvents) break;

      const seq = i + 1;
      const status = chain[i];
      const eventType = STATUS_TO_EVENT_TYPE[status];
      eventCounter++;
      const eventId = `${runId}-evt-${String(eventCounter).padStart(8, '0')}`;
      const occurredAt = new Date(baseTimeMs + eventCounter).toISOString();

      const payload = {
        event_id: eventId,
        event_type: eventType,
        order_id: orderId,
        sequence: seq,
        occurred_at: occurredAt,
        data: {
          amount,
          currency,
        },
      };

      const rawBody = JSON.stringify(payload);
      const signature = createHmac('sha256', secret).update(rawBody).digest('hex');

      baseEvents.push({
        eventId,
        orderId,
        eventType,
        sequence: seq,
        status,
        rawBody,
        signature,
        payload,
        isBase: true,
      });

      // Track final state per order (highest sequence)
      if (!orderStates[orderId] || seq > orderStates[orderId].sequence) {
        orderStates[orderId] = { status, sequence: seq, amount, currency };
      }
    }
  }

  // Trim to exactly totalEvents
  const trimmedBase = baseEvents.slice(0, totalEvents);

  // Recalculate orderStates from trimmed base
  const finalStates = {};
  for (const evt of trimmedBase) {
    if (!finalStates[evt.orderId] || evt.sequence > finalStates[evt.orderId].sequence) {
      finalStates[evt.orderId] = {
        status: evt.status,
        sequence: evt.sequence,
        amount: evt.payload.data.amount,
        currency: evt.payload.data.currency,
      };
    }
  }

  // Generate duplicates (exact copies of base events)
  const numDuplicates = Math.floor(trimmedBase.length * duplicateRate);
  const duplicates = [];
  for (let i = 0; i < numDuplicates; i++) {
    const src = trimmedBase[Math.floor(rng() * trimmedBase.length)];
    duplicates.push({ ...src, isBase: false, isDuplicate: true });
  }

  // Generate invalid signature events (noise) — rate 0 produces zero events
  const numInvalid = Math.floor(trimmedBase.length * invalidRate);
  const invalidEvents = [];
  for (let i = 0; i < numInvalid; i++) {
    const src = trimmedBase[Math.floor(rng() * trimmedBase.length)];
    eventCounter++;
    const noiseId = `${runId}-evt-noise-inv-${String(eventCounter).padStart(8, '0')}`;
    const noisePayload = { ...src.payload, event_id: noiseId };
    const noiseBody = JSON.stringify(noisePayload);
    // Invalid signature - use wrong secret
    const badSig = createHmac('sha256', 'wrong-secret').update(noiseBody).digest('hex');
    invalidEvents.push({
      eventId: noiseId,
      orderId: src.orderId,
      eventType: src.eventType,
      sequence: src.sequence,
      status: src.status,
      rawBody: noiseBody,
      signature: badSig,
      payload: noisePayload,
      isBase: false,
      isInvalidSignature: true,
    });
  }

  // Generate stale timestamp events (noise) — rate 0 produces zero events
  const numStale = Math.floor(trimmedBase.length * staleRate);
  const staleEvents = [];
  for (let i = 0; i < numStale; i++) {
    const src = trimmedBase[Math.floor(rng() * trimmedBase.length)];
    eventCounter++;
    const noiseId = `${runId}-evt-noise-stale-${String(eventCounter).padStart(8, '0')}`;
    // Stale timestamp: baseTimeMs - 10 minutes (clearly beyond the 5-minute threshold)
    const staleTime = new Date(baseTimeMs - 10 * 60 * 1000).toISOString();
    const noisePayload = { ...src.payload, event_id: noiseId, occurred_at: staleTime };
    const noiseBody = JSON.stringify(noisePayload);
    const sig = createHmac('sha256', secret).update(noiseBody).digest('hex');
    staleEvents.push({
      eventId: noiseId,
      orderId: src.orderId,
      eventType: src.eventType,
      sequence: src.sequence,
      status: src.status,
      rawBody: noiseBody,
      signature: sig,
      payload: noisePayload,
      isBase: false,
      isStaleTimestamp: true,
    });
  }

  const allEvents = [...trimmedBase, ...duplicates, ...invalidEvents, ...staleEvents];

  // Build expected-states.json
  const expectedStates = {};
  for (const [orderId, state] of Object.entries(finalStates)) {
    expectedStates[orderId] = {
      status: state.status,
      last_sequence: state.sequence,
      amount: state.amount,
      currency: state.currency,
    };
  }

  // Build provider-orders.json
  const generatedAt = new Date(baseTimeMs).toISOString();
  const providerOrders = {
    generated_at: generatedAt,
    orders: Object.entries(finalStates).map(([id, state]) => ({
      id,
      status: state.status,
      sequence: state.sequence,
      amount: state.amount,
      currency: state.currency,
      updated_at: generatedAt,
    })),
  };

  // Build expected event IDs per order:
  // - All unique base event_ids (duplicates share the same event_id, so they collapse)
  // - Stale timestamp events (valid signature, will be persisted as IGNORED)
  // - NOT invalid signature events (401, not persisted)
  const expectedEventsByOrder = {};
  for (const evt of trimmedBase) {
    if (!expectedEventsByOrder[evt.orderId]) expectedEventsByOrder[evt.orderId] = new Set();
    expectedEventsByOrder[evt.orderId].add(evt.eventId);
  }
  for (const evt of staleEvents) {
    if (!expectedEventsByOrder[evt.orderId]) expectedEventsByOrder[evt.orderId] = new Set();
    expectedEventsByOrder[evt.orderId].add(evt.eventId);
  }
  // Convert Sets to arrays for serialization
  const expectedEventsByOrderArrays = {};
  for (const [orderId, ids] of Object.entries(expectedEventsByOrder)) {
    expectedEventsByOrderArrays[orderId] = [...ids];
  }

  return {
    baseEvents: trimmedBase,
    allEvents,
    expectedStates,
    expectedEventsByOrder: expectedEventsByOrderArrays,
    providerOrders,
    stats: {
      base: trimmedBase.length,
      duplicates: duplicates.length,
      invalidSignatures: invalidEvents.length,
      staleTimestamps: staleEvents.length,
      total: allEvents.length,
      orders: Object.keys(finalStates).length,
    },
  };
}
