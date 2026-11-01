// Development only: `npm run dev:reset-verifications`. Deletes all verification data and resets
// every user to not_verified, so the sandbox's one fake identity can be approved again (see
// docs/manual-testing.md). Refuses unless NODE_ENV=development and the database name doesn't end
// in _prod, shows what it will delete, and asks you to type "reset".
import { createInterface } from 'node:readline/promises';
// Importing the data source loads .env first (process.loadEnvFile), so NODE_ENV below is .env's.
import dataSource from '../database/data-source.js';
import {
  assertResetAllowed,
  countResettable,
  describeCounts,
  isConfirmed,
  resetVerifications,
} from './reset-verifications.lib.js';

async function main(): Promise<void> {
  // The raw value, not validateEnv's: a missing NODE_ENV must refuse, not default.
  const nodeEnv = process.env.NODE_ENV;
  // Checked before connecting (with the name in DATABASE_URL), then again with the name Postgres
  // reports.
  assertResetAllowed({
    nodeEnv,
    databaseName: new URL(
      process.env.DATABASE_URL ?? 'postgres://x/',
    ).pathname.slice(1),
  });

  await dataSource.initialize();
  try {
    const [{ name }] = await dataSource.query<{ name: string }[]>(
      'SELECT current_database() AS name',
    );
    assertResetAllowed({ nodeEnv, databaseName: name });

    console.log(`Database "${name}". This will delete:`);
    console.log(describeCounts(await countResettable(dataSource.manager)));
    console.log(
      'Kept: users and their status, sign-in sessions, staff accounts, admin_actions.',
    );

    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await prompt.question('Type "reset" to continue: ');
    prompt.close();
    if (!isConfirmed(answer)) {
      console.log('Aborted; nothing changed.');
      return;
    }

    const removed = await dataSource.transaction((manager) =>
      resetVerifications(manager),
    );
    console.log('Done. Removed:');
    console.log(describeCounts(removed));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
