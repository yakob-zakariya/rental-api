/// <reference types="vite/client" />
// Runs once before the e2e suite: gives it a freshly migrated test database and an empty Redis
// database, so runs never depend on (or touch) development data.
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import pg from 'pg';
import { DataSource, type MigrationInterface } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/data-source.options.js';
import { createS3Client } from '../src/modules/photos/s3-client.js';
import { TEST_ENV } from './test-env.js';
import { SEED_SCHEMA, SEEDED_TABLES } from './utils/seeded-tables.js';

// Loaded through Vite as classes. TypeORM's own glob loading uses native import(), which can't
// load the .ts sources.
const migrationModules = import.meta.glob<Record<string, unknown>>(
  '../src/database/migrations/*.ts',
  { eager: true },
);
const migrations = Object.values(migrationModules)
  .flatMap((module) => Object.values(module))
  .filter(
    (value) => typeof value === 'function',
  ) as (new () => MigrationInterface)[];

export default async function setup() {
  await recreateDatabase(TEST_ENV.DATABASE_URL);
  await runMigrations(TEST_ENV.DATABASE_URL);
  await snapshotSeededTables(TEST_ENV.DATABASE_URL);
  await flushRedis(TEST_ENV.REDIS_URL);
  await prepareBuckets();
}

/** The photo buckets for the tests: created if missing, emptied on every run (never dev ones). */
async function prepareBuckets() {
  const s3 = createS3Client({
    ...TEST_ENV,
    S3_FORCE_PATH_STYLE: TEST_ENV.S3_FORCE_PATH_STYLE === 'true',
  });
  try {
    for (const bucket of [
      TEST_ENV.S3_PRIVATE_BUCKET,
      TEST_ENV.S3_PUBLIC_BUCKET,
    ]) {
      // They're emptied below; refuse anything that isn't clearly a test bucket.
      if (!bucket.includes('test'))
        throw new Error(
          `Refusing to empty "${bucket}": test bucket names must contain "test"`,
        );
      await s3
        .send(new CreateBucketCommand({ Bucket: bucket }))
        .catch((error: Error) => {
          if (
            error.name === 'BucketAlreadyOwnedByYou' ||
            error.name === 'BucketAlreadyExists'
          )
            return;
          throw new Error(
            `Photo storage isn't usable at ${TEST_ENV.S3_ENDPOINT} (${error.name}: ${error.message}). ` +
              'Start it with `docker compose up -d --wait`.',
          );
        });
      for (;;) {
        const { Contents = [] } = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        if (Contents.length === 0) break;
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: Contents.map(({ Key }) => ({ Key })) },
          }),
        );
      }
    }
  } finally {
    s3.destroy();
  }
}

async function recreateDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const name = url.pathname.slice(1);
  // This database is dropped below; refuse anything that isn't clearly a test database.
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(
      `Refusing to recreate "${name}": the e2e database name must end in _test`,
    );
  }

  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Postgres isn't reachable at ${url.host} (${(error as Error).message}). ` +
        'Start it with `docker compose up -d --wait`.',
    );
  }
  try {
    // FORCE closes connections a crashed earlier run may have left open.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template1`);
  } finally {
    await admin.end();
  }
}

async function runMigrations(databaseUrl: string) {
  const dataSource = new DataSource({
    ...buildDataSourceOptions({ DATABASE_URL: databaseUrl }),
    migrations,
  });
  await dataSource.initialize();
  try {
    await dataSource.runMigrations({ transaction: 'each' });
  } finally {
    await dataSource.destroy();
  }
}

// Keeps a copy of the rows migrations seeded, for resetDatabase() to restore (see seeded-tables.ts).
async function snapshotSeededTables(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${SEED_SCHEMA}"`);
    for (const table of SEEDED_TABLES) {
      await client.query(
        `CREATE TABLE "${SEED_SCHEMA}"."${table}" AS TABLE "public"."${table}"`,
      );
    }
  } finally {
    await client.end();
  }
}

async function flushRedis(redisUrl: string) {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    // Database 0 is development's; only ever flush a separate one.
    if (Number(redis.options.db ?? 0) === 0) {
      throw new Error(
        'Refusing to flush Redis database 0: REDIS_URL must select another db',
      );
    }
    await redis.flushdb();
  } catch (error) {
    throw new Error(
      `Redis isn't usable at ${redisUrl} (${(error as Error).message}). ` +
        'Start it with `docker compose up -d --wait`.',
    );
  } finally {
    redis.disconnect();
  }
}
