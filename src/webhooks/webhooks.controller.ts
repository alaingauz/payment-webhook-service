import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StructuredLogger } from '../logging/structured-logger.js';
import { WebhookSignatureGuard } from './guards/webhook-signature.guard.js';
import { WebhookIngestionService } from './webhook-ingestion.service.js';
import { PaymentWebhookDto } from './dto/payment-webhook.dto.js';
import type { WebhookRequest } from './types/webhook-request.js';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly ingestionService: WebhookIngestionService,
    private readonly structuredLogger: StructuredLogger,
  ) {}

  @Post('payments')
  @UseGuards(WebhookSignatureGuard)
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false }))
  async receivePayment(
    @Body() _dto: PaymentWebhookDto,
    @Req() req: WebhookRequest,
    @Res() res: Response,
  ): Promise<void> {
    const receivedAt = req.webhookReceivedAt;

    // Resolve correlation_id — handle string or string[] safely, apply trim
    const rawHeader = req.headers['x-correlation-id'];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const trimmed = typeof headerValue === 'string' ? headerValue.trim() : '';
    const correlationId =
      trimmed.length > 0 && trimmed.length <= 128 ? trimmed : randomUUID();

    // Parse validated original payload from rawBody (preserves all fields)
    const validatedPayload = JSON.parse(req.rawBody.toString('utf-8')) as Record<string, unknown>;

    try {
      const result = await this.ingestionService.ingest(
        req.rawBody,
        validatedPayload,
        correlationId,
        receivedAt,
      );

      this.structuredLogger.info('webhook.ingested', {
        correlation_id: correlationId,
        event_id: result.event_id,
        order_id: validatedPayload['order_id'] as string,
        result: result.result,
      });

      res
        .status(HttpStatus.ACCEPTED)
        .header('X-Correlation-Id', correlationId)
        .json({
          event_id: result.event_id,
          result: result.result,
          correlation_id: correlationId,
          message: result.message,
        });
    } catch (err) {
      this.structuredLogger.error('webhook.ingestion_failed', {
        correlation_id: correlationId,
        event_id: validatedPayload['event_id'] as string | undefined,
        order_id: validatedPayload['order_id'] as string | undefined,
        error: err instanceof Error ? err : undefined,
      });
      res
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .header('X-Correlation-Id', correlationId)
        .json({
          error: 'Service temporarily unavailable',
          correlation_id: correlationId,
        });
    }
  }
}
