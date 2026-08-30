import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { WorkerRepository } from './worker.repository.js';
import { PaymentEventProcessor } from './payment-event-processor.js';
import { RetryPolicy } from './retry-policy.js';
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

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    event_id: 'evt-001',
    order_id: 'order-001',
    event_type: 'payment.authorized',
    sequence: 1,
    occurred_at: new Date(),
    payload: { data: { amount: '1000', currency: 'MXN' } },
    correlation_id: 'corr-001',
    attempt_count: 0,
    next_attempt_at: null,
    ...overrides,
  };
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-001',
    status: 'pending',
    last_sequence: 0,
    amount: null,
    currency: null,
    ...overrides,
  };
}

describe('WorkerRepository', () => {
  let repository: WorkerRepository;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;
  let retryPolicy: RetryPolicy;

  beforeEach(async () => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);
    retryPolicy = new RetryPolicy(5, 500, 30000, () => 0.5);

    const module = await Test.createTestingModule({
      providers: [
        WorkerRepository,
        PaymentEventProcessor,
        { provide: PG_POOL, useValue: mockPool },
        { provide: RetryPolicy, useValue: retryPolicy },
      ],
    }).compile();

    repository = module.get(WorkerRepository);
  });

  it('returns found=false when no pending event and commits', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... SKIP LOCKED
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.found).toBe(false);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('claim includes PENDING events', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // claim
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const claimCall = mockClient.query.mock.calls[1]![0] as string;
    expect(claimCall).toContain("processing_status = 'PENDING'");
  });

  it('claim includes RETRY_SCHEDULED with expired next_attempt_at', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // claim
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const claimCall = mockClient.query.mock.calls[1]![0] as string;
    expect(claimCall).toContain("processing_status = 'RETRY_SCHEDULED'");
    expect(claimCall).toContain('next_attempt_at <= clock_timestamp()');
  });

  it('claim does not include DLQ, APPLIED, or IGNORED', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // claim
    mockClient.query.mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const claimCall = mockClient.query.mock.calls[1]![0] as string;
    expect(claimCall).not.toContain("'DLQ'");
    expect(claimCall).not.toContain("'APPLIED'");
    expect(claimCall).not.toContain("'IGNORED'");
  });

  it('creates SAVEPOINT after claim', async () => {
    const event = makeEvent();
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder()] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    const savepointIndex = calls.indexOf('SAVEPOINT business_processing');
    const claimIndex = 1; // Second call is claim
    expect(savepointIndex).toBe(2);
    expect(savepointIndex).toBeGreaterThan(claimIndex);
  });

  it('APPLIED does not do ROLLBACK TO SAVEPOINT', async () => {
    const event = makeEvent();
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder()] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.outcome).toBe('APPLIED');
    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain('ROLLBACK TO SAVEPOINT business_processing');
    expect(calls).toContain('RELEASE SAVEPOINT business_processing');
  });

  it('STALE_SEQUENCE does not do ROLLBACK TO SAVEPOINT', async () => {
    const event = makeEvent({ sequence: 1 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder({ last_sequence: 5 })] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // INSERT history (IGNORED)
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (IGNORED)
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.outcome).toBe('IGNORED');
    expect(result.outcome_reason).toBe('STALE_SEQUENCE');
    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain('ROLLBACK TO SAVEPOINT business_processing');
  });

  it('exception does ROLLBACK TO SAVEPOINT and schedules retry', async () => {
    const event = makeEvent({ attempt_count: 0 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(new Error('NUMERIC overflow')) // INSERT orders fails
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (RETRY_SCHEDULED)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.outcome).toBe('RETRY_SCHEDULED');
    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('ROLLBACK TO SAVEPOINT business_processing');
    expect(calls).toContain('RELEASE SAVEPOINT business_processing');
  });

  it('partial order/history failure is reverted by SAVEPOINT', async () => {
    const event = makeEvent({ attempt_count: 0 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders OK
      .mockResolvedValueOnce({ rows: [makeOrder()] }) // SELECT orders FOR UPDATE OK
      .mockRejectedValueOnce(new Error('column overflow')) // UPDATE orders FAILS
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (RETRY_SCHEDULED)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.outcome).toBe('RETRY_SCHEDULED');
    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('ROLLBACK TO SAVEPOINT business_processing');
  });

  it('first failure programs attempt_count=1', async () => {
    const event = makeEvent({ attempt_count: 0 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(new Error('fail')) // business error
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined) // UPDATE (RETRY_SCHEDULED)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.attempt_count).toBe(1);
    expect(result.outcome).toBe('RETRY_SCHEDULED');
  });

  it('next_attempt_at is reported in result', async () => {
    const event = makeEvent({ attempt_count: 0 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(new Error('fail')) // business error
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined) // UPDATE (RETRY_SCHEDULED)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.next_attempt_at).toBeInstanceOf(Date);
  });

  it('last attempt moves to DLQ', async () => {
    const event = makeEvent({ attempt_count: 4 }); // next will be 5 >= 5
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(new Error('fail')) // business error
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined) // UPDATE (DLQ)
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.outcome).toBe('DLQ');
    expect(result.outcome_reason).toBe('MAX_ATTEMPTS_EXHAUSTED');
    expect(result.attempt_count).toBe(5);
    expect(result.next_attempt_at).toBeNull();
  });

  it('DLQ does not create history', async () => {
    const event = makeEvent({ attempt_count: 4 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(new Error('fail')) // business error
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined) // UPDATE (DLQ)
      .mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const calls = mockClient.query.mock.calls;
    // After RELEASE SAVEPOINT, there should be UPDATE (DLQ) and COMMIT — no INSERT INTO order_status_history
    const afterRelease = calls.slice(5); // from RELEASE SAVEPOINT onwards
    const historyInserts = afterRelease.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_status_history'),
    );
    expect(historyInserts).toHaveLength(0);
  });

  it('error programming retry executes ROLLBACK on outer transaction', async () => {
    const event = makeEvent({ attempt_count: 0 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockRejectedValueOnce(new Error('business fail')) // business error
      .mockResolvedValueOnce(undefined) // ROLLBACK TO SAVEPOINT
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockRejectedValueOnce(new Error('DB write error')) // UPDATE RETRY_SCHEDULED fails
      .mockResolvedValueOnce(undefined); // ROLLBACK (outer)

    await expect(repository.processOne()).rejects.toThrow('DB write error');

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('successful processing after retry clears next_attempt_at', async () => {
    const event = makeEvent({
      attempt_count: 2,
      next_attempt_at: new Date('2026-01-01'),
    });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder()] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (APPLIED)
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.outcome).toBe('APPLIED');
    expect(result.next_attempt_at).toBeNull();
    // Verify the UPDATE sets next_attempt_at = NULL
    const updateCall = mockClient.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes("processing_status = 'APPLIED'"),
    );
    expect(updateCall).toBeDefined();
    expect((updateCall![0] as string)).toContain('next_attempt_at = NULL');
  });

  it('always releases client', async () => {
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('claim fail')); // claim
    mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(repository.processOne()).rejects.toThrow();
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

  it('creates order with INSERT ON CONFLICT before SELECT FOR UPDATE', async () => {
    const event = makeEvent();
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders ON CONFLICT
      .mockResolvedValueOnce({ rows: [makeOrder()] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    await repository.processOne();

    const calls = mockClient.query.mock.calls;
    const insertOrderCall = calls.findIndex(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO orders'),
    );
    const selectOrderCall = calls.findIndex(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT') && (c[0] as string).includes('FROM orders'),
    );

    expect(insertOrderCall).toBeLessThan(selectOrderCall);
  });

  it('marks event as APPLIED and inserts APPLIED history', async () => {
    const event = makeEvent();
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder()] })
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.found).toBe(true);
    expect(result.outcome).toBe('APPLIED');

    const historyCall = mockClient.query.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO order_status_history') && (c[0] as string).includes('APPLIED'),
    );
    expect(historyCall).toBeDefined();
  });

  it('COMMIT failure after APPLIED does not ROLLBACK TO SAVEPOINT or schedule retry', async () => {
    const event = makeEvent();
    const evaluateSpy = vi.spyOn(retryPolicy, 'evaluate');

    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder()] }) // SELECT orders FOR UPDATE
      .mockResolvedValueOnce(undefined) // UPDATE orders
      .mockResolvedValueOnce(undefined) // INSERT history
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (APPLIED)
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockRejectedValueOnce(new Error('COMMIT failed')) // COMMIT fails
      .mockResolvedValueOnce(undefined); // ROLLBACK (outer)

    await expect(repository.processOne()).rejects.toThrow('COMMIT failed');

    const calls = mockClient.query.mock.calls.map((c: unknown[]) => c[0]);

    // ROLLBACK TO SAVEPOINT must NOT be called after COMMIT failure
    expect(calls).not.toContain('ROLLBACK TO SAVEPOINT business_processing');
    // Outer ROLLBACK must be called
    expect(calls).toContain('ROLLBACK');
    // RetryPolicy must NOT be invoked
    expect(evaluateSpy).not.toHaveBeenCalled();
    // No RETRY_SCHEDULED or DLQ update (match UPDATE webhook_events SET, not the claim SELECT)
    const retryOrDlqUpdates = calls.filter(
      (c: unknown) => typeof c === 'string' && (c as string).includes('UPDATE webhook_events') &&
        ((c as string).includes("'RETRY_SCHEDULED'") || (c as string).includes("'DLQ'")),
    );
    expect(retryOrDlqUpdates).toHaveLength(0);
    // Client always released
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('marks event as IGNORED with STALE_SEQUENCE and inserts IGNORED history', async () => {
    const event = makeEvent({ event_type: 'payment.captured', sequence: 1 });
    mockClient.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [event] }) // claim
      .mockResolvedValueOnce(undefined) // SAVEPOINT
      .mockResolvedValueOnce(undefined) // INSERT orders
      .mockResolvedValueOnce({ rows: [makeOrder({ status: 'authorized', last_sequence: 3, amount: '1000', currency: 'MXN' })] })
      .mockResolvedValueOnce(undefined) // INSERT history (IGNORED)
      .mockResolvedValueOnce(undefined) // UPDATE webhook_events (IGNORED)
      .mockResolvedValueOnce(undefined) // RELEASE SAVEPOINT
      .mockResolvedValueOnce(undefined); // COMMIT

    const result = await repository.processOne();

    expect(result.found).toBe(true);
    expect(result.outcome).toBe('IGNORED');
    expect(result.outcome_reason).toBe('STALE_SEQUENCE');
  });
});
