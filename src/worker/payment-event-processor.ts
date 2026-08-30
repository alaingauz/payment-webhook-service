import { Injectable } from '@nestjs/common';
import type {
  ClaimedEvent,
  OrderRow,
  OrderStatus,
  ProcessingResult,
} from './types/worker.types.js';

const EVENT_TYPE_TO_STATUS: Record<string, OrderStatus> = {
  'payment.pending': 'pending',
  'payment.authorized': 'authorized',
  'payment.captured': 'captured',
  'payment.refunded': 'refunded',
  'payment.failed': 'failed',
};

@Injectable()
export class PaymentEventProcessor {
  mapEventToStatus(eventType: string): OrderStatus | null {
    return EVENT_TYPE_TO_STATUS[eventType] ?? null;
  }

  process(event: ClaimedEvent, order: OrderRow): ProcessingResult {
    const targetStatus = this.mapEventToStatus(event.event_type);

    if (!targetStatus) {
      return {
        outcome: 'IGNORED',
        outcome_reason: 'UNKNOWN_EVENT_TYPE',
        previous_status: order.status,
        new_status: order.status,
        new_sequence: order.last_sequence,
        amount: null,
        currency: null,
      };
    }

    const payload = event.payload as Record<string, unknown> | undefined;
    const data = (payload?.['data'] as Record<string, unknown> | undefined) ?? {};
    const amount = data['amount'] != null ? String(data['amount']) : null;
    const currency = data['currency'] != null ? String(data['currency']) : null;

    if (event.sequence > order.last_sequence) {
      return {
        outcome: 'APPLIED',
        outcome_reason: null,
        previous_status: order.status,
        new_status: targetStatus,
        new_sequence: event.sequence,
        amount,
        currency,
      };
    }

    return {
      outcome: 'IGNORED',
      outcome_reason: 'STALE_SEQUENCE',
      previous_status: order.status,
      new_status: order.status,
      new_sequence: order.last_sequence,
      amount: null,
      currency: null,
    };
  }
}
