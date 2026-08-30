import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerConfig } from '../config/worker.config.js';
import { PaymentEventProcessor } from './payment-event-processor.js';
import { RetryPolicy } from './retry-policy.js';
import { WorkerLoopService } from './worker-loop.service.js';
import { WorkerRepository } from './worker.repository.js';

@Module({
  providers: [
    WorkerLoopService,
    WorkerRepository,
    PaymentEventProcessor,
    {
      provide: RetryPolicy,
      useFactory: (config: ConfigService) => {
        const wc = config.get<WorkerConfig>('worker')!;
        return new RetryPolicy(wc.maxAttempts, wc.retryBaseMs, wc.retryMaxMs);
      },
      inject: [ConfigService],
    },
  ],
})
export class WorkerModule {}
