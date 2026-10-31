import { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { DataSource } from 'typeorm';
import { SmsSender } from '../src/modules/sms/sms-sender.js';
import { DecisionService } from '../src/modules/verification/decision/decision.service.js';
import { DiditClient } from '../src/modules/verification/didit/didit-client.js';
import { canonicalJson } from '../src/modules/verification/didit/webhook-signature.js';
import { IdentityHasher } from '../src/modules/verification/identity-hasher.js';
import { IdentityKind } from '../src/modules/verification/verification.enums.js';
import { FakeDiditClient } from './fakes/fake-didit-client.js';
import { FakeSmsSender } from './fakes/fake-sms-sender.js';
import { TEST_ENV } from './test-env.js';
import { insertTestAdmin } from './utils/admins.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';
import { signIn } from './utils/sign-in.js';

// Decision processing (T2.6) end to end: a signed Didit webhook → DecisionService → attempt,
// hashes, recompute and the user's fields. Raw SQL reads on purpose: these assert stored state.

const FIN = '123456789012';
const FAN = '1234567890123456';
const PASSPORT = 'EP1234567';
const ADULT_DOB = '1990-05-17';
// A real admin row, created before each test (the admin id columns are foreign keys).
let ADMIN_ID: string;

type Doc = Record<string, unknown>;
const fayda = (fields: Doc = {}): Doc => ({
  status: 'Approved',
  document_type: 'Identity Card',
  document_subtype: 'ID_CARD_GENERIC',
  issuing_state: 'ETH',
  document_number: FIN,
  personal_number: FAN,
  date_of_birth: ADULT_DOB,
  full_name: 'Abebe Kebede',
  // Fields that must never reach our database (hard rule 1):
  front_image: 'https://cdn.didit.example/front.jpg',
  portrait_image: 'https://cdn.didit.example/portrait.jpg',
  address: 'Bole, Addis Ababa',
  ...fields,
});
const passport = (fields: Doc = {}): Doc => ({
  status: 'Approved',
  document_type: 'Passport',
  document_subtype: 'PASSPORT_GENERIC',
  issuing_state: 'ETH',
  document_number: PASSPORT,
  date_of_birth: ADULT_DOB,
  full_name: 'Abebe Kebede',
  ...fields,
});

/** A date of birth that makes someone 17 today (in UTC; safely away from the boundary). */
const seventeenYearsAgo = () => {
  const d = new Date();
  return `${d.getUTCFullYear() - 17}-01-01` < d.toISOString().slice(0, 10)
    ? `${d.getUTCFullYear() - 17}-12-31`
    : `${d.getUTCFullYear() - 18}-12-31`;
};

interface Attempt {
  id: string;
  user_id: string;
  outcome: string;
  provider_status: string;
  decline_reason: string | null;
  flag_reason: string | null;
  verified_name: string | null;
  date_of_birth: string | null;
  document_type: string | null;
  verification_url: string | null;
  session_token: string | null;
  completed: boolean;
}

describe('decision processing (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let hasher: IdentityHasher;
  const sms = new FakeSmsSender();
  const didit = new FakeDiditClient();
  let phoneCounter = 0;

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b
        .overrideProvider(SmsSender)
        .useValue(sms)
        .overrideProvider(DiditClient)
        .useValue(didit),
    );
    db = app.get(DataSource);
    hasher = app.get(IdentityHasher);
  });

  beforeEach(async () => {
    ADMIN_ID = await insertTestAdmin(db);
  });

  afterEach(async () => {
    sms.clear();
    didit.reset();
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** A signed-in user with one started (pending) attempt. */
  const userWithAttempt = async () => {
    const phone = `+2519110000${String(++phoneCounter).padStart(2, '0')}`;
    const { accessToken } = await signIn(app, sms, phone);
    const response = await request(app.getHttpServer())
      .post('/verification/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(201);
    const [row] = await db.query<
      { id: string; user_id: string; provider_session_id: string }[]
    >(
      `SELECT a.id, a.user_id, a.provider_session_id FROM identity_verifications a
       JOIN users u ON u.id = a.user_id WHERE u.phone = $1`,
      [phone],
    );
    return {
      accessToken,
      userId: row.user_id,
      attemptId: row.id,
      sessionId: row.provider_session_id,
      verificationUrl: response.body.verificationUrl as string,
    };
  };

  /** Delivers a Didit webhook for the session, signed like Didit. */
  const deliver = (
    sessionId: string,
    status: string,
    documents?: Doc[],
    { webhookType = 'status.updated', eventId = randomUUID() } = {},
  ) => {
    const body: Record<string, unknown> = {
      event_id: eventId,
      webhook_type: webhookType,
      timestamp: Math.floor(Date.now() / 1000),
      environment: 'sandbox',
      session_id: sessionId,
      status,
      vendor_data: 'ignored',
      ...(documents && {
        decision: {
          id_verifications: documents,
          face_matches: [{ score: 95.0 }],
        },
      }),
    };
    const signature = createHmac('sha256', TEST_ENV.DIDIT_WEBHOOK_SECRET)
      .update(canonicalJson(body))
      .digest('hex');
    return request(app.getHttpServer())
      .post('/webhooks/didit')
      .set('content-type', 'application/json')
      .set('x-timestamp', String(body.timestamp))
      .set('x-signature-v2', signature)
      .send(JSON.stringify(body))
      .expect(200);
  };

  const attempt = async (attemptId: string) =>
    (
      await db.query<Attempt[]>(
        `SELECT id, user_id, outcome, provider_status, decline_reason, flag_reason, verified_name,
                date_of_birth::text, document_type, verification_url, session_token,
                completed_at IS NOT NULL AS completed
         FROM identity_verifications WHERE id = $1`,
        [attemptId],
      )
    )[0];

  const user = async (userId: string) =>
    (
      await db.query<
        {
          verification_status: string;
          verified: boolean;
          full_name: string | null;
          date_of_birth: string | null;
        }[]
      >(
        `SELECT verification_status, verified_at IS NOT NULL AS verified, full_name, date_of_birth::text
         FROM users WHERE id = $1`,
        [userId],
      )
    )[0];

  const hashes = (attemptId: string) =>
    db.query<{ kind: string; hash: string; is_approved: boolean }[]>(
      `SELECT kind, hash, is_approved FROM identity_hashes WHERE verification_id = $1 ORDER BY kind::text`,
      [attemptId],
    );

  const finHash = (number = FIN) =>
    hasher.hash({ kind: IdentityKind.FaydaFin, number });
  const approved = async () => {
    const a = await userWithAttempt();
    await deliver(a.sessionId, 'Approved', [fayda()]);
    return a;
  };

  describe('approval', () => {
    it('approves: attempt, hashes, recompute and the user’s verified fields', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Approved', [fayda()]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'approved',
        provider_status: 'Approved',
        decline_reason: null,
        flag_reason: null,
        verified_name: 'Abebe Kebede',
        date_of_birth: ADULT_DOB,
        document_type: 'Identity Card',
        verification_url: null,
        session_token: null,
        completed: true,
      });
      expect(await hashes(a.attemptId)).toEqual([
        {
          kind: 'fayda_fan',
          hash: hasher.hash({ kind: IdentityKind.FaydaFan, number: FAN }),
          is_approved: true,
        },
        { kind: 'fayda_fin', hash: finHash(), is_approved: true },
      ]);
      expect(await user(a.userId)).toEqual({
        verification_status: 'approved',
        verified: true,
        full_name: 'Abebe Kebede',
        date_of_birth: ADULT_DOB,
      });
      const me = await request(app.getHttpServer())
        .get('/me')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(200);
      expect(me.body).toMatchObject({
        verificationStatus: 'approved',
        fullName: 'Abebe Kebede',
      });
    });

    it('approves a passport, hashed with its issuing country', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Approved', [
        passport({ issuing_state: 'KEN' }),
      ]);

      expect((await attempt(a.attemptId)).outcome).toBe('approved');
      expect(await hashes(a.attemptId)).toEqual([
        {
          kind: 'passport',
          hash: hasher.hash({
            kind: IdentityKind.Passport,
            number: PASSPORT,
            country: 'KEN',
          }),
          is_approved: true,
        },
      ]);
    });

    it('stores no raw ID number, image URL or address anywhere (hard rule 1)', async () => {
      const a = await userWithAttempt();
      await deliver(a.sessionId, 'Approved', [fayda(), passport()]);

      const [{ dump }] = await db.query<{ dump: string }[]>(
        `SELECT concat_ws(' ',
           (SELECT json_agg(t)::text FROM identity_verifications t),
           (SELECT json_agg(t)::text FROM identity_hashes t),
           (SELECT json_agg(t)::text FROM users t),
           (SELECT json_agg(t)::text FROM verification_webhook_events t)) AS dump`,
      );
      for (const leaked of [FIN, FAN, PASSPORT, 'cdn.didit', 'Bole']) {
        expect(dump).not.toContain(leaked);
      }
    });

    it('falls back to the decision endpoint when an Approved event has no decision', async () => {
      const a = await userWithAttempt();
      didit.setIdVerifications(a.sessionId, [
        {
          status: 'Approved',
          documentType: 'Identity Card',
          issuingState: 'ETH',
          documentNumber: FIN,
          dateOfBirth: ADULT_DOB,
          fullName: 'Abebe Kebede',
        },
      ]);

      await deliver(a.sessionId, 'Approved');

      expect((await attempt(a.attemptId)).outcome).toBe('approved');
      expect(await hashes(a.attemptId)).toHaveLength(1);
    });

    it('processes a late Approved for an attempt superseded locally (V14/V15)', async () => {
      const a = await userWithAttempt();
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'abandoned', verification_url = NULL, session_token = NULL WHERE id = $1`,
        [a.attemptId],
      );

      await deliver(a.sessionId, 'Approved', [fayda()]);

      expect((await attempt(a.attemptId)).outcome).toBe('approved');
      expect((await user(a.userId)).verification_status).toBe('approved');
    });
  });

  describe('our checks, in order', () => {
    it('V5: blocks a banned identity, with a neutral status for the user', async () => {
      const a = await userWithAttempt();
      await db.query(
        `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id)
         VALUES ($1, 'fayda_fin', $2, 'fraud', $3)`,
        [a.userId, finHash(), ADMIN_ID],
      );

      await deliver(a.sessionId, 'Approved', [fayda()]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'blocked',
        decline_reason: 'BANNED_IDENTITY',
      });
      expect((await user(a.userId)).verification_status).toBe('blocked');
      expect((await hashes(a.attemptId)).every((h) => !h.is_approved)).toBe(
        true,
      );
    });

    it('V5: ignores a lifted ban', async () => {
      const a = await userWithAttempt();
      await db.query(
        `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id, lifted_at, lifted_by_admin_id)
         VALUES ($1, 'fayda_fin', $2, 'fraud', $3, now(), $3)`,
        [a.userId, finHash(), ADMIN_ID],
      );

      await deliver(a.sessionId, 'Approved', [fayda()]);

      expect((await attempt(a.attemptId)).outcome).toBe('approved');
    });

    it('V6: blocks and flags an identifier already approved for another user', async () => {
      const first = await approved();
      const second = await userWithAttempt();

      await deliver(second.sessionId, 'Approved', [
        fayda({ personal_number: null, full_name: 'Someone Else' }),
      ]);

      expect(await attempt(second.attemptId)).toMatchObject({
        outcome: 'blocked',
        decline_reason: 'DUPLICATE_IDENTITY',
        flag_reason: 'DUPLICATE_IDENTITY',
      });
      expect((await user(second.userId)).verification_status).toBe('blocked');
      // The first user keeps their approval.
      expect((await user(first.userId)).verification_status).toBe('approved');
    });

    it.each([
      [
        'no identifier (a driving licence)',
        [passport({ document_type: "Driver's License" })],
      ],
      ['no date of birth', [fayda({ date_of_birth: null })]],
      [
        'a passport without issuing country',
        [passport({ issuing_state: null })],
      ],
      [
        'a Fayda number of unexpected length',
        [fayda({ document_number: '12345', personal_number: null })],
      ],
    ])(
      'V8: sends %s to manual_review (MISSING_DATA)',
      async (_label, documents) => {
        const a = await userWithAttempt();

        await deliver(a.sessionId, 'Approved', documents);

        expect(await attempt(a.attemptId)).toMatchObject({
          outcome: 'manual_review',
          flag_reason: 'MISSING_DATA',
        });
        expect((await user(a.userId)).verification_status).toBe(
          'manual_review',
        );
      },
    );

    describe('V18: a document Didit did not approve', () => {
      it('sends the attempt to manual_review (DOCUMENT_DECLINED) and never stores its hashes', async () => {
        const a = await userWithAttempt();

        await deliver(a.sessionId, 'Approved', [
          passport(),
          fayda({ status: 'Declined', full_name: 'Victim Name' }),
        ]);

        expect(await attempt(a.attemptId)).toMatchObject({
          outcome: 'manual_review',
          flag_reason: 'DOCUMENT_DECLINED',
          verified_name: 'Abebe Kebede', // from the passport, not the declined card
          document_type: 'Passport',
        });
        expect((await hashes(a.attemptId)).map((h) => h.kind)).toEqual([
          'passport',
        ]);
        const stored = await db.query(
          `SELECT 1 FROM identity_hashes WHERE hash = $1`,
          [finHash()],
        );
        expect(stored).toHaveLength(0);
      });

      it('still uses its identifiers for V6, blocking a stolen number', async () => {
        await approved(); // the real owner of FIN
        const attacker = await userWithAttempt();

        await deliver(attacker.sessionId, 'Approved', [
          passport({ document_number: 'XA0000001', full_name: 'Attacker' }),
          fayda({ status: 'Declined', personal_number: null }),
        ]);

        expect(await attempt(attacker.attemptId)).toMatchObject({
          outcome: 'blocked',
          flag_reason: 'DUPLICATE_IDENTITY',
        });
      });

      it('still uses its identifiers for V5', async () => {
        const a = await userWithAttempt();
        await db.query(
          `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id)
           VALUES ($1, 'fayda_fin', $2, 'fraud', $3)`,
          [a.userId, finHash(), ADMIN_ID],
        );

        await deliver(a.sessionId, 'Approved', [
          passport(),
          fayda({ status: 'Declined' }),
        ]);

        expect((await attempt(a.attemptId)).outcome).toBe('blocked');
      });
    });

    it('V17: sends documents that disagree to manual_review (DOCUMENT_MISMATCH)', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Approved', [
        fayda(),
        passport({ date_of_birth: '1991-05-17' }),
      ]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'manual_review',
        flag_reason: 'DOCUMENT_MISMATCH',
      });
    });

    it('V17: approves documents that agree after name normalisation', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Approved', [
        fayda({ full_name: 'ABEBE KEBEDE' }),
        passport({ full_name: 'Abebe  Kebede.' }),
      ]);

      expect((await attempt(a.attemptId)).outcome).toBe('approved');
      expect((await hashes(a.attemptId)).map((h) => h.kind)).toEqual([
        'fayda_fan',
        'fayda_fin',
        'passport',
      ]);
    });

    it('V4: declines someone under 18 (UNDERAGE)', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Approved', [
        fayda({ date_of_birth: seventeenYearsAgo() }),
      ]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'declined',
        decline_reason: 'UNDERAGE',
      });
      expect((await user(a.userId)).verification_status).toBe('declined');
      expect((await hashes(a.attemptId)).every((h) => !h.is_approved)).toBe(
        true,
      );
    });

    it('V7: sends the same name + date of birth as another approved user to manual_review', async () => {
      const first = await userWithAttempt();
      await deliver(first.sessionId, 'Approved', [passport()]);
      const second = await userWithAttempt();

      // A Fayda card for "the same person": no hash in common with the passport.
      await deliver(second.sessionId, 'Approved', [
        fayda({ full_name: 'abebe KEBEDE' }),
      ]);

      expect(await attempt(second.attemptId)).toMatchObject({
        outcome: 'manual_review',
        flag_reason: 'POSSIBLE_DUPLICATE',
      });
    });

    it('applies the checks in order: banned beats underage and missing data', async () => {
      const a = await userWithAttempt();
      await db.query(
        `INSERT INTO banned_identities (user_id, kind, hash, reason, banned_by_admin_id)
         VALUES ($1, 'fayda_fin', $2, 'fraud', $3)`,
        [a.userId, finHash(), ADMIN_ID],
      );

      await deliver(a.sessionId, 'Approved', [
        fayda({ date_of_birth: seventeenYearsAgo() }),
        passport({ issuing_state: null }),
      ]);

      expect((await attempt(a.attemptId)).outcome).toBe('blocked');
    });
  });

  describe('other Didit statuses', () => {
    it('declines on Didit Declined (DIDIT_DECLINED)', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Declined', [fayda({ status: 'Declined' })]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'declined',
        decline_reason: 'DIDIT_DECLINED',
        completed: true,
        verification_url: null,
      });
      expect(await hashes(a.attemptId)).toHaveLength(0);
      expect((await user(a.userId)).verification_status).toBe('declined');
    });

    it.each([
      ['Abandoned', 'abandoned'],
      ['Expired', 'expired'],
    ])('sets %s on a pending attempt', async (status, outcome) => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, status);

      expect((await attempt(a.attemptId)).outcome).toBe(outcome);
      expect((await user(a.userId)).verification_status).toBe('not_verified');
    });

    it('records non-final statuses on a pending attempt without changing it', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'In Review');

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'pending',
        provider_status: 'In Review',
      });
      expect((await attempt(a.attemptId)).verification_url).not.toBeNull();
    });

    it('records an unknown status without changing anything', async () => {
      const a = await userWithAttempt();

      await deliver(a.sessionId, 'Some Future Status');

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'pending',
        provider_status: 'Some Future Status',
      });
    });
  });

  describe('V12 and V15: after a final outcome', () => {
    it('V12: a late In Progress never overwrites an approval', async () => {
      const a = await approved();

      await deliver(a.sessionId, 'In Progress');

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'approved',
        provider_status: 'In Progress',
      });
      expect((await user(a.userId)).verification_status).toBe('approved');
    });

    it('Kyc Expired keeps the user approved, records provider_status only, no flag', async () => {
      const a = await approved();

      await deliver(a.sessionId, 'Kyc Expired');

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'approved',
        provider_status: 'Kyc Expired',
        flag_reason: null,
      });
      expect(await user(a.userId)).toMatchObject({
        verification_status: 'approved',
        verified: true,
      });
    });

    it('a staff decision is final: Didit only updates provider_status', async () => {
      const a = await userWithAttempt();
      await db.query(
        `UPDATE identity_verifications
         SET outcome = 'declined', decided_by_admin_id = $2, decided_at = now(),
             verification_url = NULL, session_token = NULL WHERE id = $1`,
        [a.attemptId, ADMIN_ID],
      );

      await deliver(a.sessionId, 'Approved', [fayda()]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'declined',
        provider_status: 'Approved',
      });
      expect(await hashes(a.attemptId)).toHaveLength(0);
    });

    it.each(['blocked', 'manual_review'])(
      'a %s attempt is never changed by Didit',
      async (outcome) => {
        const a = await userWithAttempt();
        await db.query(
          `UPDATE identity_verifications SET outcome = $2, verification_url = NULL, session_token = NULL WHERE id = $1`,
          [a.attemptId, outcome],
        );

        await deliver(a.sessionId, 'Approved', [fayda()]);
        await deliver(a.sessionId, 'Declined');

        expect(await attempt(a.attemptId)).toMatchObject({
          outcome,
          provider_status: 'Declined',
        });
      },
    );

    it('a reversal (Approved → Declined) un-approves hashes, clears verified_at, keeps name/DOB, flags it', async () => {
      const a = await approved();

      await deliver(a.sessionId, 'Declined');

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'declined',
        decline_reason: 'DIDIT_DECLINED',
        flag_reason: 'APPROVAL_REVERSED',
      });
      expect((await hashes(a.attemptId)).every((h) => !h.is_approved)).toBe(
        true,
      );
      expect(await user(a.userId)).toEqual({
        verification_status: 'declined',
        verified: false,
        full_name: 'Abebe Kebede',
        date_of_birth: ADULT_DOB,
      });
    });

    it('a reversal frees the identifier for its rightful owner', async () => {
      const wrong = await approved();
      await deliver(wrong.sessionId, 'Declined');
      const owner = await userWithAttempt();

      await deliver(owner.sessionId, 'Approved', [fayda()]);

      expect((await attempt(owner.attemptId)).outcome).toBe('approved');
    });

    it('Declined → Approved (after Didit resubmission) re-runs the checks and approves', async () => {
      const a = await userWithAttempt();
      await deliver(a.sessionId, 'Declined');
      await deliver(a.sessionId, 'Resubmitted');

      await deliver(a.sessionId, 'Approved', [fayda()]);

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'approved',
        decline_reason: null,
      });
      expect((await user(a.userId)).verification_status).toBe('approved');
    });

    it('a repeated Approved (new event id) changes nothing', async () => {
      const a = await approved();
      const before = await attempt(a.attemptId);

      await deliver(a.sessionId, 'Approved', [
        fayda({ full_name: 'Changed Name' }),
      ]);

      expect(await attempt(a.attemptId)).toEqual(before);
    });
  });

  describe('data.updated', () => {
    it('flags the attempt for staff and changes nothing else (V9)', async () => {
      const a = await approved();

      await deliver(
        a.sessionId,
        'Approved',
        [fayda({ full_name: 'Edited Name', date_of_birth: '2000-01-01' })],
        {
          webhookType: 'data.updated',
        },
      );

      expect(await attempt(a.attemptId)).toMatchObject({
        outcome: 'approved',
        flag_reason: 'DATA_UPDATED',
        verified_name: 'Abebe Kebede',
        date_of_birth: ADULT_DOB,
      });
      expect(await user(a.userId)).toMatchObject({
        full_name: 'Abebe Kebede',
        date_of_birth: ADULT_DOB,
      });
    });

    it('keeps an existing flag', async () => {
      const a = await userWithAttempt();
      await deliver(a.sessionId, 'Approved', [fayda({ date_of_birth: null })]); // MISSING_DATA

      await deliver(a.sessionId, 'Approved', undefined, {
        webhookType: 'data.updated',
      });

      expect((await attempt(a.attemptId)).flag_reason).toBe('MISSING_DATA');
    });
  });

  it('ignores a decision for an unknown session (200, nothing changed)', async () => {
    await deliver('99999999-9999-4999-8999-999999999999', 'Approved', [
      fayda(),
    ]);

    expect(await db.query(`SELECT 1 FROM identity_hashes`)).toHaveLength(0);
    expect(
      await db.query(
        `SELECT processed_at IS NOT NULL AS p FROM verification_webhook_events`,
      ),
    ).toEqual([{ p: true }]);
  });

  describe('V6 under a race (the partial unique index)', () => {
    it('approves exactly one of two users approved at the same moment with the same identifier', async () => {
      const a = await userWithAttempt();
      const b = await userWithAttempt();

      await Promise.all([
        deliver(a.sessionId, 'Approved', [fayda({ personal_number: null })]),
        deliver(b.sessionId, 'Approved', [
          fayda({ personal_number: null, full_name: 'Other Person' }),
        ]),
      ]);

      const outcomes = [
        (await attempt(a.attemptId)).outcome,
        (await attempt(b.attemptId)).outcome,
      ].sort();
      expect(outcomes).toEqual(['approved', 'blocked']);
      const [{ n }] = await db.query<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM identity_hashes WHERE hash = $1 AND is_approved`,
        [finHash()],
      );
      expect(n).toBe(1);
    });

    it('approveHashes returns false on the unique violation and keeps the transaction usable', async () => {
      const a = await approved(); // FIN approved for user A
      const b = await userWithAttempt();
      await db.query(
        `INSERT INTO identity_hashes (verification_id, user_id, kind, hash) VALUES ($1, $2, 'fayda_fin', $3)`,
        [b.attemptId, b.userId, finHash()],
      );
      const decisions = app.get(DecisionService);

      const result = await db.transaction(async (manager) => {
        const ok = await decisions.approveHashes(manager, b.attemptId);
        // Still usable after the violation (thanks to the savepoint):
        const [{ one }] =
          await manager.query<{ one: number }[]>(`SELECT 1 AS one`);
        return { ok, one };
      });

      expect(result).toEqual({ ok: false, one: 1 });
      expect((await user(a.userId)).verification_status).toBe('approved');
    });
  });
});
