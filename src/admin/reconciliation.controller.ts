import { Controller, Post, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import {
  ReconciliationService,
  ReconciliationProviderError,
  ReconciliationDatabaseError,
} from './reconciliation.service.js';
import type { ReconciliationRunResult } from './reconciliation.repository.js';
import { HttpException } from '@nestjs/common';

@Controller('admin')
export class ReconciliationController {
  private readonly logger = new Logger(ReconciliationController.name);

  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async reconcile(): Promise<ReconciliationRunResult> {
    try {
      return await this.reconciliationService.reconcile();
    } catch (err) {
      if (err instanceof ReconciliationProviderError) {
        this.logger.error(`Provider error during reconciliation: ${err.message}`);
        throw new HttpException(
          { error: 'Bad Gateway', message: 'Provider unavailable or returned invalid data' },
          HttpStatus.BAD_GATEWAY,
        );
      }
      if (err instanceof ReconciliationDatabaseError) {
        this.logger.error(`Database error during reconciliation: ${err.message}`);
        throw new HttpException(
          { error: 'Service Unavailable', message: 'Reconciliation temporarily unavailable' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw err;
    }
  }
}
