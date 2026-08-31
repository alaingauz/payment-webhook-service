import { Injectable, Logger } from '@nestjs/common';
import {
  ProviderClient,
  ProviderTimeoutError,
  ProviderHttpError,
  ProviderPayloadError,
} from '../provider/provider-client.js';
import type { ProviderOrder } from '../provider/provider-client.js';
import {
  ReconciliationRepository,
  type ReconciliationRunResult,
} from './reconciliation.repository.js';

export class ReconciliationProviderError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ReconciliationProviderError';
  }
}

export class ReconciliationDatabaseError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'ReconciliationDatabaseError';
  }
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly providerClient: ProviderClient,
    private readonly reconciliationRepository: ReconciliationRepository,
  ) {}

  async reconcile(): Promise<ReconciliationRunResult> {
    // 1. Fetch snapshot BEFORE opening any transaction
    let providerOrders: ProviderOrder[];
    try {
      const snapshot = await this.providerClient.fetchSnapshot();
      providerOrders = snapshot.orders;
    } catch (err) {
      if (
        err instanceof ProviderTimeoutError ||
        err instanceof ProviderHttpError ||
        err instanceof ProviderPayloadError
      ) {
        this.logger.error(`Provider error: ${(err as Error).message}`);
        throw new ReconciliationProviderError(
          `Failed to fetch provider snapshot: ${(err as Error).message}`,
          err,
        );
      }
      throw err;
    }

    this.logger.log(`Starting reconciliation with ${providerOrders.length} provider orders`);

    // 2-7. Execute reconciliation within transaction
    try {
      return await this.reconciliationRepository.executeReconciliation(providerOrders);
    } catch (err) {
      this.logger.error(`Database error during reconciliation: ${(err as Error).message}`);
      throw new ReconciliationDatabaseError(
        `Reconciliation failed: ${(err as Error).message}`,
        err as Error,
      );
    }
  }
}
