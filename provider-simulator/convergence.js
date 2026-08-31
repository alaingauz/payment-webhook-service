// @ts-check

/**
 * Normalize amount string to 2-decimal for comparison.
 * @param {string} v
 * @returns {string}
 */
function normalizeAmount(v) {
  if (!v) return '0.00';
  const parts = String(v).split('.');
  let intPart = parts[0] || '0';
  const decPart = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  intPart = intPart.replace(/^0+/, '') || '0';
  return `${intPart}.${decPart}`;
}

const TERMINAL_STATUSES = new Set(['APPLIED', 'IGNORED']);
const TERMINAL_FAIL_STATUSES = new Set(['DLQ']);

/**
 * Check if an order has fully converged.
 *
 * An order is converged when:
 * 1. Its state (status, last_sequence, amount, currency) matches expected.
 * 2. All expected event_ids appear in history.events.
 * 3. Each expected event has a terminal processing_status (APPLIED or IGNORED).
 *
 * @param {object} order - Order from GET /orders/:id
 * @param {object} expectedState - { status, last_sequence, amount, currency }
 * @param {string[]} expectedEventIds - Unique event_ids that must be terminal
 * @returns {{ converged: boolean, terminalFail: boolean, terminal: number, pending: number, dlq: number, lost: number }}
 */
export function checkOrderConvergence(order, expectedState, expectedEventIds) {
  const result = { converged: false, terminalFail: false, terminal: 0, pending: 0, dlq: 0, lost: 0 };

  // Check state match
  const stateMatch =
    order.status === expectedState.status &&
    order.last_sequence === expectedState.last_sequence &&
    normalizeAmount(String(order.amount ?? '')) === normalizeAmount(expectedState.amount) &&
    order.currency === expectedState.currency;

  if (!stateMatch) {
    // If last_sequence exceeds expected, it's a divergence (terminal fail)
    if (order.last_sequence > expectedState.last_sequence) {
      result.terminalFail = true;
    }
    return result;
  }

  // State matches — now check all expected events are terminal
  const historyEvents = (order.history && order.history.events) || [];
  const statusByEventId = new Map();
  for (const evt of historyEvents) {
    if (evt.event_id) {
      statusByEventId.set(evt.event_id, evt.processing_status);
    }
  }

  for (const eventId of expectedEventIds) {
    const status = statusByEventId.get(eventId);
    if (status === undefined) {
      // Event not yet in history
      result.lost++;
    } else if (TERMINAL_STATUSES.has(status)) {
      result.terminal++;
    } else if (TERMINAL_FAIL_STATUSES.has(status)) {
      result.dlq++;
      result.terminalFail = true;
    } else {
      // PENDING, RETRY_SCHEDULED, etc.
      result.pending++;
    }
  }

  result.converged = result.pending === 0 && result.dlq === 0 && result.lost === 0;
  return result;
}
