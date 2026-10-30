import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FakeDiditClient } from '../../../../test/fakes/fake-didit-client.js';
import { DiditApiError } from './didit-api.error.js';
import { DiditClient } from './didit-client.js';
import { DiditStatus } from './didit.types.js';
import { DiditModule } from './didit.module.js';
import { HttpDiditClient } from './http-didit-client.js';

describe('DiditModule', () => {
  it('provides HttpDiditClient configured from env, without calling Didit', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              DIDIT_BASE_URL: 'https://verification.didit.me',
              DIDIT_API_KEY: 'key',
              DIDIT_WORKFLOW_ID: 'workflow',
              APP_VERIFICATION_CALLBACK_URL: 'https://app.example.test/done',
            }),
          ],
        }),
        DiditModule,
      ],
    }).compile();

    expect(moduleRef.get(DiditClient)).toBeInstanceOf(HttpDiditClient);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('FakeDiditClient', () => {
  let didit: FakeDiditClient;

  beforeEach(() => {
    didit = new FakeDiditClient();
  });

  it('creates a Not Started session with a 12-character token', async () => {
    const session = await didit.createSession({ vendorData: 'user-1' });

    expect(session.status).toBe(DiditStatus.NotStarted);
    expect(session.sessionToken).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(session.url).toBe(
      `https://verify.didit.me/session/${session.sessionToken}`,
    );
    expect(didit.createdCount).toBe(1);
  });

  it.each([
    DiditStatus.NotStarted,
    DiditStatus.InProgress,
    DiditStatus.Resubmitted,
    DiditStatus.AwaitingUser,
  ])(
    'returns the existing session while it is %s (like Didit)',
    async (status) => {
      const first = await didit.createSession({ vendorData: 'user-1' });
      didit.setStatus(first.sessionId, status);

      const again = await didit.createSession({ vendorData: 'user-1' });

      expect(again.sessionId).toBe(first.sessionId);
      expect(didit.createdCount).toBe(1);
    },
  );

  it.each([
    DiditStatus.InReview,
    DiditStatus.Approved,
    DiditStatus.Declined,
    DiditStatus.Abandoned,
    DiditStatus.Expired,
    DiditStatus.KycExpired,
  ])('creates a new session once the old one is %s', async (status) => {
    const first = await didit.createSession({ vendorData: 'user-1' });
    didit.setStatus(first.sessionId, status);

    const again = await didit.createSession({ vendorData: 'user-1' });

    expect(again.sessionId).not.toBe(first.sessionId);
    expect(didit.createdCount).toBe(2);
  });

  it('keeps sessions per vendorData', async () => {
    const a = await didit.createSession({ vendorData: 'user-1' });
    const b = await didit.createSession({ vendorData: 'user-2' });

    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('returns scripted statuses and id verifications from getDecision', async () => {
    const { sessionId } = await didit.createSession({ vendorData: 'user-1' });
    didit.setStatus(sessionId, DiditStatus.Approved);
    didit.setIdVerifications(sessionId, [
      {
        documentType: 'Passport',
        documentNumber: 'EP1234567',
        issuingState: 'ETH',
      },
    ]);

    const decision = await didit.getDecision(sessionId);

    expect(decision).toMatchObject({
      sessionId,
      status: 'Approved',
      vendorData: 'user-1',
    });
    expect(decision.idVerifications[0]).toMatchObject({
      documentType: 'Passport',
      documentNumber: 'EP1234567',
      issuingState: 'ETH',
      personalNumber: null,
    });
  });

  it('rejects getDecision for an unknown session with not_found', async () => {
    await expect(didit.getDecision('nope')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('rejects the next call with a scripted error, then recovers', async () => {
    didit.failNextWith(new DiditApiError('rate_limited', 'slow down', 429, 30));

    await expect(
      didit.createSession({ vendorData: 'user-1' }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 30,
    });
    await expect(
      didit.createSession({ vendorData: 'user-1' }),
    ).resolves.toBeDefined();
  });
});
