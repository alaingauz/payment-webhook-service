import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class WebhookSignatureService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('WEBHOOK_SECRET');
  }

  verify(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return false;
    }

    // Accept both hex and sha256=hex formats
    let hex: string;
    if (signatureHeader.startsWith('sha256=')) {
      hex = signatureHeader.slice(7);
    } else {
      hex = signatureHeader;
    }

    // Validate hex format and length before timingSafeEqual
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      return false;
    }

    const expected = createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex');

    const a = Buffer.from(hex, 'hex');
    const b = Buffer.from(expected, 'hex');

    return timingSafeEqual(a, b);
  }
}
