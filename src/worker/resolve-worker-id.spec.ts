import { describe, it, expect } from 'vitest';
import { resolveWorkerId } from './resolve-worker-id.js';

describe('resolveWorkerId', () => {
  it('uses WORKER_ID when set', () => {
    const id = resolveWorkerId({ WORKER_ID: 'my-worker', HOSTNAME: 'host-abc' }, 99);
    expect(id).toBe('my-worker');
  });

  it('uses HOSTNAME when WORKER_ID is not set', () => {
    const id = resolveWorkerId({ HOSTNAME: 'container-xyz' }, 99);
    expect(id).toBe('container-xyz');
  });

  it('falls back to worker-${pid} when both are empty', () => {
    const id = resolveWorkerId({}, 42);
    expect(id).toBe('worker-42');
  });

  it('ignores empty/whitespace WORKER_ID', () => {
    const id = resolveWorkerId({ WORKER_ID: '  ', HOSTNAME: 'host-1' }, 1);
    expect(id).toBe('host-1');
  });

  it('ignores empty/whitespace HOSTNAME', () => {
    const id = resolveWorkerId({ WORKER_ID: '', HOSTNAME: '  ' }, 7);
    expect(id).toBe('worker-7');
  });

  it('trims WORKER_ID', () => {
    const id = resolveWorkerId({ WORKER_ID: ' trimmed-id ' }, 1);
    expect(id).toBe('trimmed-id');
  });
});
