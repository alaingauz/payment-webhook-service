export interface RetryDecision {
  attemptCount: number;
  delayMs: number;
  nextAttemptAt: Date;
  isDlq: false;
}

export interface DlqDecision {
  attemptCount: number;
  isDlq: true;
}

export type RetryOrDlq = RetryDecision | DlqDecision;

export class RetryPolicy {
  constructor(
    private readonly maxAttempts: number,
    private readonly baseDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly randomFn: () => number = Math.random,
  ) {}

  evaluate(currentAttemptCount: number, now: Date = new Date()): RetryOrDlq {
    const newAttemptCount = currentAttemptCount + 1;

    if (newAttemptCount >= this.maxAttempts) {
      return { attemptCount: newAttemptCount, isDlq: true };
    }

    const cap = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** (newAttemptCount - 1),
    );

    const delayMs = Math.floor(this.randomFn() * cap);

    const nextAttemptAt = new Date(now.getTime() + delayMs);

    return {
      attemptCount: newAttemptCount,
      delayMs,
      nextAttemptAt,
      isDlq: false,
    };
  }
}
