import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { WorkerAppModule } from './worker-app.module.js';
import { PG_POOL } from '../database/database.module.js';
import { WorkerLoopService } from './worker-loop.service.js';

const mockPool = {
  query: vi.fn(),
  connect: vi.fn(),
  on: vi.fn(),
  end: vi.fn(),
};

describe('Module isolation', () => {
  it('AppModule does not contain WorkerLoopService', async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret';

    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(mockPool)
      .compile();

    let workerLoop: WorkerLoopService | undefined;
    try {
      workerLoop = module.get(WorkerLoopService, { strict: false });
    } catch {
      workerLoop = undefined;
    }
    expect(workerLoop).toBeUndefined();

    await module.close();
    delete process.env['WEBHOOK_SECRET'];
  });

  it('WorkerAppModule does not create HTTP server', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerAppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(mockPool)
      .compile();

    // WorkerAppModule has no controllers, so no HTTP server
    const controllers = Reflect.getMetadata('controllers', WorkerAppModule);
    expect(controllers).toBeUndefined();

    await module.close();
  });
});
