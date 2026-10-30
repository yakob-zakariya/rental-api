// Entry point for the TypeORM migration CLI (see the migration:* scripts), which always runs the
// compiled dist/database/data-source.js. The app does not import this file — it builds the same
// connection options through DatabaseModule.
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation.js';
import { buildDataSourceOptions } from './data-source.options.js';

// Outside Nest nothing loads .env for us. Variables already set in the shell take precedence,
// matching @nestjs/config; a missing .env is fine when the environment provides everything.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

// Globs are relative to this compiled file and match .js only, which skips the .d.ts files tsc
// writes alongside.
const root = join(import.meta.dirname, '..');

export default new DataSource({
  ...buildDataSourceOptions(validateEnv(process.env)),
  entities: [join(root, '**', '*.entity.js')],
  migrations: [join(root, 'database', 'migrations', '*.js')],
});
