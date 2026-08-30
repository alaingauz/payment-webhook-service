import {
  Controller,
  Get,
  Inject,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import pg from 'pg';
import { PG_POOL } from '../database/database.module.js';

const { Pool } = pg;

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1 AS ok');
      return {
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      };
    } catch {
      throw new HttpException(
        {
          status: 'error',
          database: 'disconnected',
          timestamp: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
