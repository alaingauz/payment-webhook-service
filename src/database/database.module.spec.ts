import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule, PG_POOL } from './database.module.js';
import { databaseConfig } from '../config/database.config.js';

const mockPool = {
  on: vi.fn(),
  end: vi.fn().mockResolvedValue(undefined),
};

vi.mock('pg', () => {
  const MockPool = function () {
    return mockPool;
  };
  return {
    default: { Pool: MockPool },
  };
});

describe('DatabaseModule', () => {
  let module: TestingModule;

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should provide PG_POOL token via DatabaseModule', async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig],
        }),
        DatabaseModule,
      ],
    }).compile();

    const pool = module.get(PG_POOL);
    expect(pool).toBeDefined();
    expect(pool).toBe(mockPool);
  });

  it('should close the pool on application shutdown', async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig],
        }),
        DatabaseModule,
      ],
    }).compile();

    await module.close();

    expect(mockPool.end).toHaveBeenCalled();
  });

  it('should export PG_POOL constant as a string token', () => {
    expect(PG_POOL).toBe('PG_POOL');
  });
});
