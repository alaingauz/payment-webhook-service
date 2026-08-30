import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { PG_POOL } from './../src/database/database.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  const mockPool = {
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn(),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(mockPool)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('/health (GET) should return 200 when database is available', () => {
    mockPool.query.mockResolvedValue({ rows: [{ ok: 1 }] });

    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.database).toBe('connected');
        expect(res.body.timestamp).toBeDefined();
      });
  });

  it('/health (GET) should return 503 when database is unavailable', () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    return request(app.getHttpServer())
      .get('/health')
      .expect(503)
      .expect((res) => {
        expect(res.body.status).toBe('error');
        expect(res.body.database).toBe('disconnected');
        expect(res.body.timestamp).toBeDefined();
      });
  });
});
