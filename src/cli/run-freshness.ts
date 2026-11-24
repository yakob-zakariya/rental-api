// Runs one freshness pass now (T6.3): `npm run listings:freshness`. The same pass the job runs
// every 15 minutes (checks, stale, stale notices, expiry), quiet hours included. Safe while the
// API is running (only one pass runs at a time).
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { FreshnessService } from '../modules/listings/freshness/freshness.service.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const summary = await app.get(FreshnessService).runOnce();
    if (summary.skipped)
      console.log('Another pass is running right now; nothing done.');
    else console.log(summary);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
