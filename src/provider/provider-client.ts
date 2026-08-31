import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const VALID_STATUSES = new Set(['pending', 'authorized', 'captured', 'refunded', 'failed']);
const CURRENCY_REGEX = /^[A-Z]{3}$/;
// NUMERIC(12,2): up to 10 integer digits, up to 2 decimal digits, no negative
const AMOUNT_REGEX = /^\d{1,10}(\.\d{1,2})?$/;

export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export class ProviderPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderPayloadError';
  }
}

export interface ProviderOrder {
  id: string;
  status: string;
  sequence: number;
  amount: string;
  currency: string;
  updated_at: string;
}

export interface ProviderSnapshot {
  generated_at: string;
  orders: ProviderOrder[];
}

function isValidIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

@Injectable()
export class ProviderClient {
  private readonly logger = new Logger(ProviderClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    const rawUrl = this.config.get<string>('PROVIDER_BASE_URL', 'http://localhost:4000');
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('not HTTP');
      }
      this.baseUrl = rawUrl;
    } catch {
      throw new Error(`PROVIDER_BASE_URL must be a valid HTTP URL, got: ${rawUrl}`);
    }

    const rawTimeout = this.config.get<string>('PROVIDER_TIMEOUT_MS', '5000');
    const timeout = parseInt(rawTimeout, 10);
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error(`PROVIDER_TIMEOUT_MS must be a positive integer, got: ${rawTimeout}`);
    }
    this.timeoutMs = timeout;
  }

  async fetchSnapshot(): Promise<ProviderSnapshot> {
    const url = `${this.baseUrl}/provider/orders`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ProviderTimeoutError(`Provider request timed out after ${this.timeoutMs}ms`);
      }
      throw new ProviderHttpError(`Provider request failed: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ProviderHttpError(
        `Provider returned HTTP ${response.status}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderPayloadError('Provider returned invalid JSON');
    }

    return this.validate(body);
  }

  private validate(body: unknown): ProviderSnapshot {
    if (!body || typeof body !== 'object') {
      throw new ProviderPayloadError('Provider payload is not an object');
    }

    const data = body as Record<string, unknown>;

    // generated_at: mandatory valid ISO date
    if (!isValidIsoDate(data['generated_at'])) {
      throw new ProviderPayloadError('Provider payload has invalid or missing generated_at');
    }

    if (!Array.isArray(data['orders'])) {
      throw new ProviderPayloadError('Provider payload missing orders array');
    }

    const orders = data['orders'] as unknown[];
    const seenIds = new Set<string>();
    const validated: ProviderOrder[] = [];

    for (let i = 0; i < orders.length; i++) {
      const raw = orders[i];
      if (!raw || typeof raw !== 'object') {
        throw new ProviderPayloadError(`Order at index ${i} is not an object`);
      }
      const o = raw as Record<string, unknown>;

      // id: string, 1-255 chars, no leading/trailing spaces
      const id = o['id'];
      if (typeof id !== 'string' || id.length === 0 || id.length > 255) {
        throw new ProviderPayloadError(`Order at index ${i} has invalid id length`);
      }
      if (id !== id.trim()) {
        throw new ProviderPayloadError(`Order at index ${i} has id with leading/trailing spaces`);
      }

      // status
      const status = o['status'];
      if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
        throw new ProviderPayloadError(`Order ${id} has invalid status: ${String(status)}`);
      }

      // sequence: integer between 0 and 2147483647
      const sequence = o['sequence'];
      if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0 || sequence > 2147483647) {
        throw new ProviderPayloadError(`Order ${id} has invalid sequence: ${String(sequence)}`);
      }

      // amount: string matching NUMERIC(12,2) — non-negative, max 10 integer + 2 decimal
      const amount = o['amount'];
      if (typeof amount !== 'string' || !AMOUNT_REGEX.test(amount)) {
        throw new ProviderPayloadError(`Order ${id} has invalid amount: ${String(amount)}`);
      }

      // currency: exactly 3 uppercase letters
      const currency = o['currency'];
      if (typeof currency !== 'string' || !CURRENCY_REGEX.test(currency)) {
        throw new ProviderPayloadError(`Order ${id} has invalid currency: ${String(currency)}`);
      }

      // updated_at: mandatory valid ISO date
      if (!isValidIsoDate(o['updated_at'])) {
        throw new ProviderPayloadError(`Order ${id} has invalid or missing updated_at`);
      }

      // Duplicate check (after validation/normalization)
      if (seenIds.has(id)) {
        throw new ProviderPayloadError(`Duplicate order id: ${id}`);
      }
      seenIds.add(id);

      validated.push({
        id,
        status,
        sequence,
        amount,
        currency,
        updated_at: o['updated_at'] as string,
      });
    }

    this.logger.log(`Fetched provider snapshot with ${validated.length} orders`);

    return {
      generated_at: data['generated_at'] as string,
      orders: validated,
    };
  }
}
