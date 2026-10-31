import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import {
  DiditEventProcessor,
  type DiditWebhookEvent,
} from '../src/modules/verification/didit/didit-event-processor.js';
import { canonicalJson } from '../src/modules/verification/didit/webhook-signature.js';
import { TEST_ENV } from './test-env.js';
import { createTestApp, resetDatabase } from './utils/create-test-app.js';

class FakeProcessor extends DiditEventProcessor {
  readonly processed: DiditWebhookEvent[] = [];
  failWith: Error | null = null;
  /** Lets a test see the processor's writes inside the webhook transaction. */
  onProcess?: (manager: EntityManager) => Promise<void>;

  async process(
    event: DiditWebhookEvent,
    manager: EntityManager,
  ): Promise<void> {
    await this.onProcess?.(manager);
    if (this.failWith) throw this.failWith;
    this.processed.push(event);
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const payload = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'b5f6e2a0-0000-4000-8000-000000000001',
  webhook_type: 'status.updated',
  timestamp: nowSeconds(),
  created_at: nowSeconds(),
  application_id: 'app-1',
  environment: 'sandbox',
  session_id: '11111111-2222-3333-4444-555555555555',
  status: 'Approved',
  workflow_id: 'workflow-1',
  workflow_version: 3,
  vendor_data: 'user-1',
  metadata: null,
  decision: {
    id_verifications: [
      {
        status: 'Approved',
        document_number: 'EP1234567',
        full_name: 'Abebe Kebede',
        score: 100.0,
      },
    ],
  },
  ...overrides,
});

