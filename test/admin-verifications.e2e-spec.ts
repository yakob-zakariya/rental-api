import { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DecisionService } from '../src/modules/verification/decision/decision.service.js';
import { IdentityHasher } from '../src/modules/verification/identity-hasher.js';
import { IdentityKind } from '../src/modules/verification/verification.enums.js';
import { REDIS } from '../src/redis/redis.module.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { createTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

const FIN = '123456789012';
const FAN = '1234567890123456';
const ADULT = '1990-05-17';

interface Seed {
  outcome?: string;
  verifiedName?: string | null;
  dateOfBirth?: string | null;
  flagReason?: string | null;
  minutesAgo?: number;
  decided?: boolean;
}

describe('staff verification review (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let hasher: IdentityHasher;
  const sms = new FakeSmsSender();
  let moderator: { id: string; token: string };
  let support: { id: string; token: string };
  let counter = 0;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(SmsSender).useValue(sms),
    );
    db = app.get(DataSource);
    hasher = app.get(IdentityHasher);
  });

  beforeEach(async () => {
    moderator = await staff('moderator');
    support = await staff('support');
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
  async function staff(role: string) {
    const admin = await createTestAdmin(db, { role });
    const { body } = await http()
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    return { id: admin.id, token: body.accessToken as string };
  }
  const as = (who: { token: string }) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${who.token}`);

  const createUser = async () =>
    (
      await db.query<{ id: string }[]>(
        `INSERT INTO users (phone) VALUES ($1) RETURNING id`,
        [`+2519130000${String(++counter).padStart(2, '0')}`],
      )
    )[0].id;

  /** An attempt as decision processing leaves it (Didit's values in both columns). */
  const createAttempt = async (userId: string, s: Seed = {}) => {
    const name = s.verifiedName === undefined ? 'Abebe Kebede' : s.verifiedName;
    const dob = s.dateOfBirth === undefined ? ADULT : s.dateOfBirth;
    const [row] = await db.query<{ id: string }[]>(
      `INSERT INTO identity_verifications
         (user_id, provider_session_id, provider_status, outcome, verified_name, date_of_birth,
          provider_verified_name, provider_date_of_birth, flag_reason, flagged_at,
          decided_by_admin_id, decided_at, created_at)
       VALUES ($1, $2, 'Approved', $3, $4, $5, $4, $5, $6::varchar,
               CASE WHEN $6::varchar IS NULL THEN NULL ELSE now() END,
               $7, CASE WHEN $7::uuid IS NULL THEN NULL ELSE now() END,
               clock_timestamp() - make_interval(mins => $8))
       RETURNING id`,
      [
        userId,
        `session-${++counter}`,
        s.outcome ?? 'manual_review',
        name,
        dob,
        s.flagReason ?? null,
        s.decided ? moderator.id : null,
        s.minutesAgo ?? 60,
      ],
    );
    return row.id;
  };

  const addHash = (
    attemptId: string,
    userId: string,
    number = FIN,
    isApproved = false,
  ) =>
    db.query(
      `INSERT INTO identity_hashes (verification_id, user_id, kind, hash, is_approved) VALUES ($1, $2, 'fayda_fin', $3, $4)`,
      [
        attemptId,
        userId,
        hasher.hash({ kind: IdentityKind.FaydaFin, number }),
        isApproved,
      ],
    );

  /** A user with one manual_review attempt that has Didit's hash, name and DOB. */
  const reviewable = async (s: Seed = {}) => {
    const userId = await createUser();
    const attemptId = await createAttempt(userId, s);
    await addHash(attemptId, userId);
    return { userId, attemptId };
  };

  const approve = (
    attemptId: string,
    body: Record<string, unknown>,
    who = moderator,
  ) =>
    as(who)(
      http()
        .post(`/admin/verifications/${attemptId}/approve`)
        .send({ note: 'Checked in the Didit console', ...body }),
    );
  const decline = (
    attemptId: string,
    body: Record<string, unknown>,
    who = moderator,
  ) =>
    as(who)(
      http()
        .post(`/admin/verifications/${attemptId}/decline`)
        .send({ note: 'Checked in the Didit console', ...body }),
    );

  const attempt = async (id: string) =>
    (
      await db.query<
        {
          outcome: string;
          decided_by_admin_id: string | null;
          decided: boolean;
          verified_name: string | null;
          date_of_birth: string | null;
          provider_verified_name: string | null;
          provider_date_of_birth: string | null;
          decline_reason: string | null;
          flag_reason: string | null;
        }[]
      >(
        `SELECT outcome, decided_by_admin_id, decided_at IS NOT NULL AS decided, verified_name,
                date_of_birth::text, provider_verified_name, provider_date_of_birth::text,
                decline_reason, flag_reason
         FROM identity_verifications WHERE id = $1`,
        [id],
      )
    )[0];
  const user = async (id: string) =>
    (
      await db.query<
        {
          verification_status: string;
          verified: boolean;
          full_name: string | null;
          date_of_birth: string | null;
        }[]
      >(
        `SELECT verification_status, verified_at IS NOT NULL AS verified, full_name, date_of_birth::text FROM users WHERE id = $1`,
        [id],
      )
    )[0];
  const hashesOf = (attemptId: string) =>
    db.query<{ kind: string; hash: string; is_approved: boolean }[]>(
      `SELECT kind, hash, is_approved FROM identity_hashes WHERE verification_id = $1 ORDER BY kind::text`,
      [attemptId],
    );
  const auditRows = () =>
    db.query<
      {
        action: string;
        target_id: string;
        admin_id: string;
        details: Record<string, unknown>;
      }[]
    >(
      `SELECT action, target_id, admin_id, details FROM admin_actions WHERE action LIKE 'verification.%' ORDER BY created_at`,
    );
  const recompute = (userId: string) =>
    db.transaction((m) => app.get(DecisionService).syncUser(m, userId));

  describe('GET /admin/verifications (the queue)', () => {
    it('lists undecided manual_review and blocked attempts, oldest first, for any staff role', async () => {
      const u = await createUser();
      const newest = await createAttempt(u, { minutesAgo: 10 });
      const oldest = await createAttempt(u, {
        outcome: 'blocked',
        minutesAgo: 50,
      });
      await createAttempt(u, { outcome: 'declined', minutesAgo: 30 });
      await createAttempt(u, {
        outcome: 'manual_review',
        decided: true,
        minutesAgo: 40,
      });

      const { body } = await as(support)(
        http().get('/admin/verifications'),
      ).expect(200);

      expect(body.items.map((i: { attemptId: string }) => i.attemptId)).toEqual(
        [oldest, newest],
      );
      expect(body.items[0]).toMatchObject({
        outcome: 'blocked',
        providerSessionId: expect.stringMatching(/^session-/),
        decided: false,
        user: { id: u, phone: expect.stringMatching(/^\+2519/) },
      });
      expect(body.nextCursor).toBeNull();
    });

    it('filters by status, flagged, and includeDecided', async () => {
      const u = await createUser();
      const flagged = await createAttempt(u, { flagReason: 'MISSING_DATA' });
      await createAttempt(u);
      const declined = await createAttempt(u, { outcome: 'declined' });
      const decided = await createAttempt(u, { decided: true });

      const ids = async (query: string) =>
        (
          await as(support)(http().get(`/admin/verifications${query}`)).expect(
            200,
          )
        ).body.items.map((i: { attemptId: string }) => i.attemptId);

      expect(await ids('?flagged=true')).toEqual([flagged]);
      expect(await ids('?status=declined')).toEqual([declined]);
      expect(await ids('?includeDecided=true')).toContain(decided);
      expect(await ids('')).not.toContain(decided);
    });

    it('pages oldest first with the composite cursor', async () => {
      const u = await createUser();
      const expected: string[] = [];
      for (let i = 5; i >= 1; i--)
        expected.push(await createAttempt(u, { minutesAgo: i * 10 }));

      const first = (
        await as(support)(http().get('/admin/verifications?limit=2')).expect(
          200,
        )
      ).body;
      const second = (
        await as(support)(
          http().get(`/admin/verifications?limit=2&after=${first.nextCursor}`),
        ).expect(200)
      ).body;
      const third = (
        await as(support)(
          http().get(`/admin/verifications?limit=2&after=${second.nextCursor}`),
        ).expect(200)
      ).body;

      expect(
        [...first.items, ...second.items, ...third.items].map(
          (i: { attemptId: string }) => i.attemptId,
        ),
      ).toEqual(expected);
      expect(third.nextCursor).toBeNull();
    });

    it.each(['?status=bogus', '?flagged=maybe', '?limit=0', '?after=nope'])(
      'rejects %s with 400',
      async (query) => {
        await as(support)(http().get(`/admin/verifications${query}`)).expect(
          400,
        );
      },
    );

    it('is staff-only', async () => {
      const { accessToken } = await signIn(app, sms, '+251911234567');
      await http().get('/admin/verifications').expect(401);
      await http()
        .get('/admin/verifications')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
    });
  });

  describe('GET /admin/verifications/:attemptId', () => {
    it('shows Didit’s values beside the effective ones, identity kinds (no hashes), and history', async () => {
      const { userId, attemptId } = await reviewable();
      const older = await createAttempt(userId, {
        outcome: 'declined',
        minutesAgo: 600,
      });

      const { body } = await as(support)(
        http().get(`/admin/verifications/${attemptId}`),
      ).expect(200);

      expect(body).toMatchObject({
        attemptId,
        verifiedName: 'Abebe Kebede',
        providerVerifiedName: 'Abebe Kebede',
        dateOfBirth: ADULT,
        providerDateOfBirth: ADULT,
        identities: [{ kind: 'fayda_fin', isApproved: false }],
      });
      expect(
        body.history.map((h: { attemptId: string }) => h.attemptId),
      ).toEqual([attemptId, older]);
      expect(JSON.stringify(body)).not.toContain(
        hasher.hash({ kind: IdentityKind.FaydaFin, number: FIN }),
      );
    });

    it.each([
      ['an unknown id', '00000000-0000-4000-8000-000000000999'],
      ['a non-uuid', 'abc'],
    ])('returns 404 ATTEMPT_NOT_FOUND for %s', async (_label, id) => {
      const response = await as(support)(
        http().get(`/admin/verifications/${id}`),
      ).expect(404);
      expect(response.body).toEqual({ code: 'ATTEMPT_NOT_FOUND' });
    });
  });

  describe('POST …/approve (S4)', () => {
    it('approves with Didit’s data: attempt, hashes, user and audit', async () => {
      const { userId, attemptId } = await reviewable({
        flagReason: 'POSSIBLE_DUPLICATE',
      });

      const { body } = await approve(attemptId, {}).expect(200);

      expect(body).toMatchObject({
        outcome: 'approved',
        decided: true,
        flagReason: 'POSSIBLE_DUPLICATE',
      });
      expect(await attempt(attemptId)).toMatchObject({
        outcome: 'approved',
        decided_by_admin_id: moderator.id,
        decided: true,
      });
      expect((await hashesOf(attemptId)).every((h) => h.is_approved)).toBe(
        true,
      );
      expect(await user(userId)).toEqual({
        verification_status: 'approved',
        verified: true,
        full_name: 'Abebe Kebede',
        date_of_birth: ADULT,
      });
      expect(await auditRows()).toEqual([
        {
          action: 'verification.approve',
          target_id: attemptId,
          admin_id: moderator.id,
          details: {
            note: 'Checked in the Didit console',
            enteredFields: [],
            previousOutcome: 'manual_review',
            newOutcome: 'approved',
          },
        },
      ]);
    });

    describe('entered identifier (only in the V8 case)', () => {
      it('hashes an entered Fayda number into identity_hashes; the raw number appears nowhere', async () => {
        const userId = await createUser();
        const attemptId = await createAttempt(userId, {
          flagReason: 'MISSING_DATA',
        });

        const response = await approve(attemptId, {
          documentType: 'fayda_fin',
          idNumber: '1234 5678 9012',
        }).expect(200);

        expect(await hashesOf(attemptId)).toEqual([
          {
            kind: 'fayda_fin',
            hash: hasher.hash({ kind: IdentityKind.FaydaFin, number: FIN }),
            is_approved: true,
          },
        ]);
        const [{ dump }] = await db.query<{ dump: string }[]>(
          `SELECT concat_ws(' ', (SELECT json_agg(t)::text FROM identity_verifications t),
                  (SELECT json_agg(t)::text FROM identity_hashes t), (SELECT json_agg(t)::text FROM admin_actions t),
                  (SELECT json_agg(t)::text FROM users t)) AS dump`,
        );
        expect(dump).not.toContain(FIN);
        expect(JSON.stringify(response.body)).not.toContain(FIN);
        expect((await auditRows())[0].details.enteredFields).toEqual([
          'documentType',
          'idNumber',
        ]);
      });

      it('accepts a FAN and a passport with its country', async () => {
        const u1 = await createUser();
        const a1 = await createAttempt(u1);
        await approve(a1, { documentType: 'fayda_fan', idNumber: FAN }).expect(
          200,
        );

        const u2 = await createUser();
        const a2 = await createAttempt(u2);
        await approve(a2, {
          documentType: 'passport',
          idNumber: 'ep 1234567',
          issuingCountry: 'ken',
        }).expect(200);

        expect((await hashesOf(a2))[0].hash).toBe(
          hasher.hash({
            kind: IdentityKind.Passport,
            number: 'EP1234567',
            country: 'KEN',
          }),
        );
        expect((await auditRows()).at(-1)!.details.enteredFields).toEqual([
          'documentType',
          'idNumber',
          'issuingCountry',
        ]);
      });

      it.each([
        [
          'a FIN of the wrong length',
          { documentType: 'fayda_fin', idNumber: '12345678901' },
        ],
        [
          'a FAN of the wrong length',
          { documentType: 'fayda_fan', idNumber: FIN },
        ],
        [
          'letters in a Fayda number',
          { documentType: 'fayda_fin', idNumber: '12345678901A' },
        ],
        [
          'a passport without a country',
          { documentType: 'passport', idNumber: 'EP1234567' },
        ],
        [
          'a passport with a 2-letter country',
          {
            documentType: 'passport',
            idNumber: 'EP1234567',
            issuingCountry: 'ET',
          },
        ],
        [
          'a country on a Fayda number',
          { documentType: 'fayda_fin', idNumber: FIN, issuingCountry: 'ETH' },
        ],
        ['an idNumber without documentType', { idNumber: FIN }],
      ])(
        'rejects %s with 400 INVALID_ID_NUMBER, never echoing it',
        async (_label, body) => {
          const userId = await createUser();
          const attemptId = await createAttempt(userId);

          const response = await approve(attemptId, body).expect(400);

          expect(response.body).toEqual({ code: 'INVALID_ID_NUMBER' });
          expect(await hashesOf(attemptId)).toEqual([]);
          expect((await attempt(attemptId)).outcome).toBe('manual_review');
        },
      );

      it('refuses an entered number when Didit already returned one: 409 IDENTIFIER_ALREADY_PRESENT', async () => {
        const { attemptId } = await reviewable();

        const response = await approve(attemptId, {
          documentType: 'fayda_fin',
          idNumber: '999999999999',
        }).expect(409);

        expect(response.body).toEqual({ code: 'IDENTIFIER_ALREADY_PRESENT' });
        expect(await hashesOf(attemptId)).toHaveLength(1); // only Didit's
        expect((await attempt(attemptId)).outcome).toBe('manual_review');
        expect(await auditRows()).toEqual([]);
      });
    });

    describe('corrections never overwrite what Didit returned', () => {
      it('changes the effective name and DOB only; provider_* keep Didit’s values; the user gets the effective ones', async () => {
        const { userId, attemptId } = await reviewable({
          verifiedName: 'ABEBE KEBDE',
          dateOfBirth: '1990-05-17',
        });

        const { body } = await approve(attemptId, {
          fullName: 'Abebe Kebede',
          dateOfBirth: '1990-06-17',
        }).expect(200);

        expect(await attempt(attemptId)).toMatchObject({
          verified_name: 'Abebe Kebede',
          date_of_birth: '1990-06-17',
          provider_verified_name: 'ABEBE KEBDE',
          provider_date_of_birth: '1990-05-17',
        });
        expect(body).toMatchObject({
          verifiedName: 'Abebe Kebede',
          providerVerifiedName: 'ABEBE KEBDE',
          dateOfBirth: '1990-06-17',
          providerDateOfBirth: '1990-05-17',
        });
        expect(await user(userId)).toMatchObject({
          full_name: 'Abebe Kebede',
          date_of_birth: '1990-06-17',
        });
        expect((await auditRows())[0].details.enteredFields).toEqual([
          'dateOfBirth',
          'fullName',
        ]);
      });

      it('Didit decision processing writes both the provider and the effective values', async () => {
        const userId = await createUser();
        const attemptId = await createAttempt(userId, {
          outcome: 'pending',
          verifiedName: null,
          dateOfBirth: null,
        });
        await db.query(
          `UPDATE identity_verifications SET provider_status = 'In Progress' WHERE id = $1`,
          [attemptId],
        );
        const [{ session }] = await db.query<{ session: string }[]>(
          `SELECT provider_session_id AS session FROM identity_verifications WHERE id = $1`,
          [attemptId],
        );

        await db.transaction((m) =>
          app.get(DecisionService).apply(
            {
              sessionId: session,
              status: 'Approved',
              idVerifications: [
                {
                  status: 'Approved',
                  documentType: 'Identity Card',
                  documentSubtype: null,
                  documentNumber: FIN,
                  personalNumber: null,
                  issuingState: 'ETH',
                  dateOfBirth: ADULT,
                  fullName: 'From Didit',
                  firstName: null,
                  lastName: null,
                },
              ],
            },
            m,
          ),
        );

        expect(await attempt(attemptId)).toMatchObject({
          verified_name: 'From Didit',
          provider_verified_name: 'From Didit',
          date_of_birth: ADULT,
          provider_date_of_birth: ADULT,
        });
      });
    });

    it('requires an identifier, a DOB and a name: 400 MISSING_IDENTITY_DATA listing what’s missing', async () => {
      const userId = await createUser();
      const attemptId = await createAttempt(userId, {
        verifiedName: null,
        dateOfBirth: null,
      });

      const response = await approve(attemptId, {}).expect(400);

      expect(response.body).toEqual({
        code: 'MISSING_IDENTITY_DATA',
        missing: ['idNumber', 'dateOfBirth', 'fullName'],
      });
    });

    it.each([
      ['V5: a banned identity', 'BANNED_IDENTITY'],
      ['V6: an identity approved for another user', 'DUPLICATE_IDENTITY'],
      ['V4: under 18', 'UNDERAGE'],
    ])(
      're-runs %s and refuses with 409, changing nothing (entered hash rolled back)',
      async (_label, code) => {
        const userId = await createUser();
        const attemptId = await createAttempt(userId, {
          dateOfBirth:
            code === 'UNDERAGE'
              ? `${new Date().getUTCFullYear() - 10}-01-01`
              : ADULT,
        });
        if (code === 'BANNED_IDENTITY') {
          await db.query(
            `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id) VALUES ($1, 'fayda_fin', $2, 'fraud', $3)`,
            [
              userId,
              hasher.hash({ kind: IdentityKind.FaydaFin, number: FIN }),
              moderator.id,
            ],
          );
        }
        if (code === 'DUPLICATE_IDENTITY') {
          const other = await createUser();
          const otherAttempt = await createAttempt(other, {
            outcome: 'approved',
          });
          await addHash(otherAttempt, other, FIN, true);
        }

        const response = await approve(attemptId, {
          documentType: 'fayda_fin',
          idNumber: FIN,
        }).expect(409);

        expect(response.body).toEqual({ code });
        expect(await hashesOf(attemptId)).toEqual([]);
        expect(await attempt(attemptId)).toMatchObject({
          outcome: 'manual_review',
          decided: false,
        });
        expect(await auditRows()).toEqual([]);
      },
    );

    describe('blocked attempts', () => {
      it('can be approved once the block is resolved (e.g. a V6 duplicate whose approval was reversed)', async () => {
        const { userId, attemptId } = await reviewable({
          outcome: 'blocked',
          flagReason: 'DUPLICATE_IDENTITY',
        });
        await recompute(userId);
        expect((await user(userId)).verification_status).toBe('blocked');

        await approve(attemptId, {}).expect(200);

        expect((await user(userId)).verification_status).toBe('approved');
      });

      it('refuses with 409 OTHER_BLOCKED_ATTEMPTS while another attempt keeps the user blocked', async () => {
        const { userId, attemptId } = await reviewable({ outcome: 'blocked' });
        await createAttempt(userId, { outcome: 'blocked', minutesAgo: 500 });

        const response = await approve(attemptId, {}).expect(409);

        expect(response.body).toEqual({ code: 'OTHER_BLOCKED_ATTEMPTS' });
        expect((await attempt(attemptId)).outcome).toBe('blocked');
      });
    });

    it.each(['pending', 'approved', 'declined', 'abandoned', 'expired'])(
      'refuses a %s attempt with 409 ATTEMPT_NOT_REVIEWABLE',
      async (outcome) => {
        const { attemptId } = await reviewable({ outcome });
        expect((await approve(attemptId, {}).expect(409)).body).toEqual({
          code: 'ATTEMPT_NOT_REVIEWABLE',
        });
      },
    );

    it('never decides twice: 409 ALREADY_DECIDED', async () => {
      const { attemptId } = await reviewable();
      await approve(attemptId, {}).expect(200);

      expect((await approve(attemptId, {}).expect(409)).body).toEqual({
        code: 'ALREADY_DECIDED',
      });
      expect(
        (await decline(attemptId, { reasonCode: 'PHOTO_UNCLEAR' }).expect(409))
          .body,
      ).toEqual({ code: 'ALREADY_DECIDED' });
    });

    it('needs moderator (support is read-only) and a note without ID numbers', async () => {
      const { attemptId } = await reviewable();

      expect((await approve(attemptId, {}, support).expect(403)).body).toEqual({
        code: 'INSUFFICIENT_ROLE',
      });
      await as(moderator)(
        http().post(`/admin/verifications/${attemptId}/approve`).send({}),
      ).expect(400);
      expect(
        (
          await approve(attemptId, {
            note: 'their FIN is 123456789012',
          }).expect(400)
        ).body,
      ).toEqual({
        code: 'NOTE_CONTAINS_ID_NUMBER',
      });
      expect((await attempt(attemptId)).outcome).toBe('manual_review');
    });

    it('a staff approval stays final when Didit later says Declined (V15)', async () => {
      const { attemptId } = await reviewable();
      await approve(attemptId, {}).expect(200);
      const [{ session }] = await db.query<{ session: string }[]>(
        `SELECT provider_session_id AS session FROM identity_verifications WHERE id = $1`,
        [attemptId],
      );

      await db.transaction((m) =>
        app
          .get(DecisionService)
          .apply(
            { sessionId: session, status: 'Declined', idVerifications: [] },
            m,
          ),
      );

      expect(await attempt(attemptId)).toMatchObject({ outcome: 'approved' });
    });
  });

  describe('POST …/decline', () => {
    it('declines with a user-safe reasonCode the user then sees in their status', async () => {
      const { userId, attemptId } = await reviewable();
      await recompute(userId);
      const { accessToken } = await (async () => {
        const [{ phone }] = await db.query<{ phone: string }[]>(
          `SELECT phone FROM users WHERE id = $1`,
          [userId],
        );
        return signIn(app, sms, phone);
      })();

      await decline(attemptId, { reasonCode: 'PHOTO_UNCLEAR' }).expect(200);

      expect(await attempt(attemptId)).toMatchObject({
        outcome: 'declined',
        decline_reason: 'PHOTO_UNCLEAR',
        decided: true,
      });
      const status = await http()
        .get('/verification/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(status.body).toMatchObject({
        status: 'declined',
        reasonCode: 'PHOTO_UNCLEAR',
        canRetry: true,
        canRequestManualReview: false,
      });
      expect(await auditRows()).toEqual([
        {
          action: 'verification.decline',
          target_id: attemptId,
          admin_id: moderator.id,
          details: {
            reasonCode: 'PHOTO_UNCLEAR',
            note: 'Checked in the Didit console',
            previousOutcome: 'manual_review',
            newOutcome: 'declined',
          },
        },
      ]);
    });

    it('refuses to decline a blocked attempt (it would quietly unblock the user): 409 ATTEMPT_NOT_REVIEWABLE', async () => {
      const { userId, attemptId } = await reviewable({ outcome: 'blocked' });
      await recompute(userId);

      expect(
        (
          await decline(attemptId, {
            reasonCode: 'DOCUMENT_NOT_ACCEPTED',
          }).expect(409)
        ).body,
      ).toEqual({
        code: 'ATTEMPT_NOT_REVIEWABLE',
      });
      expect((await user(userId)).verification_status).toBe('blocked');
    });

    it.each([{ reasonCode: 'DIDIT_DECLINED' }, { reasonCode: 'nope' }, {}])(
      'rejects %j with 400',
      async (body) => {
        const { attemptId } = await reviewable();
        await decline(attemptId, body).expect(400);
      },
    );

    it('needs moderator', async () => {
      const { attemptId } = await reviewable();
      expect(
        (
          await decline(
            attemptId,
            { reasonCode: 'PHOTO_UNCLEAR' },
            support,
          ).expect(403)
        ).body,
      ).toEqual({
        code: 'INSUFFICIENT_ROLE',
      });
    });
  });
});
