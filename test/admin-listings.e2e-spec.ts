import { INestApplication } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { UnlimitedThrottlerStorage } from './fakes/unlimited-throttler-storage.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { boleNeighbourhoodId, fullListing } from './utils/listings.js';
import { plainImage } from './utils/photos.js';
import { signIn } from './utils/sign-in.js';

// Staff review: the queue and the listing detail (spec section 8, R1, R6; T4.1).

interface Lister {
  token: string;
  userId: string;
  phone: string;
}
type Auth = { Authorization: string };

describe('admin: listing review queue and detail (e2e, T4.1)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const sms = new FakeSmsSender();
  let counter = 0;
  let support: Auth;
  let moderator: Auth & { id: string };

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(ThrottlerStorage)
        .useValue(new UnlimitedThrottlerStorage()),
    );
    db = app.get(DataSource);
  });

  beforeEach(async () => {
    support = await staff('support');
    moderator = await staff('moderator');
  });

  afterEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function staff(role: string) {
    const admin = await createTestAdmin(db, { role });
    const { body } = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    return { id: admin.id, Authorization: `Bearer ${body.accessToken}` };
  }

  const lister = async (fullName = 'Abebe Kebede Tesfaye'): Promise<Lister> => {
    const phone = `+2519200000${String(++counter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    await db.query(
      `UPDATE users SET verification_status = 'approved', full_name = $2 WHERE phone = $1`,
      [phone, fullName],
    );
    const [{ id }] = await db.query<{ id: string }[]>(
      `SELECT id FROM users WHERE phone = $1`,
      [phone],
    );
    return { token: accessToken, userId: id, phone };
  };

  /** A complete listing in `status`, submitted `minutesAgo`; returns its ids. */
  const listing = async (
    who: Lister,
    status = 'pending_review',
    { minutesAgo = 10, body = {} as object } = {},
  ) => {
    const { body: created } = await http()
      .post('/listings')
      .set({ Authorization: `Bearer ${who.token}` })
      .send({ ...fullListing(await boleNeighbourhoodId(db)), ...body })
      .expect(201);
    await db.query(
      `UPDATE listings SET status = $2::listing_status,
         submitted_at = CASE WHEN $2::text <> 'draft' THEN now() - make_interval(mins => $3) END
       WHERE id = $1`,
      [created.id, status, minutesAgo],
    );
    return {
      id: created.id as string,
      propertyId: created.property.id as string,
    };
  };

  const queue = (auth: Auth, query = '') =>
    http().get(`/admin/listings${query}`).set(auth);
  const detail = (auth: Auth, id: string) =>
    http().get(`/admin/listings/${id}`).set(auth);

  describe('access (S2, S3)', () => {
    it('every staff role can read the queue and a listing', async () => {
      const { id } = await listing(await lister());
      const superAdmin = await staff('super_admin');

      for (const auth of [support, moderator, superAdmin]) {
        await queue(auth).expect(200);
        await detail(auth, id).expect(200);
      }
    });

    it('an app token or no token: 401, staff and app tokens never cross', async () => {
      const who = await lister();
      const { id } = await listing(who);

      await queue({ Authorization: `Bearer ${who.token}` }).expect(401);
      await http().get('/admin/listings').expect(401);
      await http()
        .get(`/admin/listings/${id}`)
        .set({ Authorization: `Bearer ${who.token}` })
        .expect(401);
    });
  });

  describe('GET /admin/listings: the queue', () => {
    it('pending_review by default, oldest submission first; other states and drafts are not in it', async () => {
      const who = await lister();
      const newer = await listing(who, 'pending_review', { minutesAgo: 5 });
      const older = await listing(who, 'pending_review', { minutesAgo: 60 });
      await listing(who, 'live');
      await listing(who, 'draft');

      const { body } = await queue(support).expect(200);

      expect(body.items.map((i: { id: string }) => i.id)).toEqual([
        older.id,
        newer.id,
      ]);
      expect(body.nextCursor).toBeNull();
    });

    it('another status on request (e.g. live, to find a listing to take down)', async () => {
      const who = await lister();
      const live = await listing(who, 'live');
      await listing(who);

      const { body } = await queue(support, '?status=live').expect(200);

      expect(body.items.map((i: { id: string }) => i.id)).toEqual([live.id]);
    });

    it('drafts can never be listed (decided 2026-11-24): status=draft is 400', async () => {
      const { body } = await queue(support, '?status=draft').expect(400);

      expect(body.code).toBe('VALIDATION_FAILED');
    });

    it('pages without gaps or repeats, even when listings were submitted at the same moment', async () => {
      const who = await lister();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await listing(who)).id);
      await db.query(
        `UPDATE listings SET submitted_at = '2026-11-20T10:00:00Z'`,
      );
      const expected = [...ids].sort();

      const seen: string[] = [];
      let after = '';
      for (let page = 0; page < 5; page++) {
        const { body } = await queue(support, `?limit=2${after}`).expect(200);
        seen.push(...body.items.map((i: { id: string }) => i.id));
        if (!body.nextCursor) break;
        after = `&after=${body.nextCursor}`;
      }

      expect(seen).toEqual(expected);
    });

    it.each(['?limit=0', '?limit=201', '?after=not-a-cursor'])(
      'refuses %s with 400',
      async (query) => {
        const { body } = await queue(support, query).expect(400);

        expect(['VALIDATION_FAILED', 'INVALID_CURSOR']).toContain(body.code);
      },
    );

    it('each row: summary, photo count, a working signed cover link, the lister and the flags', async () => {
      const who = await lister();
      const { propertyId } = await listing(who, 'pending_review', {
        body: { description: 'Lovely flat. Telegram @AddisHomes' },
      });
      await http()
        .post(`/properties/${propertyId}/photos`)
        .set({ Authorization: `Bearer ${who.token}` })
        .attach('photo', await plainImage(64, 48), 'a.jpg')
        .expect(201);
      await db.query(`UPDATE listings SET status = 'pending_review'`);

      const { body } = await queue(support).expect(200);

      expect(body.items[0]).toMatchObject({
        status: 'pending_review',
        type: 'apartment',
        bedrooms: 2,
        monthlyRentBirr: 25000,
        subCityNameEn: 'Bole',
        photoCount: 1,
        listerId: who.userId,
        listerFullName: 'Abebe Kebede Tesfaye',
        flags: [
          {
            code: 'CONTACT_IN_TEXT',
            found: [{ field: 'description', kinds: ['telegram'] }],
          },
        ],
      });
      expect((await fetch(body.items[0].coverUrl)).status).toBe(200);
    });
  });

  describe('GET /admin/listings/:id: the detail', () => {
    it('the private fields, signed photo links, the lister, other listings (no drafts) and the history', async () => {
      const who = await lister();
      const { id, propertyId } = await listing(who, 'pending_review', {
        body: { unlistedNeighbourhoodName: 'Gerji Mebrat Hail' },
      });
      await http()
        .post(`/properties/${propertyId}/photos`)
        .set({ Authorization: `Bearer ${who.token}` })
        .attach('photo', await plainImage(64, 48), 'a.jpg')
        .expect(201);
      await db.query(
        `UPDATE listings SET status = 'pending_review' WHERE id = $1`,
        [id],
      );
      const other = await listing(who, 'live');
      await listing(who, 'draft');

      const { body } = await detail(moderator, id).expect(200);

      expect(body).toMatchObject({
        id,
        status: 'pending_review',
        monthlyRentBirr: 25000,
        property: {
          id: propertyId,
          location: { lat: 9.0102, lng: 38.7606 },
          landmark: 'Blue gate behind the pharmacy',
          unlistedNeighbourhoodName: 'Gerji Mebrat Hail',
          subCityNameEn: 'Bole',
        },
        lister: {
          id: who.userId,
          fullName: 'Abebe Kebede Tesfaye',
          verificationStatus: 'approved',
          status: 'active',
        },
        otherListings: [{ id: other.id, status: 'live' }],
      });
      expect(body.property.approxLocation).toEqual({
        lat: expect.any(Number),
        lng: expect.any(Number),
      });
      expect(body.property.photos).toHaveLength(1);
      expect((await fetch(body.property.photos[0].url)).status).toBe(200);
      expect(body.history[0]).toMatchObject({
        event: 'status',
        oldStatus: null,
        newStatus: 'draft',
        actorType: 'user',
        actorId: who.userId,
      });
      expect(body.flags).toEqual([
        { code: 'UNLISTED_NEIGHBOURHOOD', name: 'Gerji Mebrat Hail' },
      ]);
    });

    it('never includes the phone number', async () => {
      const who = await lister();
      const { id } = await listing(who);

      const { text } = await detail(moderator, id).expect(200);

      expect(text).not.toContain(who.phone);
      expect(text).not.toContain(who.phone.slice(4));
    });

    it('a draft can be opened by its id (e.g. from a report), though it is never listed', async () => {
      const { id } = await listing(await lister(), 'draft');

      await detail(support, id).expect(200);
    });

    it('an unknown or malformed id: 404 LISTING_NOT_FOUND', async () => {
      for (const id of ['00000000-0000-4000-8000-000000000000', 'nope']) {
        const { body } = await detail(support, id).expect(404);
        expect(body.code).toBe('LISTING_NOT_FOUND');
      }
    });
  });

  describe('flags (R1)', () => {
    it('MANY_ACTIVE_LISTINGS above 2 active listings, counting this one', async () => {
      const who = await lister();
      const first = await listing(who);
      await listing(who, 'live');
      expect((await detail(support, first.id)).body.flags).toEqual([]);

      await listing(who, 'stale');
      await listing(who, 'expired'); // not active: doesn't count

      expect((await detail(support, first.id)).body.flags).toEqual([
        { code: 'MANY_ACTIVE_LISTINGS', activeListings: 3 },
      ]);
    });

    it('CONTACT_IN_TEXT names the field and the kind, for Telegram, phone, email and links', async () => {
      const who = await lister();
      const { id } = await listing(who, 'pending_review', {
        body: {
          description: 'ለበለጠ መረጃ በቴሌግራም t.me/addishomes ወይም 0911 23 45 67 ይደውሉ',
          landmark: 'Next to the school, email abebe@gmail.com',
        },
      });

      const { body } = await detail(support, id).expect(200);

      expect(body.flags).toEqual([
        {
          code: 'CONTACT_IN_TEXT',
          found: [
            { field: 'description', kinds: ['phone', 'telegram'] },
            { field: 'landmark', kinds: ['email'] },
          ],
        },
      ]);
    });
  });

  describe('POST /admin/listings/:id/reveal-lister-phone (decided 2026-11-24)', () => {
    const reveal = (auth: Auth, id: string, body: object = {}) =>
      http()
        .post(`/admin/listings/${id}/reveal-lister-phone`)
        .set(auth)
        .send(body);

    it('a moderator gets the phone, and the reveal is recorded without the number', async () => {
      const who = await lister();
      const { id } = await listing(who);

      const { body } = await reveal(moderator, id, {
        note: 'Calling to check the photos',
      }).expect(200);

      expect(body).toEqual({ phone: who.phone });
      const rows = await db.query<
        {
          admin_id: string;
          action: string;
          target_type: string;
          target_id: string;
          details: unknown;
        }[]
      >(
        `SELECT admin_id, action, target_type, target_id, details FROM admin_actions
         WHERE action = 'listing.reveal_lister_phone'`,
      );
      expect(rows).toEqual([
        {
          admin_id: moderator.id,
          action: 'listing.reveal_lister_phone',
          target_type: 'listing',
          target_id: id,
          details: { note: 'Calling to check the photos' },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain(who.phone.slice(4));
    });

    it('works without a note; each reveal is a separate row', async () => {
      const { id } = await listing(await lister());

      await reveal(moderator, id).expect(200);
      await reveal(moderator, id).expect(200);

      const [{ n }] = await db.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM admin_actions WHERE action = 'listing.reveal_lister_phone'`,
      );
      expect(n).toBe(2);
    });

    it('support may not: 403 INSUFFICIENT_ROLE, and nothing is recorded', async () => {
      const { id } = await listing(await lister());

      const { body } = await reveal(support, id).expect(403);

      expect(body.code).toBe('INSUFFICIENT_ROLE');
      expect(
        await db.query(
          `SELECT 1 FROM admin_actions WHERE action = 'listing.reveal_lister_phone'`,
        ),
      ).toEqual([]);
    });

    it('a note with an ID number is refused (S1), and nothing is revealed', async () => {
      const { id } = await listing(await lister());

      const { body } = await reveal(moderator, id, {
        note: 'FIN 1234 5678 9012',
      }).expect(400);

      expect(body.code).toBe('NOTE_CONTAINS_ID_NUMBER');
      expect(body.phone).toBeUndefined();
    });

    it('an unknown listing: 404 LISTING_NOT_FOUND', async () => {
      const { body } = await reveal(
        moderator,
        '00000000-0000-4000-8000-000000000000',
      ).expect(404);

      expect(body.code).toBe('LISTING_NOT_FOUND');
    });
  });
});
