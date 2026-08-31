import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerConfig } from '../config/worker.config.js';
import { StructuredLogger } from '../logging/structured-logger.js';
import { resolveWorkerId } from './resolve-worker-id.js';
import { WorkerRepository } from './worker.repository.js';

@Injectable()
export class WorkerLoopService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLoopService.name);
  private readonly pollIntervalMs: number;
  private readonly errorDelayMs: number;
  private shutdownRequested = false;
  private activePromise: Promise<void> | null = null;
  private workerId: string;

  constructor(
    private readonly repository: WorkerRepository,
    private readonly config: ConfigService,
    private readonly structuredLogger: StructuredLogger,
  ) {
    const wc = this.config.get<WorkerConfig>('worker')!;
    this.pollIntervalMs = wc.pollIntervalMs;
    this.errorDelayMs = wc.errorDelayMs;
    this.workerId = resolveWorkerId();
    this.structuredLogger.setService('worker');
  }

  onApplicationBootstrap(): void {
    this.logger.log(`Starting worker loop [${this.workerId}] poll=${this.pollIntervalMs}ms error=${this.errorDelayMs}ms`);
    this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log(`Shutdown requested for [${this.workerId}], waiting for active transaction…`);
    this.shutdownRequested = true;
    if (this.activePromise) {
      await this.activePromise;
    }
    this.logger.log(`Worker [${this.workerId}] stopped`);
  }

  private runLoop(): void {
    if (this.shutdownRequested) return;

    this.activePromise = this.tick()
      .then((found) => {
        this.activePromise = null;
        if (this.shutdownRequested) return;
        if (found) {
          // Work found, poll immediately
          this.runLoop();
        } else {
          // No work, wait before polling again
          setTimeout(() => this.runLoop(), this.pollIntervalMs);
        }
      })
      .catch((err) => {
        this.activePromise = null;
        this.structuredLogger.error('worker.loop_error', {
          worker_id: this.workerId,
          error_message: err instanceof Error ? err.message.replace(/password[^\s]*/gi, '[REDACTED]').replace(/secret[^\s]*/gi, '[REDACTED]') : String(err),
        });
        if (this.shutdownRequested) return;
        setTimeout(() => this.runLoop(), this.errorDelayMs);
      });
  }

  private async tick(): Promise<boolean> {
    const result = await this.repository.processOne((claimed) => {
      this.structuredLogger.info('worker.processing_started', {
        worker_id: this.workerId,
        event_id: claimed.event_id,
        order_id: claimed.order_id,
        correlation_id: claimed.correlation_id,
        sequence: claimed.sequence,
      });
    });

    if (result.found) {
      const baseFields = {
        worker_id: this.workerId,
        event_id: result.event_id,
        order_id: result.order_id,
        correlation_id: result.correlation_id,
        sequence: result.sequence,
      };

      if (result.outcome === 'APPLIED' || result.outcome === 'IGNORED') {
        this.structuredLogger.info('worker.processing_completed', {
          ...baseFields,
          outcome: result.outcome,
          outcome_reason: result.outcome_reason ?? undefined,
        });
      } else if (result.outcome === 'RETRY_SCHEDULED') {
        this.structuredLogger.warn('worker.retry_scheduled', {
          ...baseFields,
          attempt_count: result.attempt_count,
          next_attempt_at: result.next_attempt_at?.toISOString() ?? undefined,
        });
      } else if (result.outcome === 'DLQ') {
        this.structuredLogger.error('worker.moved_to_dlq', {
          ...baseFields,
          attempt_count: result.attempt_count,
        });
      }
    }

    return result.found;
  }
}
