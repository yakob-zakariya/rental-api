import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { createTestApp } from './utils/create-test-app.js';

describe('GET /health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the database and Redis as up', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      info: { database: { status: 'up' }, redis: { status: 'up' } },
      error: {},
      details: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('runs against the migrated test database, not development', async () => {
    const dataSource = app.get(DataSource);
    const [{ db }] = await dataSource.query('SELECT current_database() AS db');
    const extensions: { extname: string }[] = await dataSource.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pgcrypto') ORDER BY 1`,
    );

    expect(db).toBe('rental_test');
    expect(extensions.map((row) => row.extname)).toEqual([
      'pgcrypto',
      'postgis',
    ]);
  });
});
