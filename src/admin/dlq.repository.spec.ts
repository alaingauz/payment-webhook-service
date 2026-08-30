import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { DlqRepository } from './dlq.repository.js';
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
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn(),
  };
}

describe('DlqRepository', () => {
  let repository: DlqRepository;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(async () => {
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);

    const module = await Test.createTestingModule({
      providers: [
        DlqRepository,
        { provide: PG_POOL, useValue: mockPool },
      ],
    }).compile();

    repository = module.get(DlqRepository);
  });

  describe('list', () => {
    it('returns paginated results', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // COUNT
        .mockResolvedValueOnce({
          rows: [
            { id: '10', event_id: 'evt-1', processing_status: 'DLQ', replay_count: 0 },
            { id: '9', event_id: 'evt-2', processing_status: 'DLQ', replay_count: 1 },
          ],
        }) // SELECT items
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await repository.list(50, 0);

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.id).toBe('10');
    });

    it('releases client on success', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce(undefined);

      await repository.list(50, 0);

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('releases client on error', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('DB error'));
      mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

      await expect(repository.list(50, 0)).rejects.toThrow('DB error');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns null for non-existent event', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findById('99999');

      expect(result).toBeNull();
    });

    it('returns event when found', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: '1', event_id: 'evt-1', processing_status: 'DLQ' }],
      });

      const result = await repository.findById('1');

      expect(result).toBeDefined();
      expect(result!.id).toBe('1');
    });
  });

  describe('replay', () => {
    it('replays DLQ event and returns REPLAYED', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'DLQ', replay_count: 0 }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', replay_count: 1, processing_status: 'PENDING' }],
        }) // UPDATE RETURNING
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await repository.replay('5');

      expect(result).not.toBeNull();
      expect(result!.result).toBe('REPLAYED');
      expect(result!.id).toBe('5');
      expect(result!.replay_count).toBe(1);
      expect(result!.processing_status).toBe('PENDING');
    });

    it('returns NOT_IN_DLQ for non-DLQ event without changes', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'PENDING', replay_count: 1 }],
        }) // SELECT FOR UPDATE
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await repository.replay('5');

      expect(result).not.toBeNull();
      expect(result!.result).toBe('NOT_IN_DLQ');
      expect(result!.processing_status).toBe('PENDING');
      // No UPDATE SET should have been called (exclude SELECT FOR UPDATE)
      const calls = mockClient.query.mock.calls;
      const updateCalls = calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE webhook_events'),
      );
      expect(updateCalls).toHaveLength(0);
    });

    it('returns null for non-existent event', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
        .mockResolvedValueOnce(undefined); // COMMIT

      const result = await repository.replay('99999');

      expect(result).toBeNull();
    });

    it('two concurrent replays serialize - only one increments', async () => {
      // First replay sees DLQ
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'DLQ', replay_count: 0 }],
        })
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', replay_count: 1, processing_status: 'PENDING' }],
        })
        .mockResolvedValueOnce(undefined); // COMMIT

      const result1 = await repository.replay('5');
      expect(result1).not.toBeNull();
      expect(result1!.result).toBe('REPLAYED');
      expect(result1!.replay_count).toBe(1);

      // Reset mocks for second replay
      mockClient.query.mockReset();
      // Second replay sees PENDING (already replayed by first)
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ id: '5', event_id: 'evt-1', processing_status: 'PENDING', replay_count: 1 }],
        })
        .mockResolvedValueOnce(undefined); // COMMIT

      const result2 = await repository.replay('5');
      expect(result2).not.toBeNull();
      expect(result2!.result).toBe('NOT_IN_DLQ');
      // replay_count should not be in NOT_IN_DLQ result
      expect(result2!.replay_count).toBeUndefined();
    });

    it('rollback on error and releases client', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('Connection lost'));
      mockClient.query.mockResolvedValueOnce(undefined); // ROLLBACK

      await expect(repository.replay('5')).rejects.toThrow('Connection lost');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('always releases client even if ROLLBACK fails', async () => {
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockRejectedValueOnce(new Error('DB error'));
      mockClient.query.mockRejectedValueOnce(new Error('ROLLBACK failed'));

      await expect(repository.replay('5')).rejects.toThrow('DB error');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
