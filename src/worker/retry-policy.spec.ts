import { describe, it, expect } from 'vitest';
import { RetryPolicy } from './retry-policy.js';

describe('RetryPolicy', () => {
  const BASE = 500;
  const MAX = 30000;
  const MAX_ATTEMPTS = 5;

  it('attempt 1 uses cap = BASE', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX, () => 1);
    const result = policy.evaluate(0);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      // cap = min(30000, 500 * 2^0) = 500; delay = floor(1 * 500) = 500
      expect(result.delayMs).toBe(BASE);
      expect(result.attemptCount).toBe(1);
    }
  });

  it('attempt 2 uses cap = BASE*2', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX, () => 1);
    const result = policy.evaluate(1);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      // cap = min(30000, 500 * 2^1) = 1000
      expect(result.delayMs).toBe(BASE * 2);
      expect(result.attemptCount).toBe(2);
    }
  });

  it('attempt 3 uses cap = BASE*4', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX, () => 1);
    const result = policy.evaluate(2);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      // cap = min(30000, 500 * 2^2) = 2000
      expect(result.delayMs).toBe(BASE * 4);
      expect(result.attemptCount).toBe(3);
    }
  });

  it('respects MAX_DELAY', () => {
    const lowMax = 600;
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, lowMax, () => 1);
    const result = policy.evaluate(2);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      // cap = min(600, 500 * 4) = 600
      expect(result.delayMs).toBe(lowMax);
    }
  });

  it('full jitter with controlled random value', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX, () => 0.5);
    const result = policy.evaluate(0);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      // cap = 500; delay = floor(0.5 * 500) = 250
      expect(result.delayMs).toBe(250);
    }
  });

  it('full jitter with random = 0 produces delay = 0', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX, () => 0);
    const result = policy.evaluate(0);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      expect(result.delayMs).toBe(0);
    }
  });

  it('attempt >= maxAttempts produces DLQ', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX);
    // currentAttemptCount = 4 -> newAttemptCount = 5 >= 5
    const result = policy.evaluate(4);
    expect(result.isDlq).toBe(true);
    expect(result.attemptCount).toBe(5);
  });

  it('attempt > maxAttempts also produces DLQ', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX);
    const result = policy.evaluate(10);
    expect(result.isDlq).toBe(true);
    expect(result.attemptCount).toBe(11);
  });

  it('maxAttempts = 1 sends to DLQ on first failure', () => {
    const policy = new RetryPolicy(1, BASE, MAX);
    const result = policy.evaluate(0);
    expect(result.isDlq).toBe(true);
    expect(result.attemptCount).toBe(1);
  });

  it('sets next_attempt_at based on now + delay', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX, () => 0.5);
    const result = policy.evaluate(0, now);
    expect(result.isDlq).toBe(false);
    if (!result.isDlq) {
      expect(result.nextAttemptAt.getTime()).toBe(now.getTime() + 250);
    }
  });

  it('DLQ result does not have nextAttemptAt', () => {
    const policy = new RetryPolicy(MAX_ATTEMPTS, BASE, MAX);
    const result = policy.evaluate(4);
    expect(result.isDlq).toBe(true);
    expect('nextAttemptAt' in result).toBe(false);
  });
});
