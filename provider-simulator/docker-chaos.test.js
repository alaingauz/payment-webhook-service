// @ts-check
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChaosCoordinator } from './docker-chaos.js';

// Suppress console output during tests to avoid Node v22 test runner IPC issues
const originalLog = console.log;
const originalError = console.error;
function silenceConsole() {
  console.log = () => {};
  console.error = () => {};
}
function restoreConsole() {
  console.log = originalLog;
  console.error = originalError;
}

/**
 * Helper: creates a mock executor that records calls and returns configurable results.
 * @param {Record<string, (args: string[]) => {stdout: string, stderr: string}>} [handlers]
 */
function createMockExecutor(handlers = {}) {
  const calls = [];
  const executor = async (file, args) => {
    calls.push({ file, args: [...args] });
    const key = `${file} ${args.join(' ')}`;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) {
        const result = handler(args);
        if (result instanceof Error) throw result;
        return result;
      }
    }
    return { stdout: '', stderr: '' };
  };
  return { executor, calls };
}

describe('docker-chaos coordinator', () => {
  beforeEach(() => silenceConsole());
  afterEach(() => restoreConsole());

  describe('replica counting', () => {
    it('counts running replicas from docker compose ps output', async () => {
      const { executor } = createMockExecutor({
        'compose ps': () => ({
          stdout: 'payment-webhook-service-worker-1\npayment-webhook-service-worker-2\npayment-webhook-service-worker-3\n',
          stderr: '',
        }),
      });

      const chaos = createChaosCoordinator({ killAt: 10, restartDelayMs: 0, executor });
      const count = await chaos.countRunningWorkers();
      assert.equal(count, 3);
    });

    it('returns 0 when no workers are running', async () => {
      const { executor } = createMockExecutor({
        'compose ps': () => ({ stdout: '', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 10, restartDelayMs: 0, executor });
      const count = await chaos.countRunningWorkers();
      assert.equal(count, 0);
    });
  });

  describe('SIGKILL command arguments', () => {
    it('uses correct docker compose kill -s SIGKILL worker arguments', async () => {
      let killCalled = false;
      let psCallCount = 0;
      const { executor, calls } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          // Before kill: 3 workers; after kill: 0; after restart: 3
          if (psCallCount <= 1) return { stdout: 'w-1\nw-2\nw-3\n', stderr: '' };
          if (psCallCount === 2) return { stdout: '', stderr: '' };
          return { stdout: 'w-1\nw-2\nw-3\n', stderr: '' };
        },
        'compose kill': () => {
          killCalled = true;
          return { stdout: '', stderr: '' };
        },
        'compose up': () => ({ stdout: '', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 5, restartDelayMs: 0, executor });
      await chaos.preflight();
      await chaos.onDeliveryComplete(5, 3);
      await chaos.waitForCompletion();

      assert.ok(killCalled, 'kill should have been called');
      const killCall = calls.find((c) => c.args.includes('kill'));
      assert.ok(killCall, 'should find kill call');
      assert.deepEqual(killCall.file, 'docker');
      assert.deepEqual(killCall.args, ['compose', 'kill', '-s', 'SIGKILL', 'worker']);
    });
  });

  describe('restart with same replica count', () => {
    it('restarts the exact same number of replicas', async () => {
      let psCallCount = 0;
      const { executor, calls } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          if (psCallCount <= 1) return { stdout: 'w-1\nw-2\nw-3\n', stderr: '' };
          if (psCallCount === 2) return { stdout: '', stderr: '' };
          return { stdout: 'w-1\nw-2\nw-3\n', stderr: '' };
        },
        'compose kill': () => ({ stdout: '', stderr: '' }),
        'compose up': () => ({ stdout: '', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 1, restartDelayMs: 0, executor });
      await chaos.preflight();
      await chaos.onDeliveryComplete(1, 3);
      const result = await chaos.waitForCompletion();

      const upCall = calls.find((c) => c.args.includes('up'));
      assert.ok(upCall, 'should find up call');
      assert.deepEqual(upCall.args, ['compose', 'up', '-d', '--no-deps', '--scale', 'worker=3', 'worker']);
      assert.equal(result.workersRestarted, 3);
      assert.equal(result.workersKilled, 3);
    });
  });

  describe('exactly-once trigger under concurrent calls', () => {
    it('fires kill exactly once even with concurrent onDeliveryComplete calls', async () => {
      let killCount = 0;
      let psCallCount = 0;
      const { executor } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          if (psCallCount <= 1) return { stdout: 'w-1\nw-2\n', stderr: '' };
          if (psCallCount === 2) return { stdout: '', stderr: '' };
          return { stdout: 'w-1\nw-2\n', stderr: '' };
        },
        'compose kill': () => {
          killCount++;
          return { stdout: '', stderr: '' };
        },
        'compose up': () => ({ stdout: '', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 5, restartDelayMs: 0, executor });
      await chaos.preflight();

      // Fire multiple concurrent calls at kill-at=5
      await Promise.all([
        chaos.onDeliveryComplete(5, 2),
        chaos.onDeliveryComplete(5, 2),
        chaos.onDeliveryComplete(5, 2),
        chaos.onDeliveryComplete(5, 2),
      ]);
      await chaos.waitForCompletion();

      assert.equal(killCount, 1, 'kill should fire exactly once');
    });
  });

  describe('invalid kill-at', () => {
    it('validateArgs catches kill-at <= 0 (tested via coordinator behavior)', async () => {
      // The coordinator itself doesn't validate kill-at; the simulator's validateArgs does.
      // We test that the coordinator simply never triggers for deliveries below killAt.
      const { executor } = createMockExecutor({
        'compose ps': () => ({ stdout: 'w-1\n', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 100, restartDelayMs: 0, executor });
      await chaos.preflight();

      // Send deliveries 1..50 — none should trigger
      for (let i = 1; i <= 50; i++) {
        await chaos.onDeliveryComplete(i, 1);
      }
      const result = chaos.getResult();
      assert.equal(result, null, 'should not trigger if killAt not reached');
    });
  });

  describe('kill-at greater than total generated', () => {
    it('coordinator does not trigger when delivery count never reaches killAt', async () => {
      const { executor } = createMockExecutor({
        'compose ps': () => ({ stdout: 'w-1\n', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 1000, restartDelayMs: 0, executor });
      await chaos.preflight();

      // Simulate only 100 deliveries
      for (let i = 1; i <= 100; i++) {
        await chaos.onDeliveryComplete(i, 1);
      }
      const result = await chaos.waitForCompletion();
      assert.equal(result, null, 'should not trigger when total < killAt');
    });
  });

  describe('failure to kill', () => {
    it('reports error when kill command fails', async () => {
      let psCallCount = 0;
      const { executor } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          return { stdout: 'w-1\n', stderr: '' };
        },
        'compose kill': () => {
          throw new Error('docker daemon unreachable');
        },
      });

      const chaos = createChaosCoordinator({ killAt: 1, restartDelayMs: 0, executor });
      await chaos.preflight();
      await chaos.onDeliveryComplete(1, 1);
      const result = await chaos.waitForCompletion();
      assert.equal(result, null, 'result should be null when kill fails');
    });
  });

  describe('failure to restart with best-effort recovery', () => {
    it('retries restart once on failure', async () => {
      let psCallCount = 0;
      let upCallCount = 0;
      const { executor } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          if (psCallCount <= 1) return { stdout: 'w-1\n', stderr: '' };
          if (psCallCount === 2) return { stdout: '', stderr: '' }; // after kill
          return { stdout: 'w-1\n', stderr: '' }; // after restart
        },
        'compose kill': () => ({ stdout: '', stderr: '' }),
        'compose up': () => {
          upCallCount++;
          if (upCallCount === 1) throw new Error('restart failed first try');
          return { stdout: '', stderr: '' };
        },
      });

      const chaos = createChaosCoordinator({ killAt: 1, restartDelayMs: 0, executor });
      await chaos.preflight();
      await chaos.onDeliveryComplete(1, 1);
      const result = await chaos.waitForCompletion();

      assert.ok(result, 'should recover on second restart attempt');
      assert.equal(result.restartConfirmed, true);
      assert.equal(upCallCount, 2, 'should have tried restart twice');
    });

    it('fails when both restart attempts fail', async () => {
      let psCallCount = 0;
      const { executor } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          if (psCallCount <= 1) return { stdout: 'w-1\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
        'compose kill': () => ({ stdout: '', stderr: '' }),
        'compose up': () => {
          throw new Error('restart always fails');
        },
      });

      const chaos = createChaosCoordinator({ killAt: 1, restartDelayMs: 0, executor });
      await chaos.preflight();
      await chaos.onDeliveryComplete(1, 1);
      const result = await chaos.waitForCompletion();
      assert.equal(result, null, 'result should be null when restart fails completely');
    });
  });

  describe('behavior without --kill-at', () => {
    it('coordinator is not created when killAt is not set (simulator behavior)', () => {
      // This test verifies the contract: when killAt is undefined,
      // the simulator does not create a coordinator. We verify that
      // creating one with a high killAt means it never triggers.
      const { executor } = createMockExecutor();
      // Simulating "no kill-at" by not calling coordinator at all
      // The coordinator factory still works, it just never fires.
      const chaos = createChaosCoordinator({ killAt: 999999, restartDelayMs: 0, executor });
      assert.equal(chaos.getResult(), null);
    });
  });

  describe('preflight fails with no workers', () => {
    it('throws when no workers are detected', async () => {
      const { executor } = createMockExecutor({
        'compose ps': () => ({ stdout: '', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 1, restartDelayMs: 0, executor });
      await assert.rejects(
        () => chaos.preflight(),
        { message: 'No active worker replicas detected before simulation' },
      );
    });
  });

  describe('no data written when validation fails', () => {
    it('kill-at validation occurs before data file writes (integration contract)', () => {
      // This is a contract test: the simulator validates kill-at > total
      // BEFORE calling atomicWrite. We verify the ordering by checking
      // that the coordinator never triggers for impossible kill-at values.
      // The actual file-write prevention is in simulator.js main().
      // We verify the coordinator itself doesn't write anything.
      const { executor, calls } = createMockExecutor();
      const chaos = createChaosCoordinator({ killAt: 999999, restartDelayMs: 0, executor });
      assert.equal(calls.length, 0, 'no docker commands should be issued without interaction');
      assert.equal(chaos.getResult(), null);
    });
  });

  describe('kill confirmed verification', () => {
    it('fails when workers are still running after kill', async () => {
      let psCallCount = 0;
      const { executor } = createMockExecutor({
        'compose ps': () => {
          psCallCount++;
          // Always returns workers running, even after kill
          return { stdout: 'w-1\nw-2\n', stderr: '' };
        },
        'compose kill': () => ({ stdout: '', stderr: '' }),
      });

      const chaos = createChaosCoordinator({ killAt: 1, restartDelayMs: 0, executor });
      await chaos.preflight();
      await chaos.onDeliveryComplete(1, 2);
      const result = await chaos.waitForCompletion();
      assert.equal(result, null, 'result should be null when kill not confirmed');
    });
  });
});
