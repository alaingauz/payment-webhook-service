import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebhookIngestionService } from './webhook-ingestion.service.js';
import type { WebhookIngestionRepository } from './webhook-ingestion.repository.js';

describe('WebhookIngestionService', () => {
  let service: WebhookIngestionService;
  let mockRepo: { saveEventAndDelivery: ReturnType<typeof vi.fn> };

  const basePayload = {
    event_id: 'evt-001',
    order_id: 'order-001',
    event_type: 'payment.authorized',
    sequence: 1,
    occurred_at: new Date().toISOString(),
    data: { amount: '1000.00', currency: 'MXN' },
  };

  const rawBody = Buffer.from(JSON.stringify(basePayload));

  beforeEach(() => {
    mockRepo = {
      saveEventAndDelivery: vi.fn(),
    };
    service = new WebhookIngestionService(mockRepo as unknown as WebhookIngestionRepository);
  });

  it('should return CREATED for a new vigent event', async () => {
    const now = new Date();
    mockRepo.saveEventAndDelivery.mockResolvedValue({
      upsert: { id: 1, delivery_count: 1, payload_hash: 'abc', processing_status: 'PENDING' },
      deliveryResult: 'CREATED',
    });

    const result = await service.ingest(rawBody, basePayload as Record<string, unknown>, 'corr-1', now);
    expect(result.result).toBe('CREATED');
    expect(result.event_id).toBe('evt-001');
  });

  it('should return IGNORED for a stale event', async () => {
    const now = new Date();
    const stalePayload = {
      ...basePayload,
      occurred_at: new Date(now.getTime() - 6 * 60 * 1000).toISOString(), // 6 min ago
    };

    mockRepo.saveEventAndDelivery.mockResolvedValue({
      upsert: { id: 1, delivery_count: 1, payload_hash: 'abc', processing_status: 'IGNORED' },
      deliveryResult: 'IGNORED',
    });

    const result = await service.ingest(rawBody, stalePayload as Record<string, unknown>, 'corr-1', now);
    expect(result.result).toBe('IGNORED');
  });

  it('should NOT mark as stale an event exactly at 5 minute boundary', () => {
    const now = new Date();
    const exactlyAtLimit = new Date(now.getTime() - 5 * 60 * 1000);
    expect(service.isStaleEvent(exactlyAtLimit, now)).toBe(false);
  });

  it('should mark as stale an event older than 5 minutes', () => {
    const now = new Date();
    const olderThanLimit = new Date(now.getTime() - 5 * 60 * 1000 - 1);
    expect(service.isStaleEvent(olderThanLimit, now)).toBe(true);
  });

  it('should NOT mark a future timestamp as stale', () => {
    const now = new Date();
    const future = new Date(now.getTime() + 60 * 1000);
    expect(service.isStaleEvent(future, now)).toBe(false);
  });

  it('should return DUPLICATE for same event_id with same payload_hash', async () => {
    const now = new Date();

    mockRepo.saveEventAndDelivery.mockResolvedValue({
      upsert: { id: 1, delivery_count: 2, payload_hash: 'somehash', processing_status: 'PENDING' },
      deliveryResult: 'DUPLICATE',
    });

    const result = await service.ingest(rawBody, basePayload as Record<string, unknown>, 'corr-1', now);
    expect(result.result).toBe('DUPLICATE');
  });

  it('should return REJECTED for same event_id with different payload_hash', async () => {
    const now = new Date();

    mockRepo.saveEventAndDelivery.mockResolvedValue({
      upsert: { id: 1, delivery_count: 2, payload_hash: 'different-hash', processing_status: 'PENDING' },
      deliveryResult: 'REJECTED',
    });

    const result = await service.ingest(rawBody, basePayload as Record<string, unknown>, 'corr-1', now);
    expect(result.result).toBe('REJECTED');
  });

  it('should not pass startTime or resolveResult to the repository', async () => {
    const now = new Date();

    mockRepo.saveEventAndDelivery.mockResolvedValue({
      upsert: { id: 1, delivery_count: 1, payload_hash: 'abc', processing_status: 'PENDING' },
      deliveryResult: 'CREATED',
    });

    await service.ingest(rawBody, basePayload as Record<string, unknown>, 'corr-1', now);

    // saveEventAndDelivery should receive exactly 2 arguments (event, deliveryBase)
    expect(mockRepo.saveEventAndDelivery).toHaveBeenCalledOnce();
    const callArgs = mockRepo.saveEventAndDelivery.mock.calls[0]!;
    expect(callArgs).toHaveLength(2);

    // No latency_ms in delivery base
    const deliveryBase = callArgs[1];
    expect(deliveryBase).not.toHaveProperty('latency_ms');
  });

  it('should store original payload as string from rawBody', async () => {
    const now = new Date();
    const originalJson = '{"event_id":"evt-001","order_id":"order-001","extra_field":"preserved"}';
    const body = Buffer.from(originalJson);

    mockRepo.saveEventAndDelivery.mockImplementation(
      async (event: { payload: string }) => {
        // Verify original payload string is passed
        expect(event.payload).toBe(originalJson);
        return {
          upsert: { id: 1, delivery_count: 1, payload_hash: 'abc', processing_status: 'PENDING' },
          deliveryResult: 'CREATED',
        };
      },
    );

    const parsed = JSON.parse(originalJson) as Record<string, unknown>;
    await service.ingest(body, parsed, 'corr-1', now);
  });

  it('should set processing_status IGNORED for stale events', async () => {
    const now = new Date();
    const stalePayload = {
      ...basePayload,
      occurred_at: new Date(now.getTime() - 6 * 60 * 1000).toISOString(),
    };

    mockRepo.saveEventAndDelivery.mockResolvedValue({
      upsert: { id: 1, delivery_count: 1, payload_hash: 'abc', processing_status: 'IGNORED' },
      deliveryResult: 'IGNORED',
    });

    await service.ingest(rawBody, stalePayload as Record<string, unknown>, 'corr-1', now);

    const eventArg = mockRepo.saveEventAndDelivery.mock.calls[0]![0];
    expect(eventArg.processing_status).toBe('IGNORED');
    expect(eventArg.outcome_reason).toBe('STALE_TIMESTAMP');
  });
});
