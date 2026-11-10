import { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { REDIS } from '../src/redis/redis.module.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

describe('staff manage neighbourhoods (e2e, spec G8)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(sms),
    );
    db = app.get(DataSource);
  });

  afterEach(async () => {
    sms.clear();
    await app.get<Redis>(REDIS).flushdb();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const staff = async (role = 'moderator') => {
    const admin = await createTestAdmin(db, { role });
    const { body } = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    return { id: admin.id, token: body.accessToken as string };
  };

  const as = (token: string) => ({
    get: (path: string) =>
      http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) =>
      http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) =>
      http().delete(path).set('Authorization', `Bearer ${token}`),
  });

  const subCityId = async (nameEn: string): Promise<string> =>
    (
      await db.query(`SELECT id FROM sub_cities WHERE name_en = $1`, [nameEn])
    )[0].id;
  const neighbourhoodId = async (nameEn: string): Promise<string> =>
    (
      await db.query(`SELECT id FROM neighbourhoods WHERE name_en = $1`, [
        nameEn,
      ])
    )[0].id;
  const row = async (id: string) =>
    (
      await db.query(
        `SELECT name_en, name_am, deactivated_at, created_by_admin_id FROM neighbourhoods WHERE id = $1`,
        [id],
      )
    )[0];
  const actions = () =>
    db.query<
      {
        action: string;
        target_type: string;
        target_id: string;
        admin_id: string;
        details: Record<string, unknown>;
      }[]
    >(
      `SELECT action, target_type, target_id, admin_id, details FROM admin_actions
       WHERE action LIKE 'neighbourhood.%' ORDER BY created_at, id`,
    );
  const pickerNames = async (subCity: string): Promise<string[]> => {
    const { body } = await http().get('/areas').expect(200);
    return body
      .find((s: { nameEn: string }) => s.nameEn === subCity)
      .neighbourhoods.map((n: { nameEn: string }) => n.nameEn);
  };

  describe('access (S2, S3)', () => {
    it('needs a staff token', async () => {
      await http().get('/admin/neighbourhoods').expect(401);
      await http().post('/admin/neighbourhoods').send({}).expect(401);
    });

    it('rejects an app-user token (hard rule 8)', async () => {
      const { accessToken } = await signIn(app, sms, '+251911234567');
      await as(accessToken).get('/admin/neighbourhoods').expect(401);
    });

    it('lets support read but not change anything', async () => {
      const { token } = await staff('support');
      const piassa = await neighbourhoodId('Piassa');

      await as(token).get('/admin/neighbourhoods').expect(200);
      await as(token)
        .post('/admin/neighbourhoods', {
          subCityId: await subCityId('Bole'),
          nameEn: 'New place',
          nameAm: 'አዲስ ቦታ',
        })
        .expect(403);
      await as(token)
        .patch(`/admin/neighbourhoods/${piassa}`, { nameEn: 'Piazza' })
        .expect(403);
      await as(token)
        .post(`/admin/neighbourhoods/${piassa}/deactivate`)
        .expect(403);
      await as(token)
        .post(`/admin/neighbourhoods/${piassa}/reactivate`)
        .expect(403);
      expect(await actions()).toEqual([]);
    });
  });

  describe('GET /admin/neighbourhoods', () => {
    it('lists active ones sorted by sub-city then name, with their details', async () => {
      const { token } = await staff('support');

      const { body } = await as(token).get('/admin/neighbourhoods').expect(200);

      expect(body).toHaveLength(70);
      expect(body[0]).toEqual({
        id: expect.any(String),
        subCityId: await subCityId('Addis Ketema'),
        subCityNameEn: 'Addis Ketema',
        nameEn: 'Autobus Tera',
        nameAm: 'አውቶቡስ ተራ',
        active: true,
        deactivatedAt: null,
        createdByAdminId: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(body.at(-1).nameEn).toBe('Shola');
    });

    it('filters by sub-city and includes deactivated ones only when asked', async () => {
      const { token } = await staff('support');
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE name_en = 'Piassa'`,
      );
      const arada = await subCityId('Arada');

      const active = await as(token)
        .get(`/admin/neighbourhoods?subCityId=${arada}`)
        .expect(200);
      const all = await as(token)
        .get(`/admin/neighbourhoods?subCityId=${arada}&includeInactive=true`)
        .expect(200);

      expect(active.body.map((n: { nameEn: string }) => n.nameEn)).toEqual([
        'Arat Kilo',
        'Atikilt Tera',
        'Doro Manekia',
      ]);
      expect(
        all.body.map((n: { nameEn: string; active: boolean }) => [
          n.nameEn,
          n.active,
        ]),
      ).toEqual([
        ['Arat Kilo', true],
        ['Atikilt Tera', true],
        ['Doro Manekia', true],
        ['Piassa', false],
      ]);
    });

    it('rejects a malformed filter', async () => {
      const { token } = await staff('support');
      await as(token).get('/admin/neighbourhoods?subCityId=nope').expect(400);
      await as(token)
        .get('/admin/neighbourhoods?includeInactive=yes')
        .expect(400);
    });
  });

  describe('POST /admin/neighbourhoods (add)', () => {
    it('adds one, visible in the picker, recorded with who added it and in the audit log', async () => {
      const admin = await staff();
      const bole = await subCityId('Bole');

      const { body } = await as(admin.token)
        .post('/admin/neighbourhoods', {
          subCityId: bole,
          nameEn: '  Gerji Mebrat Hail ',
          nameAm: 'ገርጂ መብራት ኃይል',
        })
        .expect(201);

      expect(body).toMatchObject({
        subCityId: bole,
        subCityNameEn: 'Bole',
        nameEn: 'Gerji Mebrat Hail',
        nameAm: 'ገርጂ መብራት ኃይል',
        active: true,
        createdByAdminId: admin.id,
      });
      expect(await pickerNames('Bole')).toContain('Gerji Mebrat Hail');
      expect(await actions()).toEqual([
        {
          action: 'neighbourhood.create',
          target_type: 'neighbourhood',
          target_id: body.id,
          admin_id: admin.id,
          details: {
            newNameEn: 'Gerji Mebrat Hail',
            newNameAm: 'ገርጂ መብራት ኃይል',
          },
        },
      ]);
    });

    it('refuses a name already in the sub-city, ignoring case, even a deactivated one', async () => {
      const { token } = await staff();
      const arada = await subCityId('Arada');

      const duplicate = await as(token)
        .post('/admin/neighbourhoods', {
          subCityId: arada,
          nameEn: 'PIASSA',
          nameAm: 'ፒያሳ',
        })
        .expect(409);
      await db.query(
        `UPDATE neighbourhoods SET deactivated_at = now() WHERE name_en = 'Piassa'`,
      );
      const deactivated = await as(token)
        .post('/admin/neighbourhoods', {
          subCityId: arada,
          nameEn: 'Piassa',
          nameAm: 'ፒያሳ',
        })
        .expect(409);

      expect(duplicate.body).toEqual({ code: 'NEIGHBOURHOOD_EXISTS' });
      expect(deactivated.body).toEqual({ code: 'NEIGHBOURHOOD_EXISTS' });
      expect(await actions()).toEqual([]);
    });

    it('allows the same name in another sub-city', async () => {
      const { token } = await staff();
      await as(token)
        .post('/admin/neighbourhoods', {
          subCityId: await subCityId('Bole'),
          nameEn: 'Piassa',
          nameAm: 'ፒያሳ',
        })
        .expect(201);
    });

    it('answers 404 SUB_CITY_NOT_FOUND for an unknown sub-city', async () => {
      const { token } = await staff();
      const { body } = await as(token)
        .post('/admin/neighbourhoods', {
          subCityId: UNKNOWN_ID,
          nameEn: 'Somewhere',
          nameAm: 'የሆነ ቦታ',
        })
        .expect(404);
      expect(body).toEqual({ code: 'SUB_CITY_NOT_FOUND' });
    });

    it.each([
      ['a blank name', { nameEn: '   ' }],
      ['a missing Amharic name', { nameAm: undefined }],
      ['a name over 100 characters', { nameEn: 'x'.repeat(101) }],
      ['an unknown field', { createdByAdminId: UNKNOWN_ID }],
    ])('rejects %s with 400', async (_label, override) => {
      const { token } = await staff();
      const { body } = await as(token)
        .post('/admin/neighbourhoods', {
          subCityId: await subCityId('Bole'),
          nameEn: 'New place',
          nameAm: 'አዲስ ቦታ',
          ...override,
        })
        .expect(400);
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(await actions()).toEqual([]);
    });
  });

  describe('PATCH /admin/neighbourhoods/:id (rename)', () => {
    it('renames both names, recording old and new in the audit log', async () => {
      const admin = await staff();
      const id = await neighbourhoodId('Piassa');

      const { body } = await as(admin.token)
        .patch(`/admin/neighbourhoods/${id}`, {
          nameEn: 'Piazza',
          nameAm: 'ፒያሳ ሰፈር',
        })
        .expect(200);

      expect(body).toMatchObject({ id, nameEn: 'Piazza', nameAm: 'ፒያሳ ሰፈር' });
      expect(await pickerNames('Arada')).toContain('Piazza');
      expect(await actions()).toEqual([
        {
          action: 'neighbourhood.update',
          target_type: 'neighbourhood',
          target_id: id,
          admin_id: admin.id,
          details: {
            oldNameEn: 'Piassa',
            newNameEn: 'Piazza',
            oldNameAm: 'ፒያሳ',
            newNameAm: 'ፒያሳ ሰፈር',
          },
        },
      ]);
    });

    it('renames one name, leaving the other and recording only the change', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      await as(token)
        .patch(`/admin/neighbourhoods/${id}`, { nameAm: 'ፒያሳ ሰፈር' })
        .expect(200);

      expect(await row(id)).toMatchObject({
        name_en: 'Piassa',
        name_am: 'ፒያሳ ሰፈር',
      });
      expect((await actions())[0].details).toEqual({
        oldNameAm: 'ፒያሳ',
        newNameAm: 'ፒያሳ ሰፈር',
      });
    });

    it('allows a change of letter case to its own name', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      await as(token)
        .patch(`/admin/neighbourhoods/${id}`, { nameEn: 'PIASSA' })
        .expect(200);

      expect((await row(id)).name_en).toBe('PIASSA');
    });

    it('changes and records nothing when the names are the same', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      await as(token)
        .patch(`/admin/neighbourhoods/${id}`, { nameEn: 'Piassa' })
        .expect(200);

      expect(await actions()).toEqual([]);
    });

    it('refuses a name another neighbourhood in the sub-city has', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      const { body } = await as(token)
        .patch(`/admin/neighbourhoods/${id}`, { nameEn: 'arat kilo' })
        .expect(409);

      expect(body).toEqual({ code: 'NEIGHBOURHOOD_EXISTS' });
      expect((await row(id)).name_en).toBe('Piassa');
      expect(await actions()).toEqual([]);
    });

    it('needs at least one name: 400 NO_FIELDS_TO_UPDATE', async () => {
      const { token } = await staff();
      const { body } = await as(token)
        .patch(`/admin/neighbourhoods/${await neighbourhoodId('Piassa')}`, {})
        .expect(400);
      expect(body).toEqual({ code: 'NO_FIELDS_TO_UPDATE' });
    });

    it('answers 404 NEIGHBOURHOOD_NOT_FOUND for an unknown or malformed id', async () => {
      const { token } = await staff();
      for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
        const { body } = await as(token)
          .patch(`/admin/neighbourhoods/${id}`, { nameEn: 'x' })
          .expect(404);
        expect(body).toEqual({ code: 'NEIGHBOURHOOD_NOT_FOUND' });
      }
    });
  });

  describe('deactivate and reactivate', () => {
    it('deactivating hides it from the picker but keeps the row, with an audited note', async () => {
      const admin = await staff();
      const id = await neighbourhoodId('Piassa');

      const { body } = await as(admin.token)
        .post(`/admin/neighbourhoods/${id}/deactivate`, {
          note: 'Merged into Arat Kilo',
        })
        .expect(200);

      expect(body).toMatchObject({
        id,
        active: false,
        deactivatedAt: expect.any(String),
      });
      expect(await pickerNames('Arada')).not.toContain('Piassa');
      expect((await row(id)).name_en).toBe('Piassa');
      expect(await actions()).toEqual([
        {
          action: 'neighbourhood.deactivate',
          target_type: 'neighbourhood',
          target_id: id,
          admin_id: admin.id,
          details: { note: 'Merged into Arat Kilo' },
        },
      ]);
    });

    it('reactivating brings it back; the note is optional', async () => {
      const admin = await staff();
      const id = await neighbourhoodId('Piassa');
      await as(admin.token)
        .post(`/admin/neighbourhoods/${id}/deactivate`)
        .expect(200);

      const { body } = await as(admin.token)
        .post(`/admin/neighbourhoods/${id}/reactivate`)
        .expect(200);

      expect(body).toMatchObject({ id, active: true, deactivatedAt: null });
      expect(await pickerNames('Arada')).toContain('Piassa');
      expect((await actions()).map((a) => [a.action, a.details])).toEqual([
        ['neighbourhood.deactivate', {}],
        ['neighbourhood.reactivate', {}],
      ]);
    });

    it('refuses to do either twice', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      const active = await as(token)
        .post(`/admin/neighbourhoods/${id}/reactivate`)
        .expect(409);
      await as(token)
        .post(`/admin/neighbourhoods/${id}/deactivate`)
        .expect(200);
      const inactive = await as(token)
        .post(`/admin/neighbourhoods/${id}/deactivate`)
        .expect(409);

      expect(active.body).toEqual({ code: 'NEIGHBOURHOOD_ALREADY_ACTIVE' });
      expect(inactive.body).toEqual({ code: 'NEIGHBOURHOOD_ALREADY_INACTIVE' });
      expect(await actions()).toHaveLength(1);
    });

    it('two deactivations at the same moment: one wins, one gets 409 (row lock)', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      const statuses = (
        await Promise.all([
          as(token).post(`/admin/neighbourhoods/${id}/deactivate`),
          as(token).post(`/admin/neighbourhoods/${id}/deactivate`),
        ])
      )
        .map((r) => r.status)
        .sort();

      expect(statuses).toEqual([200, 409]);
      expect(await actions()).toHaveLength(1);
    });

    it('a note that looks like an ID number is refused, and nothing changes (S1)', async () => {
      const { token } = await staff();
      const id = await neighbourhoodId('Piassa');

      const { body } = await as(token)
        .post(`/admin/neighbourhoods/${id}/deactivate`, {
          note: 'owner 123456789012',
        })
        .expect(400);

      expect(body).toEqual({ code: 'NOTE_CONTAINS_ID_NUMBER' });
      expect((await row(id)).deactivated_at).toBeNull();
      expect(await actions()).toEqual([]);
    });

    it('answers 404 for an unknown neighbourhood', async () => {
      const { token } = await staff();
      await as(token)
        .post(`/admin/neighbourhoods/${UNKNOWN_ID}/deactivate`)
        .expect(404);
      await as(token)
        .post(`/admin/neighbourhoods/${UNKNOWN_ID}/reactivate`)
        .expect(404);
    });
  });

  it('never deletes: there is no DELETE route', async () => {
    const { token } = await staff('super_admin');
    const id = await neighbourhoodId('Piassa');

    await as(token).delete(`/admin/neighbourhoods/${id}`).expect(404);

    expect(await row(id)).toBeDefined();
  });
});
