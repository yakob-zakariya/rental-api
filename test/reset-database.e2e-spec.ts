import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

describe('resetDatabase (e2e helper)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    await dataSource.query(`CREATE TABLE reset_parent (id serial PRIMARY KEY)`);
    await dataSource.query(
      `CREATE TABLE reset_child (id serial PRIMARY KEY, parent_id int REFERENCES reset_parent(id))`,
    );
  });

  afterAll(async () => {
    await dataSource.query(`DROP TABLE reset_child, reset_parent`);
    await app.close();
  });

  const count = async (table: string) =>
    Number((await dataSource.query(`SELECT count(*) AS n FROM ${table}`))[0].n);

  it('empties app tables, including ones linked by foreign keys', async () => {
    await dataSource.query(`INSERT INTO reset_parent DEFAULT VALUES`);
    await dataSource.query(`INSERT INTO reset_child (parent_id) VALUES (1)`);

    await resetDatabase(app);

    expect(await count('reset_parent')).toBe(0);
    expect(await count('reset_child')).toBe(0);
  });

  it('keeps the migrations table and PostGIS reference data', async () => {
    const migrationsBefore = await count('migrations');
    const sridsBefore = await count('spatial_ref_sys');

    await resetDatabase(app);

    expect(migrationsBefore).toBeGreaterThan(0);
    expect(await count('migrations')).toBe(migrationsBefore);
    expect(sridsBefore).toBeGreaterThan(0);
    expect(await count('spatial_ref_sys')).toBe(sridsBefore);
  });

  it('puts back the rows migrations seeded, undoing changes made to them', async () => {
    const seeded = async () =>
      dataSource.query(
        `SELECT n.id, n.name_en, n.name_am, n.deactivated_at, n.sub_city_id
         FROM neighbourhoods n ORDER BY n.id`,
      );
    const before = await seeded();
    const subCitiesBefore = await count('sub_cities');

    await dataSource.query(
      `UPDATE neighbourhoods SET name_en = 'Renamed', deactivated_at = now()
       WHERE id = $1`,
      [before[0].id],
    );
    await dataSource.query(
      `INSERT INTO neighbourhoods (sub_city_id, name_en, name_am)
       VALUES ($1, 'Added in a test', 'ሙከራ')`,
      [before[0].sub_city_id],
    );

    await resetDatabase(app);

    expect(before).toHaveLength(70);
    expect(subCitiesBefore).toBe(11);
    expect(await seeded()).toEqual(before);
    expect(await count('sub_cities')).toBe(subCitiesBefore);
  });
});
