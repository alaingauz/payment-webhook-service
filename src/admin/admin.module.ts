import { Module } from '@nestjs/common';
import { DlqController } from './dlq.controller.js';
import { DlqRepository } from './dlq.repository.js';

@Module({
  controllers: [DlqController],
  providers: [DlqRepository],
})
export class AdminModule {}
