import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { ServiceAreaService } from '../src/modules/areas/service-area.service.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

// [latitude, longitude]. Places outside were checked against the boundary when it was loaded
// (T1.3); Burayu and the point west of a vertex are deliberately close to the edge.
const INSIDE: [string, number, number][] = [
  ['Meskel Square', 9.0102, 38.7606],
  ['Bole International Airport', 8.9792, 38.7966],
  ['Yeka Abado (about 700 m from the edge)', 9.0662, 38.8773],
  ['Tulu Dimtu (about 900 m from the edge)', 8.85, 38.8167],
];
const OUTSIDE: [string, number, number][] = [
  ['Burayu (about 1.3 km outside)', 9.036, 38.6608],
  ['200 m west of the westernmost vertex', 8.9739525, 38.638],
  ['Sebeta', 8.9122, 38.624],
  ['Sululta', 9.2894, 38.8136],
  ['Dukem area', 8.5975, 38.7859],
  ['Adama', 8.541, 39.2705],
  ['Null Island (0, 0)', 0, 0],
];

describe('service area: the Addis Ababa boundary (e2e, spec G1)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let serviceArea: ServiceAreaService;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DataSource);
    serviceArea = app.get(ServiceAreaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is seeded once, from OpenStreetMap, as a valid shape of about the city’s size', async () => {
    const rows = await db.query<
      { city: string; source: string; valid: boolean; km2: number }[]
    >(
      `SELECT city, source, ST_IsValid(boundary::geometry) AS valid,
              ST_Area(boundary) / 1e6 AS km2
       FROM service_area`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].city).toBe('Addis Ababa');
    expect(rows[0].source).toContain('OpenStreetMap relation 1707699');
    expect(rows[0].source).toContain('ODbL');
    expect(rows[0].valid).toBe(true);
    // The official figure is about 527 km²; the OpenStreetMap outline measures 538.
    expect(rows[0].km2).toBeGreaterThan(500);
    expect(rows[0].km2).toBeLessThan(560);
  });

  it.each(INSIDE)('%s is inside', async (_name, lat, lng) => {
    expect(await serviceArea.isInside(lat, lng)).toBe(true);
  });

  it.each(OUTSIDE)('%s is outside', async (_name, lat, lng) => {
    expect(await serviceArea.isInside(lat, lng)).toBe(false);
  });

  it('counts a point exactly on the boundary as inside', async () => {
    // The boundary's first vertex.
    expect(await serviceArea.isInside(8.9739525, 38.639904)).toBe(true);
  });

  it('takes latitude first: swapped coordinates are not inside', async () => {
    expect(await serviceArea.isInside(38.7606, 9.0102)).toBe(false);
  });

  it.each([
    ['NaN', Number.NaN, 38.76],
    ['Infinity', 9.01, Number.POSITIVE_INFINITY],
    ['a latitude over 90', 91, 38.76],
    ['a longitude over 180', 9.01, 181],
  ])('treats %s as outside, without querying', async (_name, lat, lng) => {
    expect(await serviceArea.isInside(lat, lng)).toBe(false);
  });

  it('survives resetDatabase (seeded reference data)', async () => {
    await resetDatabase(app);

    expect(await serviceArea.isInside(9.0102, 38.7606)).toBe(true);
  });
});
