export interface ClaimedEvent {
  id: string;
  event_id: string;
  order_id: string;
  event_type: string;
  sequence: number;
  occurred_at: Date;
  payload: Record<string, unknown>;
  correlation_id: string;
  attempt_count: number;
  next_attempt_at: Date | null;
}

export type OrderStatus = 'pending' | 'authorized' | 'captured' | 'refunded' | 'failed';

export type ProcessingOutcome = 'APPLIED' | 'IGNORED';

export interface ProcessingResult {
  outcome: ProcessingOutcome;
  outcome_reason: string | null;
  previous_status: OrderStatus;
  new_status: OrderStatus;
  new_sequence: number;
  amount: string | null;
  currency: string | null;
}

export interface OrderRow {
  id: string;
  status: OrderStatus;
  last_sequence: number;
  amount: string | null;
  currency: string | null;
}
