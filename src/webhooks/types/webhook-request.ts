import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

export interface WebhookRequest extends RawBodyRequest<Request> {
  rawBody: Buffer;
  webhookReceivedAt: Date;
}
