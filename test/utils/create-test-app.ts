import { INestApplication, ModuleMetadata } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import { DataSource, type EntityManager } from 'typeorm';
import { AppModule } from '../../src/app.module.js';
import { SEED_SCHEMA, SEEDED_TABLES } from './seeded-tables.js';

/**
 * The full app as main.ts builds it (minus Swagger and listen). Close it in afterAll.
 * `configure` can swap providers, e.g. `(b) => b.overrideProvider(SmsSender).useValue(fake)`.
 * `extraImports` adds test-only modules, e.g. a controller that exists only for a test.
 */
export async function createTestApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (b) => b,
  extraImports: NonNullable<ModuleMetadata['imports']> = [],
): Promise<INestApplication<App>> {
  const moduleRef = await configure(
    Test.createTestingModule({ imports: [AppModule, ...extraImports] }),
  ).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    logger: ['error', 'warn'],
    rawBody: true, // as in main.ts (Didit webhook X-Signature fallback)
  });
  await app.init();
  return app;
}

/**
 * Empties every table the app owns, between tests that write data, then puts back the rows
 * migrations seeded (SEEDED_TABLES, as global-setup.ts copied them). Keeps the migrations table and
 * extension-owned tables (e.g. PostGIS's spatial_ref_sys).
 */
export async function resetDatabase(app: INestApplication): Promise<void> {
  const dataSource = app.get(DataSource);
  await dataSource.transaction(async (manager) => {
    await truncateAppTables(manager);
    for (const table of SEEDED_TABLES) {
      await manager.query(
        `INSERT INTO "public"."${table}" SELECT * FROM "${SEED_SCHEMA}"."${table}"`,
      );
    }
  });
}

async function truncateAppTables(manager: EntityManager): Promise<void> {
  const rows: { name: string }[] = await manager.query(`
    SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r'
      AND n.nspname = 'public'
      AND c.relname <> 'migrations'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
      )
  `);
  if (rows.length === 0) return;
  // One statement covers foreign keys between the listed tables, so no CASCADE is needed.
  await manager.query(
    `TRUNCATE ${rows.map((row) => row.name).join(', ')} RESTART IDENTITY`,
  );
}
