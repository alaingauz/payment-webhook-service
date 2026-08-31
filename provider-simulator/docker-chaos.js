// @ts-check
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

/**
 * @typedef {object} ChaosOpts
 * @property {number} killAt - delivery index at which to kill workers
 * @property {number} restartDelayMs - ms to wait before restarting
 * @property {(file: string, args: string[]) => Promise<{stdout: string, stderr: string}>} [executor] - injectable executor
 */

/**
 * @typedef {object} ChaosResult
 * @property {number} killedAt - delivery index when kill was triggered
 * @property {number} workersKilled - number of workers stopped
 * @property {boolean} killConfirmed - whether kill was confirmed
 * @property {number} downTimeMs - time workers were down
 * @property {number} workersRestarted - number of workers restarted
 * @property {boolean} restartConfirmed - whether restart was confirmed
 * @property {boolean} burstContinued - whether burst continued during downtime
 */

/**
 * Creates a chaos coordinator for sudden death testing.
 * @param {ChaosOpts} opts
 */
export function createChaosCoordinator(opts) {
  const exec = opts.executor || ((file, args) => execFileAsync(file, args));
  let triggered = false;
  let triggerPromise = null;

  /** @type {ChaosResult | null} */
  let result = null;

  /**
   * Counts running worker replicas.
   * @returns {Promise<number>}
   */
  async function countRunningWorkers() {
    const { stdout } = await exec('docker', [
      'compose', 'ps', '--status', 'running', '--format', '{{.Name}}', 'worker',
    ]);
    const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
    return lines.length;
  }

  /**
   * Pre-flight check: ensure workers are running before sending events.
   * @returns {Promise<number>} number of running workers
   */
  async function preflight() {
    const count = await countRunningWorkers();
    if (count === 0) {
      throw new Error('No active worker replicas detected before simulation');
    }
    return count;
  }

  /**
   * Kills all workers with SIGKILL, waits, then restarts the same number.
   * Must only execute once even under concurrent calls.
   * @param {number} deliveryIndex - current delivery index
   * @param {number} replicaCount - number of replicas to restore
   * @returns {Promise<ChaosResult>}
   */
  async function executeKill(deliveryIndex, replicaCount) {
    const downStart = Date.now();

    // Kill workers with SIGKILL
    await exec('docker', ['compose', 'kill', '-s', 'SIGKILL', 'worker']);

    // Confirm workers are not running
    const afterKill = await countRunningWorkers();
    if (afterKill > 0) {
      throw new Error(`Kill failed: ${afterKill} workers still running after SIGKILL`);
    }

    console.log(`  ☠ SIGKILL confirmed: ${replicaCount} workers killed at delivery #${deliveryIndex}`);

    // Wait restart delay
    await new Promise((r) => setTimeout(r, opts.restartDelayMs));

    // Restart workers
    try {
      await exec('docker', [
        'compose', 'up', '-d', '--no-deps', '--scale', `worker=${replicaCount}`, 'worker',
      ]);
    } catch (restartErr) {
      // Best-effort recovery: try once more
      console.error('  ⚠ First restart attempt failed, retrying...');
      try {
        await exec('docker', [
          'compose', 'up', '-d', '--no-deps', '--scale', `worker=${replicaCount}`, 'worker',
        ]);
      } catch {
        throw new Error(`Failed to restart workers after best-effort recovery: ${restartErr.message}`);
      }
    }

    // Wait for workers to be running (poll up to 30s)
    const restartDeadline = Date.now() + 30000;
    let runningCount = 0;
    while (Date.now() < restartDeadline) {
      runningCount = await countRunningWorkers();
      if (runningCount >= replicaCount) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (runningCount < replicaCount) {
      throw new Error(`Restart failed: only ${runningCount}/${replicaCount} workers running`);
    }

    const downTimeMs = Date.now() - downStart;

    console.log(`  ✓ ${runningCount} workers restarted after ${downTimeMs}ms downtime`);

    result = {
      killedAt: deliveryIndex,
      workersKilled: replicaCount,
      killConfirmed: true,
      downTimeMs,
      workersRestarted: runningCount,
      restartConfirmed: true,
      burstContinued: true,
    };

    return result;
  }

  /**
   * Called after each completed HTTP delivery.
   * Triggers kill exactly once when deliveryCount reaches killAt.
   * @param {number} deliveryCount - number of completed deliveries so far
   * @param {number} replicaCount - original number of worker replicas
   * @returns {Promise<void>}
   */
  async function onDeliveryComplete(deliveryCount, replicaCount) {
    if (deliveryCount !== opts.killAt) return;
    if (triggered) return;
    triggered = true;

    console.log(`\n  ⚡ Kill triggered at delivery #${deliveryCount}`);
    triggerPromise = executeKill(deliveryCount, replicaCount);
    // Don't await - let the burst continue
    triggerPromise.catch((err) => {
      console.error(`  ✗ Chaos execution failed: ${err.message}`);
    });
  }

  /**
   * Wait for the chaos cycle to complete (if triggered).
   * @returns {Promise<ChaosResult | null>}
   */
  async function waitForCompletion() {
    if (triggerPromise) {
      try {
        await triggerPromise;
      } catch {
        // Error already logged
      }
    }
    return result;
  }

  /**
   * @returns {ChaosResult | null}
   */
  function getResult() {
    return result;
  }

  return {
    preflight,
    countRunningWorkers,
    onDeliveryComplete,
    waitForCompletion,
    getResult,
  };
}
