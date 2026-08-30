import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerConfig } from '../config/worker.config.js';
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
  ) {
    const wc = this.config.get<WorkerConfig>('worker')!;
    this.pollIntervalMs = wc.pollIntervalMs;
    this.errorDelayMs = wc.errorDelayMs;
    this.workerId = `worker-${process.pid}`;
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
        this.logger.error(`Worker [${this.workerId}] error: ${(err as Error).message}`, (err as Error).stack);
        if (this.shutdownRequested) return;
        setTimeout(() => this.runLoop(), this.errorDelayMs);
      });
  }

  private async tick(): Promise<boolean> {
    const result = await this.repository.processOne();

    if (result.found) {
      this.logger.log(
        `[${this.workerId}] event_id=${result.event_id} order_id=${result.order_id} ` +
        `sequence=${result.sequence} outcome=${result.outcome} ` +
        `outcome_reason=${result.outcome_reason ?? 'null'} ` +
        `attempt_count=${result.attempt_count ?? 0} ` +
        `correlation_id=${result.correlation_id}`,
      );
    }

    return result.found;
  }
}
