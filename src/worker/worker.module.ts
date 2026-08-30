import { Module } from '@nestjs/common';
import { WorkerLoopService } from './worker-loop.service.js';
import { WorkerRepository } from './worker.repository.js';
import { PaymentEventProcessor } from './payment-event-processor.js';

@Module({
  providers: [WorkerLoopService, WorkerRepository, PaymentEventProcessor],
})
export class WorkerModule {}
