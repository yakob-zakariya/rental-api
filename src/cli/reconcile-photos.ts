// Runs one public-photo reconciliation pass now (T4.4): `npm run photos:reconcile`. The same pass
// the hourly job runs; useful after an incident. Safe while the API is running (only one pass
// runs at a time).
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PublicPhotoReconciliation } from '../modules/listings/public-photo-reconciliation.service.js';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const summary = await app.get(PublicPhotoReconciliation).runOnce();
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
