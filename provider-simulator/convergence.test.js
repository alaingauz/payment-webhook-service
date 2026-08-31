// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrderConvergence } from './convergence.js';

const EXPECTED_STATE = {
  status: 'captured',
  last_sequence: 3,
  amount: '100.00',
  currency: 'MXN',
};

describe('checkOrderConvergence', () => {
  it('state correct but one event PENDING → does not converge', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'evt-2', processing_status: 'APPLIED' },
          { event_id: 'evt-3', processing_status: 'PENDING' },
        ],
      },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'evt-2', 'evt-3']);
    assert.equal(result.converged, false);
    assert.equal(result.pending, 1);
    assert.equal(result.terminal, 2);
  });

  it('all APPLIED/IGNORED → converges', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'evt-2', processing_status: 'APPLIED' },
          { event_id: 'evt-3', processing_status: 'IGNORED' },
        ],
      },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'evt-2', 'evt-3']);
    assert.equal(result.converged, true);
    assert.equal(result.terminal, 3);
    assert.equal(result.pending, 0);
    assert.equal(result.dlq, 0);
    assert.equal(result.lost, 0);
  });

  it('missing event → does not converge', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'evt-2', processing_status: 'APPLIED' },
        ],
      },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'evt-2', 'evt-3']);
    assert.equal(result.converged, false);
    assert.equal(result.lost, 1);
    assert.equal(result.terminal, 2);
  });

  it('event in DLQ → terminal fail', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'evt-2', processing_status: 'APPLIED' },
          { event_id: 'evt-3', processing_status: 'DLQ' },
        ],
      },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'evt-2', 'evt-3']);
    assert.equal(result.converged, false);
    assert.equal(result.terminalFail, true);
    assert.equal(result.dlq, 1);
    assert.equal(result.terminal, 2);
  });

  it('duplicates do not require two history entries', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'evt-2', processing_status: 'APPLIED' },
        ],
      },
    };
    // Only unique event_ids are expected; duplicates share the same event_id
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'evt-2']);
    assert.equal(result.converged, true);
    assert.equal(result.terminal, 2);
  });

  it('invalid signature events are not expected in history', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
        ],
      },
    };
    // Invalid sig events are excluded from expectedEventIds
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1']);
    assert.equal(result.converged, true);
  });

  it('stale timestamp with valid signature is expected as IGNORED', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'stale-1', processing_status: 'IGNORED' },
        ],
      },
    };
    // stale-1 has valid signature so it's expected in history
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'stale-1']);
    assert.equal(result.converged, true);
    assert.equal(result.terminal, 2);
  });

  it('state mismatch → does not converge', () => {
    const order = {
      status: 'pending',
      last_sequence: 1,
      amount: '100.00',
      currency: 'MXN',
      history: { events: [] },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1']);
    assert.equal(result.converged, false);
    assert.equal(result.terminalFail, false);
  });

  it('last_sequence exceeds expected → terminal fail divergence', () => {
    const order = {
      status: 'captured',
      last_sequence: 5,
      amount: '100.00',
      currency: 'MXN',
      history: { events: [] },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1']);
    assert.equal(result.converged, false);
    assert.equal(result.terminalFail, true);
  });

  it('RETRY_SCHEDULED event → still pending', () => {
    const order = {
      status: 'captured',
      last_sequence: 3,
      amount: '100.00',
      currency: 'MXN',
      history: {
        events: [
          { event_id: 'evt-1', processing_status: 'APPLIED' },
          { event_id: 'evt-2', processing_status: 'RETRY_SCHEDULED' },
        ],
      },
    };
    const result = checkOrderConvergence(order, EXPECTED_STATE, ['evt-1', 'evt-2']);
    assert.equal(result.converged, false);
    assert.equal(result.pending, 1);
    assert.equal(result.terminal, 1);
  });
});
