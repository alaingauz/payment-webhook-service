import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { databaseConfig } from '../config/database.config.js';
import { workerConfig } from '../config/worker.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { LoggingModule } from '../logging/logging.module.js';
import { WorkerModule } from './worker.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, workerConfig],
    }),
    DatabaseModule,
    LoggingModule,
    WorkerModule,
  ],
})
export class WorkerAppModule {}
