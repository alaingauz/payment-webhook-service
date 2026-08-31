import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReconciliationRepository, normalizeAmount } from './reconciliation.repository.js';
import type { ProviderOrder } from '../provider/provider-client.js';

function createMockPool() {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool, client };
}

function providerOrder(overrides: Partial<ProviderOrder> = {}): ProviderOrder {
  return {
    id: 'order-1',
    status: 'captured',
    sequence: 3,
    amount: '100.00',
    currency: 'MXN',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ReconciliationRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: ReconciliationRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new ReconciliationRepository(mockPool.pool as any);
  });

  /**
   * Setup mock queries.
   * @param localOrder - If null, simulates a newly inserted order (RETURNING returns row).
   *                     If provided, simulates an existing order (RETURNING returns empty).
   */
  function setupQueries(
    localOrder: { status: string; last_sequence: number; amount: string | null; currency: string | null } | null,
  ) {
    const { client } = mockPool;
    client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const sqlStr = typeof sql === 'string' ? sql.trim() : '';

      if (sqlStr === 'BEGIN') return {};
      if (sqlStr === 'COMMIT') return {};
      if (sqlStr === 'ROLLBACK') return {};
      if (sqlStr.includes('pg_advisory_xact_lock')) return {};

      // INSERT reconciliation_runs
      if (sqlStr.includes('INSERT INTO reconciliation_runs')) {
        return { rows: [{ id: '42', started_at: new Date('2026-01-01T00:00:00Z') }] };
      }

      // INSERT orders ON CONFLICT DO NOTHING RETURNING id
      if (sqlStr.includes('INSERT INTO orders') && sqlStr.includes('ON CONFLICT')) {
        if (localOrder === null) {
          // New order: RETURNING returns the id
          return { rows: [{ id: params?.[0] }] };
        }
        // Existing order: RETURNING returns nothing
        return { rows: [] };
      }

      // SELECT FOR UPDATE
      if (sqlStr.includes('SELECT') && sqlStr.includes('FOR UPDATE')) {
        if (localOrder) {
          return {
            rows: [{
              id: params?.[0] ?? 'order-1',
              ...localOrder,
            }],
          };
        }
        // Newly inserted order
        return {
          rows: [{
            id: params?.[0] ?? 'order-1',
            status: 'pending',
            last_sequence: 0,
            amount: null,
            currency: null,
          }],
        };
      }

      // UPDATE orders
      if (sqlStr.includes('UPDATE orders')) return {};

      // INSERT order_status_history
      if (sqlStr.includes('INSERT INTO order_status_history')) return {};

      // UPDATE reconciliation_runs COMPLETED
      if (sqlStr.includes('UPDATE reconciliation_runs')) {
        return { rows: [{ finished_at: new Date('2026-01-01T00:00:01Z') }] };
      }

      // DELETE reconciliation_details (not used anymore but just in case)
      if (sqlStr.includes('DELETE FROM reconciliation_details')) return {};

      // INSERT reconciliation_details
      if (sqlStr.includes('INSERT INTO reconciliation_details')) return {};

      return { rows: [] };
    });
  }

  it('REPAIRED: non-existent order gets created and repaired', async () => {
    setupQueries(null); // no local order -> newly inserted

    const result = await repo.executeReconciliation([
      providerOrder({ id: 'new-order', status: 'captured', sequence: 3 }),
    ]);

    expect(result.repaired).toBe(1);
    expect(result.already_ok).toBe(0);
    expect(result.details[0]!.action).toBe('REPAIRED');
    expect(result.details[0]!.local_status).toBeNull(); // was newly inserted
    expect(result.details[0]!.local_sequence).toBeNull(); // new order has null local_sequence
  });

  it('REPAIRED: divergent order with provider sequence >= local', async () => {
    setupQueries({ status: 'authorized', last_sequence: 2, amount: '100.00', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3 }),
    ]);

    expect(result.repaired).toBe(1);
    expect(result.details[0]!.action).toBe('REPAIRED');
    expect(result.details[0]!.local_status).toBe('authorized');
  });

  it('ALREADY_OK: identical order produces no UPDATE or history', async () => {
    setupQueries({ status: 'captured', last_sequence: 3, amount: '100.00', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN' }),
    ]);

    expect(result.already_ok).toBe(1);
    expect(result.repaired).toBe(0);
    expect(result.details[0]!.action).toBe('ALREADY_OK');

    // Verify no UPDATE orders or INSERT order_status_history was called
    const calls = mockPool.client.query.mock.calls.map((c) => String(c[0]).trim());
    expect(calls.filter((c) => c.includes('UPDATE orders'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('INSERT INTO order_status_history'))).toHaveLength(0);
  });

  it('STALE_PROVIDER_SNAPSHOT: provider sequence < local sequence', async () => {
    setupQueries({ status: 'captured', last_sequence: 5, amount: '100.00', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'authorized', sequence: 2 }),
    ]);

    expect(result.stale_provider_snapshots).toBe(1);
    expect(result.repaired).toBe(0);
    expect(result.details[0]!.action).toBe('STALE_PROVIDER_SNAPSHOT');
  });

  it('monetary comparison: "100" vs "100.00" matches as ALREADY_OK', async () => {
    setupQueries({ status: 'captured', last_sequence: 3, amount: '100', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN' }),
    ]);

    expect(result.already_ok).toBe(1);
    expect(result.details[0]!.action).toBe('ALREADY_OK');
  });

  it('ROLLBACK on intermediate error', async () => {
    const { client } = mockPool;
    client.query.mockImplementation(async (sql: string) => {
      const sqlStr = typeof sql === 'string' ? sql.trim() : '';
      if (sqlStr === 'BEGIN') return {};
      if (sqlStr === 'ROLLBACK') return {};
      if (sqlStr.includes('pg_advisory_xact_lock')) return {};
      if (sqlStr.includes('INSERT INTO reconciliation_runs')) {
        return { rows: [{ id: '1', started_at: new Date() }] };
      }
      if (sqlStr.includes('INSERT INTO orders')) {
        throw new Error('DB connection lost');
      }
      return { rows: [] };
    });

    await expect(
      repo.executeReconciliation([providerOrder()]),
    ).rejects.toThrow('DB connection lost');

    // Verify ROLLBACK was called
    const calls = client.query.mock.calls.map((c) => String(c[0]).trim());
    expect(calls).toContain('ROLLBACK');
  });

  it('advisory lock is acquired within transaction', async () => {
    setupQueries({ status: 'captured', last_sequence: 3, amount: '100.00', currency: 'MXN' });

    await repo.executeReconciliation([providerOrder()]);

    const calls = mockPool.client.query.mock.calls.map((c) => String(c[0]).trim());
    const beginIdx = calls.findIndex((c) => c === 'BEGIN');
    const lockIdx = calls.findIndex((c) => c.includes('pg_advisory_xact_lock'));
    const commitIdx = calls.findIndex((c) => c === 'COMMIT');

    expect(beginIdx).toBeLessThan(lockIdx);
    expect(lockIdx).toBeLessThan(commitIdx);
  });

  it('repeated reconciliation does not add second history entry', async () => {
    setupQueries({ status: 'captured', last_sequence: 3, amount: '100.00', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN' }),
    ]);

    expect(result.repaired).toBe(0);
    expect(result.already_ok).toBe(1);

    const calls = mockPool.client.query.mock.calls.map((c) => String(c[0]).trim());
    expect(calls.filter((c) => c.includes('INSERT INTO order_status_history'))).toHaveLength(0);
  });

  it('REPAIRED: equal sequence but different status', async () => {
    setupQueries({ status: 'authorized', last_sequence: 3, amount: '100.00', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3 }),
    ]);

    expect(result.repaired).toBe(1);
    expect(result.details[0]!.action).toBe('REPAIRED');
  });

  // ── New tests required by issue ──

  it('NULL amount vs "0.00" is a divergence (REPAIRED)', async () => {
    setupQueries({ status: 'captured', last_sequence: 3, amount: null, currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3, amount: '0.00', currency: 'MXN' }),
    ]);

    expect(result.repaired).toBe(1);
    expect(result.details[0]!.action).toBe('REPAIRED');
  });

  it('"000100.0" vs "100.00" is ALREADY_OK', async () => {
    setupQueries({ status: 'captured', last_sequence: 3, amount: '000100.0', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN' }),
    ]);

    expect(result.already_ok).toBe(1);
    expect(result.details[0]!.action).toBe('ALREADY_OK');
  });

  it('existing order pending/0/NULL is not classified as new', async () => {
    // Existing order with pending/0/NULL — INSERT RETURNING returns empty (existing)
    setupQueries({ status: 'pending', last_sequence: 0, amount: null, currency: null });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3 }),
    ]);

    expect(result.repaired).toBe(1);
    expect(result.details[0]!.action).toBe('REPAIRED');
    // Should have previous_status = 'pending' (not null) since order existed
    expect(result.details[0]!.local_status).toBe('pending');
  });

  it('INSERT RETURNING identifies a truly new order', async () => {
    setupQueries(null); // null = new order (RETURNING returns row)

    const result = await repo.executeReconciliation([
      providerOrder({ id: 'brand-new', status: 'captured', sequence: 3 }),
    ]);

    expect(result.details[0]!.local_status).toBeNull();
    expect(result.details[0]!.local_sequence).toBeNull();
  });

  it('details are inserted before marking run as COMPLETED', async () => {
    setupQueries({ status: 'authorized', last_sequence: 2, amount: '100.00', currency: 'MXN' });

    await repo.executeReconciliation([providerOrder()]);

    const calls = mockPool.client.query.mock.calls.map((c) => String(c[0]).trim());
    const detailInsertIdx = calls.findIndex((c) => c.includes('INSERT INTO reconciliation_details'));
    const completedIdx = calls.findIndex((c) => c.includes('UPDATE reconciliation_runs') && c.includes('COMPLETED'));

    expect(detailInsertIdx).toBeGreaterThan(-1);
    expect(completedIdx).toBeGreaterThan(-1);
    expect(detailInsertIdx).toBeLessThan(completedIdx);
  });

  it('second reconciliation with equivalent amounts does not generate UPDATE/history', async () => {
    // After first reconciliation repaired to 100.00, second run sees 100.00 = 100.00
    setupQueries({ status: 'captured', last_sequence: 3, amount: '100.00', currency: 'MXN' });

    const result = await repo.executeReconciliation([
      providerOrder({ status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN' }),
    ]);

    expect(result.repaired).toBe(0);
    expect(result.already_ok).toBe(1);

    const calls = mockPool.client.query.mock.calls.map((c) => String(c[0]).trim());
    expect(calls.filter((c) => c.includes('UPDATE orders'))).toHaveLength(0);
    expect(calls.filter((c) => c.includes('INSERT INTO order_status_history'))).toHaveLength(0);
  });
});

describe('normalizeAmount', () => {
  it('NULL remains NULL', () => {
    expect(normalizeAmount(null)).toBeNull();
    expect(normalizeAmount(undefined)).toBeNull();
  });

  it('normalizes various formats to canonical 2-decimal', () => {
    expect(normalizeAmount('100')).toBe('100.00');
    expect(normalizeAmount('100.0')).toBe('100.00');
    expect(normalizeAmount('000100.00')).toBe('100.00');
    expect(normalizeAmount('0')).toBe('0.00');
    expect(normalizeAmount('0.10')).toBe('0.10');
    expect(normalizeAmount('00042.5')).toBe('42.50');
  });

  it('empty string returns NULL', () => {
    expect(normalizeAmount('')).toBeNull();
    expect(normalizeAmount('  ')).toBeNull();
  });
});
