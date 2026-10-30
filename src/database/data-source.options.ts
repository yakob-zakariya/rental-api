import type { DataSourceOptions } from 'typeorm';
import type { EnvironmentVariables } from '../config/env.validation.js';

/**
 * Connection options shared by the app (DatabaseModule) and the migration CLI (data-source.ts).
 * Entities and migrations are added by each caller: the CLI finds them by glob in dist/, the app
 * registers entities through TypeOrmModule.forFeature and never loads migrations.
 */
export function buildDataSourceOptions(
  env: Pick<EnvironmentVariables, 'DATABASE_URL'>,
): DataSourceOptions {
  return {
    type: 'postgres',
    url: env.DATABASE_URL,
    // Hard rule 3: every schema change goes through a migration, and they are run explicitly.
    synchronize: false,
    migrationsRun: false,
    // Extensions are created only by migrations, never implicitly on connect. With pgcrypto as the
    // uuid extension, uuid columns default to gen_random_uuid() (built into Postgres 13+).
    installExtensions: false,
    uuidExtension: 'pgcrypto',
  };
}