describe('POST /webhooks/didit (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const processor = new FakeProcessor();

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(DiditEventProcessor).useValue(processor),
    );
    db = app.get(DataSource);
  });

  afterEach(async () => {
    processor.processed.length = 0;
    processor.failWith = null;
    processor.onProcess = undefined;
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Sends exactly these bytes, signed like Didit (V2 by default). */
  const deliver = (
    body: Record<string, unknown>,
    {
      secret = TEST_ENV.DIDIT_WEBHOOK_SECRET as string,
      timestamp = nowSeconds(),
      headers = {} as Record<string, string>,
    } = {},
  ) => {
    const raw = JSON.stringify(body);
    const v2 = createHmac('sha256', secret)
      .update(canonicalJson(body))
      .digest('hex');
    return request(app.getHttpServer())
      .post('/webhooks/didit')
      .set('content-type', 'application/json')
      .set('x-timestamp', String(timestamp))
      .set('x-signature-v2', v2)
      .set(headers)
      .send(raw);
  };

  const events = () =>
    db.query<
      {
        event_key: string;
        webhook_type: string;
        provider_session_id: string;
        provider_status: string;
        processed: boolean;
        error: string | null;
      }[]
    >(
      `SELECT event_key, webhook_type, provider_session_id, provider_status,
              processed_at IS NOT NULL AS processed, error
       FROM verification_webhook_events ORDER BY received_at`,
    );

  it('accepts a signed event without any token, processes it and records it', async () => {
    await deliver(payload()).expect(200);

    expect(processor.processed).toEqual([
      {
        eventId: 'b5f6e2a0-0000-4000-8000-000000000001',
        webhookType: 'status.updated',
        sessionId: '11111111-2222-3333-4444-555555555555',
        status: 'Approved',
        environment: 'sandbox',
        vendorData: 'user-1',
      },
    ]);
    expect(await events()).toEqual([
      {
        event_key: 'b5f6e2a0-0000-4000-8000-000000000001',
        webhook_type: 'status.updated',
        provider_session_id: '11111111-2222-3333-4444-555555555555',
        provider_status: 'Approved',
        processed: true,
        error: null,
      },
    ]);
  });

  it('stores no payload: no decision data, ID numbers or names', async () => {
    await deliver(payload()).expect(200);

    const [{ dump }] = await db.query<{ dump: string }[]>(
      `SELECT row_to_json(e)::text AS dump FROM verification_webhook_events e`,
    );
    for (const leaked of [
      'EP1234567',
      'Abebe',
      'decision',
      'id_verifications',
    ]) {
      expect(dump).not.toContain(leaked);
    }
  });

  it('V11: a duplicate delivery returns 200 and is not processed again', async () => {
    await deliver(payload()).expect(200);
    await deliver(payload()).expect(200);

    expect(processor.processed).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('V11: processes concurrent duplicate deliveries exactly once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deliver(payload())),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(processor.processed).toHaveLength(1);
  });

  it('V11: processes concurrent redeliveries of an unprocessed event exactly once', async () => {
    // The event exists from an earlier failed attempt, so the insert doesn't serialise them:
    // only the row lock does.
    await db.query(
      `INSERT INTO verification_webhook_events
         (event_key, webhook_type, provider_session_id, provider_status, error)
       VALUES ('b5f6e2a0-0000-4000-8000-000000000001', 'status.updated', 's', 'Approved', 'earlier failure')`,
    );
    processor.onProcess = () =>
      new Promise((resolve) => setTimeout(resolve, 50));

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => deliver(payload())),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(processor.processed).toHaveLength(1);
  });

  it('V11: re-processes an event that was recorded but never processed', async () => {
    await db.query(
      `INSERT INTO verification_webhook_events
         (event_key, webhook_type, provider_session_id, provider_status, error)
       VALUES ('b5f6e2a0-0000-4000-8000-000000000001', 'status.updated', 's', 'Approved', 'earlier failure')`,
    );

    await deliver(payload()).expect(200);

    expect(processor.processed).toHaveLength(1);
    expect(await events()).toMatchObject([{ processed: true, error: null }]);
  });

  it('returns 500 on a processing failure, keeps the event unprocessed with its error, and a retry succeeds', async () => {
    processor.failWith = new Error('database hiccup');

    const failed = await deliver(payload()).expect(500);

    expect(failed.body).toEqual({ code: 'WEBHOOK_PROCESSING_FAILED' });
    expect(await events()).toMatchObject([
      { processed: false, error: 'Error: database hiccup' },
    ]);

    processor.failWith = null;
    await deliver(payload()).expect(200);

    expect(processor.processed).toHaveLength(1);
    expect(await events()).toMatchObject([{ processed: true, error: null }]);
  });

  it('rolls back the processor’s writes when processing fails', async () => {
    processor.onProcess = (manager) =>
      manager
        .query(`INSERT INTO users (phone) VALUES ('+251911000099')`)
        .then(() => undefined);
    processor.failWith = new Error('after writing');

    await deliver(payload()).expect(500);

    expect(await db.query(`SELECT * FROM users`)).toHaveLength(0);
  });

  it('records other webhook types as processed without calling the processor', async () => {
    await deliver(payload({ webhook_type: 'user.status.updated' })).expect(200);

    expect(processor.processed).toHaveLength(0);
    expect(await events()).toMatchObject([
      { webhook_type: 'user.status.updated', processed: true },
    ]);
  });

  it('passes data.updated events to the processor', async () => {
    await deliver(payload({ webhook_type: 'data.updated' })).expect(200);

    expect(processor.processed.map((e) => e.webhookType)).toEqual([
      'data.updated',
    ]);
  });

  describe('rejections (nothing stored, processor not called)', () => {
    const expectNothingDone = async () => {
      expect(processor.processed).toHaveLength(0);
      expect(await events()).toHaveLength(0);
    };

    it('rejects a forged signature with 401', async () => {
      const response = await deliver(payload(), {
        secret: 'not-the-real-secret',
      }).expect(401);

      expect(response.body).toEqual({ code: 'WEBHOOK_SIGNATURE_INVALID' });
      await expectNothingDone();
    });

    it('rejects a payload changed after signing with 401', async () => {
      const body = payload();
      const raw = JSON.stringify({ ...body, status: 'Declined' });
      const v2 = createHmac('sha256', TEST_ENV.DIDIT_WEBHOOK_SECRET)
        .update(canonicalJson(body))
        .digest('hex');

      await request(app.getHttpServer())
        .post('/webhooks/didit')
        .set('content-type', 'application/json')
        .set('x-timestamp', String(nowSeconds()))
        .set('x-signature-v2', v2)
        .send(raw)
        .expect(401);
      await expectNothingDone();
    });

    it('rejects a delivery with no signature headers with 401', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/didit')
        .set('content-type', 'application/json')
        .send(JSON.stringify(payload()))
        .expect(401);
      await expectNothingDone();
    });

    it('rejects a stale timestamp (> 5 minutes) with 401', async () => {
      await deliver(payload(), { timestamp: nowSeconds() - 301 }).expect(401);
      await expectNothingDone();
    });

    it('rejects an event from the other environment with 400 and logs a warning', async () => {
      const response = await deliver(payload({ environment: 'live' })).expect(
        400,
      );

      expect(response.body).toEqual({ code: 'WEBHOOK_ENVIRONMENT_MISMATCH' });
      await expectNothingDone();
    });

    it.each([
      ['no event_id', { event_id: undefined }],
      ['a numeric status', { status: 7 }],
      ['an empty session_id', { session_id: '' }],
      ['no environment', { environment: undefined }],
    ])(
      'rejects a signed payload with %s as WEBHOOK_INVALID_PAYLOAD (400)',
      async (_label, overrides) => {
        const response = await deliver(payload(overrides)).expect(400);

        expect(response.body).toEqual({ code: 'WEBHOOK_INVALID_PAYLOAD' });
        await expectNothingDone();
      },
    );
  });

  it('accepts the raw X-Signature fallback when V2 is absent', async () => {
    const body = payload();
    const raw = JSON.stringify(body);
    const signature = createHmac('sha256', TEST_ENV.DIDIT_WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');

    await request(app.getHttpServer())
      .post('/webhooks/didit')
      .set('content-type', 'application/json')
      .set('x-timestamp', String(nowSeconds()))
      .set('x-signature', signature)
      .send(raw)
      .expect(200);

    expect(processor.processed).toHaveLength(1);
  });

  it('is not rate-limited', async () => {
    const statuses = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        deliver(
          payload({
            event_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          }),
        ).then((r) => r.status),
      ),
    );

    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});
