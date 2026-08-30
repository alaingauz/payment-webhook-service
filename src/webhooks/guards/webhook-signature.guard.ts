import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { WebhookRequest } from '../types/webhook-request.js';
import { WebhookSignatureService } from '../webhook-signature.service.js';

@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(private readonly signatureService: WebhookSignatureService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<WebhookRequest>();
    const rawBody = req.rawBody;

    if (!rawBody) {
      throw new UnauthorizedException('Missing raw body');
    }

    const signature = req.headers['x-signature'] as string | undefined;
    const valid = this.signatureService.verify(rawBody, signature);

    if (!valid) {
      throw new UnauthorizedException('Invalid signature');
    }

    return true;
  }
}
