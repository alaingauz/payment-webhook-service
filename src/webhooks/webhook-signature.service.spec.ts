import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { WebhookSignatureService } from './webhook-signature.service.js';

const SECRET = 'test-secret';

function makeSignature(body: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeConfigService(secret?: string) {
  return {
    getOrThrow: (key: string) => {
      if (key === 'WEBHOOK_SECRET') {
        if (secret === undefined) {
          throw new Error(`Configuration key "${key}" does not exist`);
        }
        return secret;
      }
      throw new Error(`Unknown key: ${key}`);
    },
  } as any;
}

describe('WebhookSignatureService', () => {
  let service: WebhookSignatureService;

  beforeEach(() => {
    service = new WebhookSignatureService(makeConfigService(SECRET));
  });

  it('should accept a valid hex signature', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    const sig = makeSignature(body);
    expect(service.verify(body, sig)).toBe(true);
  });

  it('should accept a valid signature with sha256= prefix', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    const sig = `sha256=${makeSignature(body)}`;
    expect(service.verify(body, sig)).toBe(true);
  });

  it('should reject an invalid signature', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    const sig = 'a'.repeat(64);
    expect(service.verify(body, sig)).toBe(false);
  });

  it('should reject a signature with incorrect length', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    const sig = 'abcdef1234'; // too short
    expect(service.verify(body, sig)).toBe(false);
  });

  it('should reject when body was altered after signing', () => {
    const originalBody = Buffer.from('{"event_id":"evt-001"}');
    const sig = makeSignature(originalBody);
    const alteredBody = Buffer.from('{"event_id":"evt-002"}');
    expect(service.verify(alteredBody, sig)).toBe(false);
  });

  it('should reject when signature header is undefined', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    expect(service.verify(body, undefined)).toBe(false);
  });

  it('should reject when signature header is empty string', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    expect(service.verify(body, '')).toBe(false);
  });

  it('should reject non-hex characters in signature', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    const sig = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    expect(service.verify(body, sig)).toBe(false);
  });

  it('should reject sha256= prefix with wrong length hex', () => {
    const body = Buffer.from('{"event_id":"evt-001"}');
    const sig = 'sha256=abcdef';
    expect(service.verify(body, sig)).toBe(false);
  });

  it('should throw when WEBHOOK_SECRET is absent', () => {
    expect(() => new WebhookSignatureService(makeConfigService(undefined))).toThrow(
      /does not exist/,
    );
  });
});
