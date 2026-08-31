import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ReconciliationService,
  ReconciliationProviderError,
  ReconciliationDatabaseError,
} from './reconciliation.service.js';
import {
  ProviderClient,
  ProviderTimeoutError,
  ProviderHttpError,
  ProviderPayloadError,
} from '../provider/provider-client.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import type { ReconciliationRunResult } from './reconciliation.repository.js';
import { StructuredLogger } from '../logging/structured-logger.js';

function makeProviderClient(overrides: Partial<ProviderClient> = {}): ProviderClient {
  return {
    fetchSnapshot: vi.fn(),
    ...overrides,
  } as unknown as ProviderClient;
}

function makeRepo(overrides: Partial<ReconciliationRepository> = {}): ReconciliationRepository {
  return {
    executeReconciliation: vi.fn(),
    ...overrides,
  } as unknown as ReconciliationRepository;
}

function completedRun(overrides: Partial<ReconciliationRunResult> = {}): ReconciliationRunResult {
  return {
    run_id: '1',
    status: 'COMPLETED',
    orders_checked: 4,
    divergences: 3,
    repaired: 2,
    already_ok: 1,
    stale_provider_snapshots: 1,
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:00:01.000Z',
    details: [],
    ...overrides,
  };
}

describe('ReconciliationService', () => {
  let providerClient: ProviderClient;
  let repo: ReconciliationRepository;
  let service: ReconciliationService;

  beforeEach(() => {
    providerClient = makeProviderClient();
    repo = makeRepo();
    const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), setService: vi.fn() } as unknown as StructuredLogger;
    service = new ReconciliationService(providerClient, repo, mockLogger);
  });

  it('fetches snapshot before calling repository', async () => {
    const orders = [
      { id: 'o1', status: 'captured', sequence: 3, amount: '100.00', currency: 'MXN', updated_at: '' },
    ];
    vi.spyOn(providerClient, 'fetchSnapshot').mockResolvedValue({
      generated_at: '', orders,
    });
    vi.spyOn(repo, 'executeReconciliation').mockResolvedValue(completedRun());

    await service.reconcile();

    expect(providerClient.fetchSnapshot).toHaveBeenCalledOnce();
    expect(repo.executeReconciliation).toHaveBeenCalledWith(orders);
  });

  it('ProviderClient is NOT invoked inside the transaction (called before repo)', async () => {
    const callOrder: string[] = [];
    vi.spyOn(providerClient, 'fetchSnapshot').mockImplementation(async () => {
      callOrder.push('fetchSnapshot');
      return { generated_at: '', orders: [] };
    });
    vi.spyOn(repo, 'executeReconciliation').mockImplementation(async () => {
      callOrder.push('executeReconciliation');
      return completedRun({ orders_checked: 0, divergences: 0, repaired: 0, already_ok: 0, stale_provider_snapshots: 0 });
    });

    await service.reconcile();
    expect(callOrder).toEqual(['fetchSnapshot', 'executeReconciliation']);
  });

  it('wraps ProviderTimeoutError as ReconciliationProviderError', async () => {
    vi.spyOn(providerClient, 'fetchSnapshot').mockRejectedValue(
      new ProviderTimeoutError('timeout'),
    );

    await expect(service.reconcile()).rejects.toThrow(ReconciliationProviderError);
    expect(repo.executeReconciliation).not.toHaveBeenCalled();
  });

  it('wraps ProviderHttpError as ReconciliationProviderError', async () => {
    vi.spyOn(providerClient, 'fetchSnapshot').mockRejectedValue(
      new ProviderHttpError('500', 500),
    );

    await expect(service.reconcile()).rejects.toThrow(ReconciliationProviderError);
  });

  it('wraps ProviderPayloadError as ReconciliationProviderError', async () => {
    vi.spyOn(providerClient, 'fetchSnapshot').mockRejectedValue(
      new ProviderPayloadError('bad payload'),
    );

    await expect(service.reconcile()).rejects.toThrow(ReconciliationProviderError);
  });

  it('wraps DB error as ReconciliationDatabaseError', async () => {
    vi.spyOn(providerClient, 'fetchSnapshot').mockResolvedValue({
      generated_at: '', orders: [],
    });
    vi.spyOn(repo, 'executeReconciliation').mockRejectedValue(
      new Error('connection lost'),
    );

    await expect(service.reconcile()).rejects.toThrow(ReconciliationDatabaseError);
  });

  it('returns completed run result on success', async () => {
    vi.spyOn(providerClient, 'fetchSnapshot').mockResolvedValue({
      generated_at: '', orders: [],
    });
    const expected = completedRun();
    vi.spyOn(repo, 'executeReconciliation').mockResolvedValue(expected);

    const result = await service.reconcile();
    expect(result).toEqual(expected);
  });
});
