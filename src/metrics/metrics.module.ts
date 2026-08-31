import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller.js';
import { MetricsRepository } from './metrics.repository.js';

@Module({
  controllers: [MetricsController],
  providers: [MetricsRepository],
})
export class MetricsModule {}
