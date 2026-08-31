import { Module } from '@nestjs/common';
import { ProviderModule } from '../provider/provider.module.js';
import { DlqController } from './dlq.controller.js';
import { DlqRepository } from './dlq.repository.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [ProviderModule],
  controllers: [DlqController, ReconciliationController],
  providers: [DlqRepository, ReconciliationRepository, ReconciliationService],
})
export class AdminModule {}
