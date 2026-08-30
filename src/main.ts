import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { WorkerAppModule } from './worker/worker-app.module.js';

async function bootstrap() {
  const mode = process.env['MODE'] ?? 'api';

  if (mode === 'api') {
    const app = await NestFactory.create(AppModule, { rawBody: true });
    app.enableShutdownHooks();
    const port = process.env['PORT'] ?? 3000;
    await app.listen(port);
  } else if (mode === 'worker') {
    const app = await NestFactory.createApplicationContext(WorkerAppModule);
    app.enableShutdownHooks();
  } else {
    console.error(`Unknown MODE: ${mode}. Use "api" or "worker".`);
    process.exit(1);
  }
}

await bootstrap();
