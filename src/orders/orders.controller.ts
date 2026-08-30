import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { OrdersRepository } from './orders.repository.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersRepository: OrdersRepository) {}

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const detail = await this.ordersRepository.findById(id);

    if (!detail) {
      throw new NotFoundException(`Order ${id} not found`);
    }

    const { order, events, statusChanges } = detail;

    return {
      id: order.id,
      status: order.status,
      last_sequence: order.last_sequence,
      amount: order.amount,
      currency: order.currency,
      created_at: order.created_at,
      updated_at: order.updated_at,
      history: {
        events: events.map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          sequence: e.sequence,
          occurred_at: e.occurred_at,
          received_at: e.received_at,
          processing_status: e.processing_status,
          outcome_reason: e.outcome_reason,
          attempt_count: e.attempt_count,
          delivery_count: e.delivery_count,
          processed_at: e.processed_at,
        })),
        status_changes: statusChanges.map((sc) => ({
          event_id: sc.event_id,
          sequence: sc.sequence,
          previous_status: sc.previous_status,
          new_status: sc.new_status,
          outcome: sc.outcome,
          outcome_reason: sc.outcome_reason,
          source: sc.source,
          changed_at: sc.changed_at,
        })),
      },
    };
  }
}
