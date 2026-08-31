/**
 * Resolves a unique worker identifier with the following priority:
 * 1. WORKER_ID environment variable (if non-empty)
 * 2. HOSTNAME environment variable (if non-empty, unique per Docker container)
 * 3. worker-${process.pid} as final fallback
 */
export function resolveWorkerId(
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
): string {
  const workerId = env['WORKER_ID'];
  if (workerId && workerId.trim().length > 0) {
    return workerId.trim();
  }

  const hostname = env['HOSTNAME'];
  if (hostname && hostname.trim().length > 0) {
    return hostname.trim();
  }

  return `worker-${pid}`;
}
