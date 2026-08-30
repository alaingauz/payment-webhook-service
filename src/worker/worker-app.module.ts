import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { databaseConfig } from '../config/database.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { WorkerModule } from './worker.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
    }),
    DatabaseModule,
    WorkerModule,
  ],
})
export class WorkerAppModule {}
