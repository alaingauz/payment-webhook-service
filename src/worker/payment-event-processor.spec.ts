import { describe, it, expect } from 'vitest';
import { PaymentEventProcessor } from './payment-event-processor.js';
import type { ClaimedEvent, OrderRow } from './types/worker.types.js';

function makeEvent(overrides: Partial<ClaimedEvent> = {}): ClaimedEvent {
  return {
    id: '1',
    event_id: 'evt-001',
    order_id: 'order-001',
    event_type: 'payment.authorized',
    sequence: 1,
    occurred_at: new Date(),
    payload: { data: { amount: '1000.00', currency: 'MXN' } },
    correlation_id: 'corr-001',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: 'order-001',
    status: 'pending',
    last_sequence: 0,
    amount: null,
    currency: null,
    ...overrides,
  };
}

describe('PaymentEventProcessor', () => {
  const processor = new PaymentEventProcessor();

  describe('mapEventToStatus', () => {
    it('maps payment.pending to pending', () => {
      expect(processor.mapEventToStatus('payment.pending')).toBe('pending');
    });

    it('maps payment.authorized to authorized', () => {
      expect(processor.mapEventToStatus('payment.authorized')).toBe('authorized');
    });

    it('maps payment.captured to captured', () => {
      expect(processor.mapEventToStatus('payment.captured')).toBe('captured');
    });

    it('maps payment.refunded to refunded', () => {
      expect(processor.mapEventToStatus('payment.refunded')).toBe('refunded');
    });

    it('maps payment.failed to failed', () => {
      expect(processor.mapEventToStatus('payment.failed')).toBe('failed');
    });

    it('returns null for unknown event type', () => {
      expect(processor.mapEventToStatus('payment.unknown')).toBeNull();
    });
  });

  describe('process', () => {
    it('applies event when sequence is greater than order last_sequence', () => {
      const event = makeEvent({ sequence: 2, event_type: 'payment.authorized' });
      const order = makeOrder({ last_sequence: 1 });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('APPLIED');
      expect(result.outcome_reason).toBeNull();
      expect(result.previous_status).toBe('pending');
      expect(result.new_status).toBe('authorized');
      expect(result.new_sequence).toBe(2);
    });

    it('ignores event when sequence is less than order last_sequence', () => {
      const event = makeEvent({ sequence: 1, event_type: 'payment.authorized' });
      const order = makeOrder({ last_sequence: 3, status: 'refunded' });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('IGNORED');
      expect(result.outcome_reason).toBe('STALE_SEQUENCE');
      expect(result.previous_status).toBe('refunded');
      expect(result.new_status).toBe('refunded');
      expect(result.new_sequence).toBe(3);
    });

    it('ignores event when sequence equals order last_sequence', () => {
      const event = makeEvent({ sequence: 2, event_type: 'payment.captured' });
      const order = makeOrder({ last_sequence: 2, status: 'authorized' });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('IGNORED');
      expect(result.outcome_reason).toBe('STALE_SEQUENCE');
      expect(result.new_status).toBe('authorized');
    });

    it('allows direct jump pending -> refunded when sequence is greater', () => {
      const event = makeEvent({ sequence: 3, event_type: 'payment.refunded' });
      const order = makeOrder({ last_sequence: 0, status: 'pending' });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('APPLIED');
      expect(result.previous_status).toBe('pending');
      expect(result.new_status).toBe('refunded');
      expect(result.new_sequence).toBe(3);
    });

    it('extracts amount and currency from payload.data on APPLIED', () => {
      const event = makeEvent({
        sequence: 1,
        payload: { data: { amount: '500.50', currency: 'USD' } },
      });
      const order = makeOrder({ last_sequence: 0 });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('APPLIED');
      expect(result.amount).toBe('500.50');
      expect(result.currency).toBe('USD');
    });

    it('handles missing payload.data gracefully', () => {
      const event = makeEvent({ sequence: 1, payload: {} });
      const order = makeOrder({ last_sequence: 0 });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('APPLIED');
      expect(result.amount).toBeNull();
      expect(result.currency).toBeNull();
    });

    it('does not include amount/currency on IGNORED', () => {
      const event = makeEvent({
        sequence: 1,
        payload: { data: { amount: '500.50', currency: 'USD' } },
      });
      const order = makeOrder({ last_sequence: 5 });
      const result = processor.process(event, order);

      expect(result.outcome).toBe('IGNORED');
      expect(result.amount).toBeNull();
      expect(result.currency).toBeNull();
    });
  });
});
