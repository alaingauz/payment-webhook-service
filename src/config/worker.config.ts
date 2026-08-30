import { registerAs } from '@nestjs/config';

export interface WorkerConfig {
  pollIntervalMs: number;
  errorDelayMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export const workerConfig = registerAs('worker', (): WorkerConfig => {
  const pollIntervalMs = parseInt(process.env['WORKER_POLL_INTERVAL_MS'] ?? '100', 10);
  const errorDelayMs = parseInt(process.env['WORKER_ERROR_DELAY_MS'] ?? '500', 10);
  const maxAttempts = parseInt(process.env['WORKER_MAX_ATTEMPTS'] ?? '5', 10);
  const retryBaseMs = parseInt(process.env['WORKER_RETRY_BASE_MS'] ?? '500', 10);
  const retryMaxMs = parseInt(process.env['WORKER_RETRY_MAX_MS'] ?? '30000', 10);

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error(`Invalid WORKER_POLL_INTERVAL_MS: must be >= 1, got "${process.env['WORKER_POLL_INTERVAL_MS']}"`);
  }
  if (!Number.isFinite(errorDelayMs) || errorDelayMs < 1) {
    throw new Error(`Invalid WORKER_ERROR_DELAY_MS: must be >= 1, got "${process.env['WORKER_ERROR_DELAY_MS']}"`);
  }
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Invalid WORKER_MAX_ATTEMPTS: must be >= 1, got "${process.env['WORKER_MAX_ATTEMPTS']}"`);
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 1) {
    throw new Error(`Invalid WORKER_RETRY_BASE_MS: must be >= 1, got "${process.env['WORKER_RETRY_BASE_MS']}"`);
  }
  if (!Number.isFinite(retryMaxMs) || retryMaxMs < retryBaseMs) {
    throw new Error(`Invalid WORKER_RETRY_MAX_MS: must be >= WORKER_RETRY_BASE_MS (${retryBaseMs}), got "${process.env['WORKER_RETRY_MAX_MS']}"`);
  }

  return { pollIntervalMs, errorDelayMs, maxAttempts, retryBaseMs, retryMaxMs };
});
