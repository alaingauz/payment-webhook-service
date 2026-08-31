import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaymentWebhookDataDto } from './payment-webhook.dto.js';

async function validateAmount(amount: unknown): Promise<boolean> {
  const dto = plainToInstance(PaymentWebhookDataDto, { amount });
  const errors = await validate(dto);
  return errors.length === 0;
}

describe('PaymentWebhookDataDto amount validation', () => {
  it('"0.00" is valid', async () => {
    expect(await validateAmount('0.00')).toBe(true);
  });

  it('"1000.00" is valid', async () => {
    expect(await validateAmount('1000.00')).toBe(true);
  });

  it('"9999999999.99" is valid (10 integer digits)', async () => {
    expect(await validateAmount('9999999999.99')).toBe(true);
  });

  it('"01.00" is invalid (leading zero)', async () => {
    expect(await validateAmount('01.00')).toBe(false);
  });

  it('"10.0" is invalid (only 1 decimal)', async () => {
    expect(await validateAmount('10.0')).toBe(false);
  });

  it('"10.000" is invalid (3 decimals)', async () => {
    expect(await validateAmount('10.000')).toBe(false);
  });

  it('"-10.00" is invalid (negative)', async () => {
    expect(await validateAmount('-10.00')).toBe(false);
  });

  it('"1e3" is invalid (scientific notation)', async () => {
    expect(await validateAmount('1e3')).toBe(false);
  });

  it('number 1000 is invalid (JSON number, not string)', async () => {
    expect(await validateAmount(1000)).toBe(false);
  });

  it('"99999999999.99" is invalid (11 integer digits)', async () => {
    expect(await validateAmount('99999999999.99')).toBe(false);
  });

  it('undefined is valid (amount is optional)', async () => {
    expect(await validateAmount(undefined)).toBe(true);
  });
});
