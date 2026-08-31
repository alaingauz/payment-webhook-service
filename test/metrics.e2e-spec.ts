import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { WorkerAppModule } from './../src/worker/worker-app.module.js';
import { PG_POOL } from './../src/database/database.module.js';
import { MetricsModule } from './../src/metrics/metrics.module.js';

describe('GET /metrics (e2e)', () => {
  let app: INestApplication<App>;

  const metricsRow = {
    events_received: '25',
    duplicate_events: '3',
    out_of_order_events: '1',
    dlq_size: '2',
    ingest_latency_p95: '8.75',
    processing_latency_p95: '120.5',
  };

  const mockPool = {
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn(),
  };

  beforeAll(() => {
    process.env['WEBHOOK_SECRET'] = 'test-secret';
  });

  afterAll(() => {
    delete process.env['WEBHOOK_SECRET'];
  });

  beforeEach(async () => {
    mockPool.query.mockReset();

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

  it('should return 200 with Prometheus format', async () => {
    mockPool.query.mockResolvedValue({ rows: [metricsRow] });

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-type']).toContain('version=0.0.4');

    const body = res.text;

    expect(body).toContain('# HELP webhook_events_received_total');
    expect(body).toContain('# TYPE webhook_events_received_total counter');
    expect(body).toContain('webhook_events_received_total 25');

    expect(body).toContain('# HELP webhook_duplicate_events_total');
    expect(body).toContain('# TYPE webhook_duplicate_events_total counter');
    expect(body).toContain('webhook_duplicate_events_total 3');

    expect(body).toContain('# HELP webhook_out_of_order_events_total');
    expect(body).toContain('# TYPE webhook_out_of_order_events_total counter');
    expect(body).toContain('webhook_out_of_order_events_total 1');

    expect(body).toContain('# HELP webhook_dlq_size');
    expect(body).toContain('# TYPE webhook_dlq_size gauge');
    expect(body).toContain('webhook_dlq_size 2');

    expect(body).toContain('# HELP webhook_ingest_latency_p95_ms');
    expect(body).toContain('# TYPE webhook_ingest_latency_p95_ms gauge');
    expect(body).toContain('webhook_ingest_latency_p95_ms 8.75');

    expect(body).toContain('# HELP webhook_processing_latency_p95_ms');
    expect(body).toContain('# TYPE webhook_processing_latency_p95_ms gauge');
    expect(body).toContain('webhook_processing_latency_p95_ms 120.5');
  });

  it('should return expected values with pool mock', async () => {
    mockPool.query.mockResolvedValue({ rows: [metricsRow] });

    const res = await request(app.getHttpServer())
      .get('/metrics')
      .expect(200);

    expect(res.text).toContain('webhook_events_received_total 25');
    expect(res.text).toContain('webhook_dlq_size 2');
  });

  it('should return 503 when DB is unavailable', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    await request(app.getHttpServer())
      .get('/metrics')
      .expect(503);
  });
});

describe('MetricsModule isolation', () => {
  it('MetricsModule should not be loaded in WorkerAppModule', () => {
    const workerImports = Reflect.getMetadata('imports', WorkerAppModule) || [];
    const hasMetrics = workerImports.some(
      (mod: unknown) => mod === MetricsModule,
    );
    expect(hasMetrics).toBe(false);
  });
});
