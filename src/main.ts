import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const mode = process.env['MODE'] ?? 'api';

  if (mode === 'api') {
    const app = await NestFactory.create(AppModule);
    app.enableShutdownHooks();
    const port = process.env['PORT'] ?? 3000;
    await app.listen(port);
  } else if (mode === 'worker') {
    const app = await NestFactory.createApplicationContext(AppModule);
    app.enableShutdownHooks();
    // Worker processing will be added in a future phase
  } else {
    console.error(`Unknown MODE: ${mode}. Use "api" or "worker".`);
    process.exit(1);
  }
}

await bootstrap();
