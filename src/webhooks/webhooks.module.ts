import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { WebhookIngestionService } from './webhook-ingestion.service.js';
import { WebhookIngestionRepository } from './webhook-ingestion.repository.js';
import { WebhookSignatureService } from './webhook-signature.service.js';
import { WebhookTimingMiddleware } from './webhook-timing.middleware.js';

@Module({
  controllers: [WebhooksController],
  providers: [
    WebhookIngestionService,
    WebhookIngestionRepository,
    WebhookSignatureService,
  ],
})
export class WebhooksModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(WebhookTimingMiddleware)
      .forRoutes(WebhooksController);
  }
}
