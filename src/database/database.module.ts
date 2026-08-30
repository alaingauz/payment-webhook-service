import {
  Module,
  Global,
  OnApplicationShutdown,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';

const { Pool } = pg;

export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          host: config.get<string>('database.host'),
          port: config.get<number>('database.port'),
          user: config.get<string>('database.user'),
          password: config.get<string>('database.password'),
          database: config.get<string>('database.database'),
          max: config.get<number>('database.max'),
        });

        pool.on('error', (err) => {
          Logger.error('Unexpected PG pool error', err.stack, 'DatabaseModule');
        });

        return pool;
      },
      inject: [ConfigService],
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: InstanceType<typeof Pool>) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing PG pool…');
    await this.pool.end();
    this.logger.log('PG pool closed');
  }
}
