import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { WorkerRepository } from './worker.repository.js';
import { PaymentEventProcessor } from './payment-event-processor.js';
import { PG_POOL } from '../database/database.module.js';

function createMockClient() {
  return {
    query: vi.fn(),
    release: vi.fn(),
  };
}

function createMockPool(client: ReturnType<typeof createMockClient>) {
  return {
    connect: vi.fn().mockResolvedValue(client),
    on: vi.fn(),
    end: vi.fn(),
  };
}

describe('WorkerRepository', () => {
  let repository: WorkerRepository;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(async () => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);

    const module = await Test.createTestingModule({
      providers: [
        WorkerRepository,
        PaymentEventProcessor,
        { provide: PG_POOL, useValue: mockPool },
      ],
    }).compile();

    repository = module.get(WorkerRepository);
  });

  it('returns found=false when no pending event and commits', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // SELECT ... SKIP LOCKED

    // COMMIT
    mockClient.query.mockResolvedValueOnce(undefined);

    const result = await repository.processOne();

    expect(result.found).toBe(false);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('creates order with INSERT ON CONFLICT before SELECT FOR UPDATE', async () => {
    const event = {
      id: '1',
      event_id: 'evt-001',
      order_id: 'order-001',
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date(),
      payload: { data: { amount: '1000', currency: 'MXN' } },
      correlation_id: 'corr-001',
    };

    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // SELECT SKIP LOCKED
      .mockResolvedValueOnce(undefined) // INSERT orders ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 'order-001', status: 'pending', last_sequence: 0, amount: null, currency: null }] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const calls = mockClient.query.mock.calls;
    const insertOrderCall = calls.findIndex(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO orders'),
    );
    const selectOrderCall = calls.findIndex(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('SELECT') && c[0].includes('FROM orders'),
    );

    expect(insertOrderCall).toBeLessThan(selectOrderCall);
  });

  it('marks event as APPLIED and inserts APPLIED history', async () => {
    const event = {
      id: '1',
      event_id: 'evt-001',
      order_id: 'order-001',
      event_type: 'payment.authorized',
      sequence: 1,
      occurred_at: new Date(),
      payload: { data: { amount: '1000', currency: 'MXN' } },
      correlation_id: 'corr-001',
    };

    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [{ id: 'order-001', status: 'pending', last_sequence: 0, amount: null, currency: null }] })
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.found).toBe(true);
    expect(result.outcome).toBe('APPLIED');

    // Check history insert contains APPLIED
    const historyCall = mockClient.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_status_history') && c[0].includes('APPLIED'),
    );
    expect(historyCall).toBeDefined();

    // Check event update contains APPLIED
    const eventUpdateCall = mockClient.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes("processing_status = 'APPLIED'"),
    );
    expect(eventUpdateCall).toBeDefined();
  });

  it('marks event as IGNORED with STALE_SEQUENCE and inserts IGNORED history', async () => {
    const event = {
      id: '1',
      event_id: 'evt-002',
      order_id: 'order-001',
      event_type: 'payment.captured',
      sequence: 1,
      occurred_at: new Date(),
      payload: { data: { amount: '1000', currency: 'MXN' } },
      correlation_id: 'corr-002',
    };

    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [{ id: 'order-001', status: 'authorized', last_sequence: 3, amount: '1000', currency: 'MXN' }] })
      .mockResolvedValueOnce(undefined) // INSERT history (IGNORED)
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (IGNORED)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.found).toBe(true);
    expect(result.outcome).toBe('IGNORED');
    expect(result.outcome_reason).toBe('STALE_SEQUENCE');

    const historyCall = mockClient.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_status_history') && c[0].includes('IGNORED'),
    );
    expect(historyCall).toBeDefined();
  });

  it('executes ROLLBACK on exception and releases client', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('DB error')); // claim fails

    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(repository.processOne()).rejects.toThrow('DB error');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('always releases client even if ROLLBACK fails', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('DB error')); // claim fails

    mockClient.query.mockRejectedValueOnce(new Error('ROLLBACK failed'));

    await expect(repository.processOne()).rejects.toThrow('DB error');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
