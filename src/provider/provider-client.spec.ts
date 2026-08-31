import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  ProviderClient,
  ProviderTimeoutError,
  ProviderHttpError,
  ProviderPayloadError,
} from './provider-client.js';

function makeConfigService(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    PROVIDER_BASE_URL: 'http://localhost:4000',
    PROVIDER_TIMEOUT_MS: '5000',
    ...overrides,
  };
  return {
    get: (key: string, fallback?: string) => defaults[key] ?? fallback,
  } as unknown as ConfigService;
}

function validSnapshot() {
  return {
    generated_at: '2026-01-01T00:00:00Z',
    orders: [
      {
        id: 'order-1',
        status: 'captured',
        sequence: 3,
        amount: '100.00',
        currency: 'MXN',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'order-2',
        status: 'failed',
        sequence: 2,
        amount: '50.50',
        currency: 'USD',
        updated_at: '2026-01-01T00:00:01Z',
      },
    ],
  };
}

describe('ProviderClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns validated snapshot on success', async () => {
    const snapshot = validSnapshot();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    const result = await client.fetchSnapshot();

    expect(result.orders).toHaveLength(2);
    expect(result.orders[0]!.id).toBe('order-1');
    expect(result.orders[0]!.status).toBe('captured');
    expect(result.orders[0]!.sequence).toBe(3);
    expect(result.orders[0]!.amount).toBe('100.00');
    expect(result.generated_at).toBe('2026-01-01T00:00:00Z');
  });

  it('throws ProviderTimeoutError on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, opts) => {
      const signal = (opts as RequestInit).signal!;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const client = new ProviderClient(
      makeConfigService({ PROVIDER_TIMEOUT_MS: '50' }),
    );
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderTimeoutError);
  });

  it('throws ProviderHttpError on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 500 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderHttpError);
  });

  it('throws ProviderPayloadError on invalid JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json at all', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws ProviderPayloadError on invalid status', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.status = 'UNKNOWN';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws ProviderPayloadError on invalid sequence', async () => {
    const snapshot = validSnapshot();
    (snapshot.orders[0] as Record<string, unknown>).sequence = -1;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws ProviderPayloadError on duplicate order ids', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[1]!.id = 'order-1'; // duplicate
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws ProviderPayloadError on empty order id', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.id = '';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws ProviderPayloadError on invalid amount', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.amount = 'abc';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  // ── New stricter validation tests ──

  it('throws on lowercase currency', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.currency = 'mxn';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on currency with numbers', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.currency = 'M3X';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on amount exceeding NUMERIC(12,2)', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.amount = '12345678901.00'; // 11 integer digits
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on amount with 3 decimal places', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.amount = '100.123';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on missing updated_at', async () => {
    const snapshot = validSnapshot();
    delete (snapshot.orders[0] as Record<string, unknown>)['updated_at'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on invalid updated_at', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.updated_at = 'not-a-date';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on invalid generated_at', async () => {
    const snapshot = validSnapshot();
    (snapshot as Record<string, unknown>).generated_at = 'not-a-date';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on missing generated_at', async () => {
    const snapshot = validSnapshot();
    delete (snapshot as Record<string, unknown>)['generated_at'];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on id with leading/trailing spaces', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.id = ' order-1 ';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on id longer than 255 characters', async () => {
    const snapshot = validSnapshot();
    snapshot.orders[0]!.id = 'x'.repeat(256);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on sequence exceeding 2147483647', async () => {
    const snapshot = validSnapshot();
    (snapshot.orders[0] as Record<string, unknown>).sequence = 2147483648;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    const client = new ProviderClient(makeConfigService());
    await expect(client.fetchSnapshot()).rejects.toThrow(ProviderPayloadError);
  });

  it('throws on invalid PROVIDER_TIMEOUT_MS', () => {
    expect(() => new ProviderClient(makeConfigService({ PROVIDER_TIMEOUT_MS: 'abc' }))).toThrow(
      /PROVIDER_TIMEOUT_MS/,
    );
  });

  it('throws on invalid PROVIDER_BASE_URL', () => {
    expect(() => new ProviderClient(makeConfigService({ PROVIDER_BASE_URL: 'ftp://bad' }))).toThrow(
      /PROVIDER_BASE_URL/,
    );
  });
});
