import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WorkerLoopService } from './worker-loop.service.js';
import { WorkerRepository } from './worker.repository.js';

describe('WorkerLoopService', () => {
  let service: WorkerLoopService;
  let mockRepository: { processOne: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.useFakeTimers();

    mockRepository = {
      processOne: vi.fn().mockResolvedValue({ found: false }),
    };

    const mockConfig = {
      get: vi.fn((key: string) => {
        if (key === 'worker') return {
          pollIntervalMs: 50,
          errorDelayMs: 100,
          maxAttempts: 5,
          retryBaseMs: 500,
          retryMaxMs: 30000,
        };
        return undefined;
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        WorkerLoopService,
        { provide: WorkerRepository, useValue: mockRepository },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get(WorkerLoopService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits poll interval when no work found', async () => {
    mockRepository.processOne.mockResolvedValue({ found: false });

    service.onApplicationBootstrap();

    // Let the first tick resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(1);

    // Should wait poll interval before next tick
    await vi.advanceTimersByTimeAsync(50);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(2);
  });

  it('polls immediately when work is found', async () => {
    mockRepository.processOne
      .mockResolvedValueOnce({ found: true, event_id: 'evt-1', order_id: 'o-1', outcome: 'APPLIED', outcome_reason: null, correlation_id: 'c-1', sequence: 1 })
      .mockResolvedValue({ found: false });

    service.onApplicationBootstrap();

    // First tick resolves with work found
    await vi.advanceTimersByTimeAsync(0);
    // Second tick should happen immediately (no wait)
    await vi.advanceTimersByTimeAsync(0);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(2);
  });

  it('continues after error with error delay', async () => {
    mockRepository.processOne
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValue({ found: false });

    service.onApplicationBootstrap();

    // Let the first tick fail
    await vi.advanceTimersByTimeAsync(0);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(1);

    // Should wait error delay
    await vi.advanceTimersByTimeAsync(100);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(2);
  });

  it('stops loop on shutdown', async () => {
    mockRepository.processOne.mockResolvedValue({ found: false });

    service.onApplicationBootstrap();

    // Let one tick complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(1);

    // Trigger shutdown
    await service.onApplicationShutdown();

    // Advance timers - should not poll again
    await vi.advanceTimersByTimeAsync(200);

    expect(mockRepository.processOne).toHaveBeenCalledTimes(1);
  });

  it('waits for active transaction during shutdown', async () => {
    let resolveProcess: () => void;
    const processPromise = new Promise<{ found: boolean }>((resolve) => {
      resolveProcess = () => resolve({ found: false });
    });

    mockRepository.processOne.mockReturnValueOnce(processPromise);

    service.onApplicationBootstrap();

    // Start shutdown while transaction is active
    const shutdownPromise = service.onApplicationShutdown();

    // Resolve the active transaction
    resolveProcess!();
    await shutdownPromise;

    // Should have completed cleanly
    expect(mockRepository.processOne).toHaveBeenCalledTimes(1);
  });
});
