// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generate, createRng, normalizeAmount } from './generator.js';

const VALID_CHAINS = [
  ['pending', 'authorized', 'captured', 'refunded'],
  ['pending', 'failed'],
  ['pending', 'authorized', 'failed'],
  ['pending', 'authorized', 'captured'],
  ['pending', 'authorized'],
  ['pending'],
];

const FIXED_OPTS = {
  runId: 'test-run',
  baseTimeMs: new Date('2026-08-01T00:00:00Z').getTime(),
};

describe('generator', () => {
  it('same seed + runId + baseTimeMs produces the same output', () => {
    const common = { events: 100, duplicateRate: 0.2, invalidRate: 0.01, staleRate: 0.01, seed: 42, secret: 's', ...FIXED_OPTS };
    const a = generate(common);
    const b = generate(common);

    assert.equal(a.baseEvents.length, b.baseEvents.length);
    for (let i = 0; i < a.baseEvents.length; i++) {
      assert.equal(a.baseEvents[i].eventId, b.baseEvents[i].eventId);
      assert.equal(a.baseEvents[i].rawBody, b.baseEvents[i].rawBody);
      assert.equal(a.baseEvents[i].signature, b.baseEvents[i].signature);
    }
    assert.deepStrictEqual(a.expectedStates, b.expectedStates);
    assert.deepStrictEqual(a.stats, b.stats);
  });

  it('sequences are strictly increasing per order starting at 1', () => {
    const result = generate({ events: 500, duplicateRate: 0, invalidRate: 0, staleRate: 0, seed: 99, secret: 's', ...FIXED_OPTS });
    const orderSeqs = {};
    for (const evt of result.baseEvents) {
      if (!orderSeqs[evt.orderId]) orderSeqs[evt.orderId] = [];
      orderSeqs[evt.orderId].push(evt.sequence);
    }
    for (const [orderId, seqs] of Object.entries(orderSeqs)) {
      assert.equal(seqs[0], 1, `${orderId} should start at 1`);
      for (let i = 1; i < seqs.length; i++) {
        assert.equal(seqs[i], seqs[i - 1] + 1, `${orderId} sequence not strictly increasing`);
      }
    }
  });

  it('all event chains are valid transitions', () => {
    const result = generate({ events: 500, duplicateRate: 0, invalidRate: 0, staleRate: 0, seed: 7, secret: 's', ...FIXED_OPTS });
    const orderChains = {};
    for (const evt of result.baseEvents) {
      if (!orderChains[evt.orderId]) orderChains[evt.orderId] = [];
      orderChains[evt.orderId].push(evt.status);
    }
    for (const [orderId, chain] of Object.entries(orderChains)) {
      const isValid = VALID_CHAINS.some(
        (vc) => vc.length >= chain.length && vc.slice(0, chain.length).every((s, i) => s === chain[i]),
      );
      assert.ok(isValid, `${orderId} chain [${chain}] is not a valid prefix of any known chain`);
    }
  });

  it('expected state corresponds to the highest sequence per order', () => {
    const result = generate({ events: 200, duplicateRate: 0.2, invalidRate: 0.01, staleRate: 0.01, seed: 42, secret: 's', ...FIXED_OPTS });
    const maxSeqs = {};
    for (const evt of result.baseEvents) {
      if (!maxSeqs[evt.orderId] || evt.sequence > maxSeqs[evt.orderId].sequence) {
        maxSeqs[evt.orderId] = { status: evt.status, sequence: evt.sequence };
      }
    }
    for (const [orderId, st] of Object.entries(maxSeqs)) {
      const expected = result.expectedStates[orderId];
      assert.ok(expected, `Missing expected state for ${orderId}`);
      assert.equal(expected.status, st.status, `${orderId} status mismatch`);
      assert.equal(expected.last_sequence, st.sequence, `${orderId} sequence mismatch`);
    }
  });

  it('duplicates preserve event_id and body', () => {
    const result = generate({ events: 100, duplicateRate: 0.5, invalidRate: 0, staleRate: 0, seed: 42, secret: 's', ...FIXED_OPTS });
    const duplicates = result.allEvents.filter((e) => e.isDuplicate);
    assert.ok(duplicates.length > 0, 'Should have duplicates');
    for (const dup of duplicates) {
      const original = result.baseEvents.find((e) => e.eventId === dup.eventId);
      assert.ok(original, `No original found for duplicate ${dup.eventId}`);
      assert.equal(dup.rawBody, original.rawBody, 'rawBody must match');
      assert.equal(dup.signature, original.signature, 'signature must match');
    }
  });

  it('noise does not replace base events', () => {
    const result = generate({ events: 100, duplicateRate: 0.2, invalidRate: 0.1, staleRate: 0.1, seed: 42, secret: 's', ...FIXED_OPTS });
    const baseIds = new Set(result.baseEvents.map((e) => e.eventId));
    const noiseEvents = result.allEvents.filter((e) => e.isInvalidSignature || e.isStaleTimestamp);
    for (const noise of noiseEvents) {
      assert.ok(!baseIds.has(noise.eventId), `Noise event ${noise.eventId} should not share ID with base`);
    }
    // Noise should not affect expectedStates — same as without noise
    const clean = generate({ events: 100, duplicateRate: 0, invalidRate: 0, staleRate: 0, seed: 42, secret: 's', ...FIXED_OPTS });
    assert.deepStrictEqual(result.expectedStates, clean.expectedStates);
  });

  it('createRng is deterministic', () => {
    const rng1 = createRng(123);
    const rng2 = createRng(123);
    for (let i = 0; i < 100; i++) {
      assert.equal(rng1(), rng2());
    }
  });

  // ── New tests required by issue ──

  it('timestamps base are recent relative to baseTimeMs', () => {
    const baseTimeMs = new Date('2026-08-01T12:00:00Z').getTime();
    const result = generate({ events: 50, duplicateRate: 0, invalidRate: 0, staleRate: 0, seed: 1, secret: 's', runId: 'ts-test', baseTimeMs });
    for (const evt of result.baseEvents) {
      const ts = new Date(evt.payload.occurred_at).getTime();
      // Each event uses baseTimeMs + eventCounter (ms), so should be within a small window
      assert.ok(ts >= baseTimeMs, `timestamp ${evt.payload.occurred_at} should be >= baseTimeMs`);
      assert.ok(ts <= baseTimeMs + 10000, `timestamp ${evt.payload.occurred_at} should be close to baseTimeMs`);
    }
  });

  it('stale timestamps are more than 5 minutes before baseTimeMs', () => {
    const baseTimeMs = new Date('2026-08-01T12:00:00Z').getTime();
    const result = generate({ events: 50, duplicateRate: 0, invalidRate: 0, staleRate: 0.5, seed: 1, secret: 's', runId: 'stale-test', baseTimeMs });
    const staleEvents = result.allEvents.filter((e) => e.isStaleTimestamp);
    assert.ok(staleEvents.length > 0, 'Should have stale events');
    const fiveMinMs = 5 * 60 * 1000;
    for (const evt of staleEvents) {
      const ts = new Date(evt.payload.occurred_at).getTime();
      assert.ok(baseTimeMs - ts > fiveMinMs, `stale timestamp should be more than 5 min before baseTimeMs, diff=${baseTimeMs - ts}ms`);
    }
  });

  it('rate zero produces no noise events', () => {
    const result = generate({ events: 100, duplicateRate: 0, invalidRate: 0, staleRate: 0, seed: 42, secret: 's', ...FIXED_OPTS });
    assert.equal(result.stats.invalidSignatures, 0, 'invalidRate=0 should produce 0 invalid events');
    assert.equal(result.stats.staleTimestamps, 0, 'staleRate=0 should produce 0 stale events');
    assert.equal(result.stats.duplicates, 0, 'duplicateRate=0 should produce 0 duplicates');
    assert.equal(result.stats.total, result.stats.base, 'total should equal base with all rates at 0');
  });

  it('runId appears in all IDs', () => {
    const runId = 'my-unique-run';
    const result = generate({ events: 20, duplicateRate: 0.2, invalidRate: 0.1, staleRate: 0.1, seed: 42, secret: 's', runId, baseTimeMs: Date.now() });
    for (const evt of result.allEvents) {
      assert.ok(evt.eventId.includes(runId), `eventId ${evt.eventId} should contain runId`);
      assert.ok(evt.orderId.includes(runId), `orderId ${evt.orderId} should contain runId`);
    }
  });

  it('two different runIds produce different IDs', () => {
    const common = { events: 10, duplicateRate: 0, invalidRate: 0, staleRate: 0, seed: 42, secret: 's', baseTimeMs: Date.now() };
    const a = generate({ ...common, runId: 'run-alpha' });
    const b = generate({ ...common, runId: 'run-beta' });
    const aIds = new Set(a.baseEvents.map((e) => e.eventId));
    const bIds = new Set(b.baseEvents.map((e) => e.eventId));
    for (const id of bIds) {
      assert.ok(!aIds.has(id), `ID ${id} should not appear in both runs`);
    }
  });

  it('normalizeAmount handles leading zeros and missing decimals', () => {
    assert.equal(normalizeAmount('100'), '100.00');
    assert.equal(normalizeAmount('100.0'), '100.00');
    assert.equal(normalizeAmount('000100.00'), '100.00');
    assert.equal(normalizeAmount('0'), '0.00');
    assert.equal(normalizeAmount('0.10'), '0.10');
    assert.equal(normalizeAmount('00042.5'), '42.50');
  });
});
