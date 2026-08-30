import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { PG_POOL } from '../database/database.module.js';

describe('HealthController', () => {
  let controller: HealthController;

  const mockPool = {
    query: vi.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PG_POOL, useValue: mockPool }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return 200 with ok status when database is connected', async () => {
    mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });

    const result = await controller.check();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('connected');
    expect(result.timestamp).toBeDefined();
    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1 AS ok');
  });

  it('should throw 503 when database query fails', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    try {
      await controller.check();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const response = (error as HttpException).getResponse() as Record<string, unknown>;
      expect(response.status).toBe('error');
      expect(response.database).toBe('disconnected');
      expect(response.timestamp).toBeDefined();
    }
  });

  it('should throw 503 when pool.query throws synchronously', async () => {
    mockPool.query.mockImplementation(() => {
      throw new Error('pool is ended');
    });

    try {
      await controller.check();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    }
  });
});
