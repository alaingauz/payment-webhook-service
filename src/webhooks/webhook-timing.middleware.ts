import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Response, NextFunction } from 'express';
import type { WebhookRequest } from './types/webhook-request.js';

@Injectable()
export class WebhookTimingMiddleware implements NestMiddleware {
  use(req: WebhookRequest, _res: Response, next: NextFunction): void {
    req.webhookStartTime = performance.now();
    req.webhookReceivedAt = new Date();
    next();
  }
}
