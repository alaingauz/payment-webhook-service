import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { WebhookIngestionRepository } from './webhook-ingestion.repository.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export type DeliveryResult = 'CREATED' | 'DUPLICATE' | 'IGNORED' | 'REJECTED';

export interface IngestionResult {
  event_id: string;
  result: DeliveryResult;
  message: string;
}

@Injectable()
export class WebhookIngestionService {
  private readonly logger = new Logger(WebhookIngestionService.name);

  constructor(private readonly repository: WebhookIngestionRepository) {}

  async ingest(
    rawBody: Buffer,
    validatedPayload: Record<string, unknown>,
    correlationId: string,
    receivedAt: Date,
  ): Promise<IngestionResult> {
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const eventId = validatedPayload['event_id'] as string;
    const orderId = validatedPayload['order_id'] as string;
    const eventType = validatedPayload['event_type'] as string;
    const sequence = validatedPayload['sequence'] as number;
    const occurredAt = validatedPayload['occurred_at'] as string;

    const isStale = this.isStaleEvent(new Date(occurredAt), receivedAt);

    const processingStatus = isStale ? 'IGNORED' : 'PENDING';
    const outcomeReason = isStale ? 'STALE_TIMESTAMP' : null;
    const processedAt = isStale ? receivedAt : null;

    // Store original JSON payload (from rawBody after HMAC + DTO validation)
    const originalPayload = rawBody.toString('utf-8');

    const { deliveryResult } = await this.repository.saveEventAndDelivery(
      {
        event_id: eventId,
        order_id: orderId,
        event_type: eventType,
        sequence,
        occurred_at: occurredAt,
        payload: originalPayload,
        payload_hash: payloadHash,
        received_at: receivedAt,
        processing_status: processingStatus,
        outcome_reason: outcomeReason,
        processed_at: processedAt,
        correlation_id: correlationId,
      },
      {
        event_id: eventId,
        received_at: receivedAt,
        correlation_id: correlationId,
      },
    );

    return {
      event_id: eventId,
      result: deliveryResult as DeliveryResult,
      message: 'Webhook stored for asynchronous processing',
    };
  }

  isStaleEvent(occurredAt: Date, receivedAt: Date): boolean {
    // An event is stale only when occurred_at < received_at - 5 minutes
    // A future timestamp must NOT be marked as stale
    return occurredAt.getTime() < receivedAt.getTime() - STALE_THRESHOLD_MS;
  }

}
