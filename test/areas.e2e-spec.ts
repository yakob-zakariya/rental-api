import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

interface AreaBody {
  id: string;
  nameEn: string;
  nameAm: string;
  neighbourhoods: { id: string; nameEn: string; nameAm: string }[];
}

const violates = (constraint: string) => ({ driverError: { constraint } });
const UNIQUE_NAME = violates('UQ_neighbourhoods_sub_city_id_lower_name_en');
const NAMES_NOT_BLANK = violates('CHK_neighbourhoods_names_not_blank');

describe('areas: sub-cities and neighbourhoods (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DataSource);
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const getAreas = async (): Promise<AreaBody[]> =>
    (await request(app.getHttpServer()).get('/areas').expect(200)).body;

  const subCityId = async (nameEn: string): Promise<string> =>
    (
      await db.query(`SELECT id FROM sub_cities WHERE name_en = $1`, [nameEn])
    )[0].id;

  describe('GET /areas (G7)', () => {
    it('works without a token', async () => {
      await request(app.getHttpServer()).get('/areas').expect(200);
    });

    it('returns the 11 seeded sub-cities and 70 neighbourhoods, in English and Amharic', async () => {
      const areas = await getAreas();

      expect(areas.map((s) => s.nameEn)).toEqual([
        'Addis Ketema',
        'Akaki Kality',
        'Arada',
        'Bole',
        'Gulele',
        'Kirkos',
        'Kolfe Keranio',
        'Lemi Kura',
        'Lideta',
        'Nifas Silk-Lafto',
        'Yeka',
      ]);
      expect(areas.flatMap((s) => s.neighbourhoods)).toHaveLength(70);

      const arada = areas.find((s) => s.nameEn === 'Arada')!;
      expect(arada).toEqual({
        id: expect.any(String),
        nameEn: 'Arada',
        nameAm: 'አራዳ',
        neighbourhoods: [
          { id: expect.any(String), nameEn: 'Arat Kilo', nameAm: 'አራት ኪሎ' },
          {
            id: expect.any(String),
            nameEn: 'Atikilt Tera',
            nameAm: 'አትክልት ተራ',
          },
          { id: expect.any(String), nameEn: 'Doro Manekia', nameAm: 'ዶሮ ማነቂያ' },
          { id: expect.any(String), nameEn: 'Piassa', nameAm: 'ፒያሳ' },
        ],
      });
    });

    it('sorts neighbourhoods by English name within each sub-city', async () => {
      const collator = new Intl.Collator('en', { sensitivity: 'base' });
      for (const subCity of await getAreas()) {
        const names = subCity.neighbourhoods.map((n) => n.nameEn);
        expect(names).toEqual([...names].sort(collator.compare));
      }
    });

    it('leaves out deactivated neighbourhoods (G8)', async () => {
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE name_en = 'Piassa'`,
      );

      const arada = (await getAreas()).find((s) => s.nameEn === 'Arada')!;

      expect(arada.neighbourhoods.map((n) => n.nameEn)).toEqual([
        'Arat Kilo',
        'Atikilt Tera',
        'Doro Manekia',
      ]);
    });

    it('shows a sub-city with no active neighbourhoods, with an empty list', async () => {
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE sub_city_id = $1`,
        [await subCityId('Lemi Kura')],
      );

      const lemiKura = (await getAreas()).find((s) => s.nameEn === 'Lemi Kura');

      expect(lemiKura?.neighbourhoods).toEqual([]);
    });
  });

  describe('database rules (spec section 2)', () => {
    const insertNeighbourhood = async (
      subCity: string,
      nameEn: string,
      nameAm = 'ሙከራ',
    ) =>
      db.query(
        `INSERT INTO neighbourhoods (sub_city_id, name_en, name_am) VALUES ($1, $2, $3)`,
        [await subCityId(subCity), nameEn, nameAm],
      );

    it('rejects a second neighbourhood with the same English name in a sub-city, ignoring case', async () => {
      await expect(
        insertNeighbourhood('Arada', 'PIASSA'),
      ).rejects.toMatchObject(UNIQUE_NAME);
    });

    it('rejects it even when the existing one is deactivated', async () => {
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE name_en = 'Piassa'`,
      );

      await expect(
        insertNeighbourhood('Arada', 'Piassa'),
      ).rejects.toMatchObject(UNIQUE_NAME);
    });

    it('allows the same name in another sub-city', async () => {
      await expect(
        insertNeighbourhood('Bole', 'Piassa'),
      ).resolves.toBeDefined();
    });

    it('rejects blank names', async () => {
      await expect(insertNeighbourhood('Bole', '   ')).rejects.toMatchObject(
        NAMES_NOT_BLANK,
      );
      await expect(
        insertNeighbourhood('Bole', 'New place', ' '),
      ).rejects.toMatchObject(NAMES_NOT_BLANK);
    });

    it('rejects a second sub-city with the same name in a city', async () => {
      await expect(
        db.query(
          `INSERT INTO sub_cities (city, name_en, name_am) VALUES ('Addis Ababa', 'Bole', 'ቦሌ')`,
        ),
      ).rejects.toMatchObject(violates('UQ_sub_cities_city_name_en'));
    });
  });
});
