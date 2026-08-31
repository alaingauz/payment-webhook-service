import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StructuredLogger } from './structured-logger.js';

function getJsonCalls(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0] as string)
    .filter((s) => typeof s === 'string' && s.startsWith('{'))
    .map((s) => JSON.parse(s.trim()) as Record<string, unknown>);
}

describe('StructuredLogger', () => {
  let logger: StructuredLogger;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new StructuredLogger();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should produce valid JSON on info', () => {
    logger.info('test.event', { key: 'value' });
    const entries = getJsonCalls(stdoutSpy);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const parsed = entries[0]!;
    expect(parsed.event).toBe('test.event');
    expect(parsed.level).toBe('info');
    expect(parsed.service).toBe('api');
    expect(parsed.key).toBe('value');
    expect(parsed.timestamp).toBeDefined();
  });

  it('should write info to stdout and error to stderr', () => {
    logger.info('info.event');
    const infoEntries = getJsonCalls(stdoutSpy);
    expect(infoEntries.some((e) => e.event === 'info.event')).toBe(true);

    logger.error('error.event');
    const errorEntries = getJsonCalls(stderrSpy);
    expect(errorEntries.some((e) => e.event === 'error.event')).toBe(true);
  });

  it('should not allow overriding protected fields (timestamp, level, service, event)', () => {
    logger.info('real.event', {
      timestamp: 'HACKED',
      level: 'HACKED',
      service: 'HACKED',
      event: 'HACKED',
    });
    const entries = getJsonCalls(stdoutSpy);
    const parsed = entries.find((e) => e.event === 'real.event')!;
    expect(parsed).toBeDefined();
    expect(parsed.event).toBe('real.event');
    expect(parsed.level).toBe('info');
    expect(parsed.service).toBe('api');
    expect(parsed.timestamp).not.toBe('HACKED');
  });

  it('should handle undefined values without failing', () => {
    logger.info('test.event', {
      some_field: undefined,
      other_field: 'ok',
    });
    const entries = getJsonCalls(stdoutSpy);
    const parsed = entries.find((e) => e.event === 'test.event')!;
    expect(parsed).toBeDefined();
    expect(parsed.other_field).toBe('ok');
    expect(parsed).not.toHaveProperty('some_field');
  });

  it('should serialize Error safely without payloads or secrets', () => {
    const err = new Error('Connection failed password=abc123 at host');
    logger.error('test.error', { error: err });
    const entries = getJsonCalls(stderrSpy);
    const parsed = entries.find((e) => e.event === 'test.error')!;
    expect(parsed).toBeDefined();
    expect(parsed.error_name).toBe('Error');
    expect(parsed.error_message).toContain('[REDACTED]');
    expect(parsed.error_message as string).not.toContain('abc123');
    expect(parsed).not.toHaveProperty('error');
    expect(parsed).not.toHaveProperty('stack');
  });

  it('should filter out forbidden keys (payload, rawBody, secret, etc.)', () => {
    logger.info('test.event', {
      rawBody: 'SENSITIVE',
      payload: { data: 'SENSITIVE' },
      'x-signature': 'SENSITIVE',
      webhook_secret: 'SENSITIVE',
      password: 'SENSITIVE',
      correlation_id: 'safe-value',
    });
    const entries = getJsonCalls(stdoutSpy);
    const parsed = entries.find((e) => e.event === 'test.event')!;
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty('rawBody');
    expect(parsed).not.toHaveProperty('payload');
    expect(parsed).not.toHaveProperty('x-signature');
    expect(parsed).not.toHaveProperty('webhook_secret');
    expect(parsed).not.toHaveProperty('password');
    expect(parsed.correlation_id).toBe('safe-value');
  });

  it('should use the configured service name', () => {
    logger.setService('worker');
    logger.info('test.event');
    const entries = getJsonCalls(stdoutSpy);
    const parsed = entries.find((e) => e.event === 'test.event')!;
    expect(parsed).toBeDefined();
    expect(parsed.service).toBe('worker');
  });

  it('should not throw if write fails', () => {
    stdoutSpy.mockImplementation(() => {
      throw new Error('write failed');
    });
    expect(() => logger.info('test.event')).not.toThrow();
  });

  it('should produce warn level on warn()', () => {
    logger.warn('test.warn');
    const entries = getJsonCalls(stdoutSpy);
    const parsed = entries.find((e) => e.event === 'test.warn')!;
    expect(parsed).toBeDefined();
    expect(parsed.level).toBe('warn');
  });
});
