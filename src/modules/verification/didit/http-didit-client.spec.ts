import { DiditApiError } from './didit-api.error.js';
import { DiditStatus } from './didit.types.js';
import { HttpDiditClient } from './http-didit-client.js';

// Never calls Didit: fetch is stubbed in every test.
const API_KEY = 'secret-didit-api-key-do-not-leak';
const OPTIONS = {
  baseUrl: 'https://verification.didit.me',
  apiKey: API_KEY,
  workflowId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  callbackUrl: 'https://app.example.test/verification/done',
};
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const fetchMock = vi.fn<typeof fetch>();

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Runs `call`, expecting a DiditApiError, and checks no secret or body leaked into it. */
const failureOf = async (
  call: () => Promise<unknown>,
  ...mustNotContain: string[]
) => {
  const error = await call().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DiditApiError);
  const text = `${(error as Error).message} ${JSON.stringify(error)} ${(error as Error).stack}`;
  for (const secret of [API_KEY, ...mustNotContain])
    expect(text).not.toContain(secret);
  return error as DiditApiError;
};

describe('HttpDiditClient', () => {
  let client: HttpDiditClient;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    client = new HttpDiditClient(OPTIONS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const lastRequest = () => {
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    // HttpDiditClient always passes a URL object.
    return { url: (url as URL).href, init: init! };
  };

  describe('createSession', () => {
    const created = {
      session_id: SESSION_ID,
      session_number: 43762,
      session_token: '3FaJ9wLqX2Mz',
      url: 'https://verify.didit.me/session/3FaJ9wLqX2Mz',
      vendor_data: 'user-1',
      metadata: null,
      status: 'Not Started',
      workflow_id: OPTIONS.workflowId,
      workflow_version: 3,
      callback: OPTIONS.callbackUrl,
    };

    it('POSTs /v3/session/ with the API key, workflow, vendor_data, callback and document types', async () => {
      fetchMock.mockResolvedValueOnce(json(201, created));

      await client.createSession({ vendorData: 'user-1' });

      const { url, init } = lastRequest();
      expect(url).toBe('https://verification.didit.me/v3/session/');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'x-api-key': API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      });
      expect(JSON.parse(init.body as string)).toEqual({
        workflow_id: OPTIONS.workflowId,
        vendor_data: 'user-1',
        callback: OPTIONS.callbackUrl,
        expected_details: { expected_document_types: ['ID', 'P'] },
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('maps the response to camelCase and keeps only what we use', async () => {
      fetchMock.mockResolvedValueOnce(json(201, created));

      expect(await client.createSession({ vendorData: 'user-1' })).toEqual({
        sessionId: SESSION_ID,
        sessionToken: '3FaJ9wLqX2Mz',
        url: 'https://verify.didit.me/session/3FaJ9wLqX2Mz',
        status: DiditStatus.NotStarted,
      });
    });

    it('rejects a 2xx response missing required fields as invalid_response', async () => {
      fetchMock.mockResolvedValueOnce(
        json(201, { ...created, url: undefined }),
      );

      const error = await failureOf(() =>
        client.createSession({ vendorData: 'user-1' }),
      );
      expect(error.kind).toBe('invalid_response');
    });
  });

  describe('getDecision', () => {
    // Shaped like Didit's documented decision, including the fields we must drop.
    const decision = {
      session_id: SESSION_ID,
      session_number: 43762,
      session_url: 'https://verify.didit.me/session/3FaJ9wLqX2Mz',
      status: 'Approved',
      workflow_id: OPTIONS.workflowId,
      vendor_data: 'user-1',
      metadata: { secret: 'meta' },
      contact_details: { email: 'person@example.com' },
      id_verifications: [
        {
          node_id: 'feature_ocr_1',
          status: 'Approved',
          document_type: 'Identity Card',
          document_subtype: 'ID_CARD_GENERIC',
          document_number: '123456789012',
          personal_number: '1234567890123456',
          date_of_birth: '1990-05-17',
          age: 36,
          issuing_state: 'ETH',
          issuing_state_name: 'Ethiopia',
          first_name: 'Abebe',
          last_name: 'Kebede',
          full_name: 'Abebe Kebede',
          address: 'Bole, Addis Ababa',
          nationality: 'ETH',
          portrait_image: 'https://cdn.didit.me/portrait.jpg?sig=1',
          front_image: 'https://cdn.didit.me/front.jpg?sig=2',
          back_image: 'https://cdn.didit.me/back.jpg?sig=3',
          mrz: { document_number: '123456789012' },
          warnings: [],
        },
      ],
      liveness_checks: [
        {
          status: 'Approved',
          reference_image: 'https://cdn.didit.me/face.jpg',
        },
      ],
      face_matches: [
        { status: 'Approved', source_image: 'https://cdn.didit.me/a.jpg' },
      ],
      ip_analyses: [{ status: 'Approved', ip_address: '196.188.0.1' }],
    };

    it('GETs /v3/session/{id}/decision/ with the API key and no body', async () => {
      fetchMock.mockResolvedValueOnce(json(200, decision));

      await client.getDecision(SESSION_ID);

      const { url, init } = lastRequest();
      expect(url).toBe(
        `https://verification.didit.me/v3/session/${SESSION_ID}/decision/`,
      );
      expect(init.method).toBe('GET');
      expect(init.headers).toMatchObject({ 'x-api-key': API_KEY });
      expect(init.body).toBeUndefined();
    });

    it('returns only the allow-listed fields: no images, address, MRZ or other features (hard rule 1)', async () => {
      fetchMock.mockResolvedValueOnce(json(200, decision));

      const result = await client.getDecision(SESSION_ID);

      expect(result).toEqual({
        sessionId: SESSION_ID,
        status: DiditStatus.Approved,
        vendorData: 'user-1',
        idVerifications: [
          {
            status: 'Approved',
            documentType: 'Identity Card',
            documentSubtype: 'ID_CARD_GENERIC',
            documentNumber: '123456789012',
            personalNumber: '1234567890123456',
            issuingState: 'ETH',
            dateOfBirth: '1990-05-17',
            fullName: 'Abebe Kebede',
            firstName: 'Abebe',
            lastName: 'Kebede',
          },
        ],
      });
      const text = JSON.stringify(result);
      for (const leaked of [
        'cdn.didit.me',
        'Bole',
        'person@example.com',
        '196.188',
        'meta',
      ]) {
        expect(text).not.toContain(leaked);
      }
    });

    it('treats a missing id_verifications (feature not run yet) as an empty list', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, {
          session_id: SESSION_ID,
          status: 'In Progress',
          vendor_data: 'user-1',
          id_verifications: null,
        }),
      );

      expect((await client.getDecision(SESSION_ID)).idVerifications).toEqual(
        [],
      );
    });

    it('turns missing, empty or non-string fields into null', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, {
          session_id: SESSION_ID,
          status: 'Approved',
          id_verifications: [
            {
              document_type: 'Passport',
              document_number: '',
              issuing_state: 123,
            },
          ],
        }),
      );

      const [item] = (await client.getDecision(SESSION_ID)).idVerifications;
      expect(item.documentType).toBe('Passport');
      expect(item.documentNumber).toBeNull();
      expect(item.issuingState).toBeNull();
      expect(item.dateOfBirth).toBeNull();
    });

    it('keeps an unknown status string as received', async () => {
      fetchMock.mockResolvedValueOnce(
        json(200, { session_id: SESSION_ID, status: 'Some Future Status' }),
      );

      expect((await client.getDecision(SESSION_ID)).status).toBe(
        'Some Future Status',
      );
    });

    it('encodes the session id into the path', async () => {
      fetchMock.mockResolvedValueOnce(json(200, decision));

      await client.getDecision('../billing/balance');

      expect(lastRequest().url).toBe(
        'https://verification.didit.me/v3/session/..%2Fbilling%2Fbalance/decision/',
      );
    });
  });

  describe('errors', () => {
    const personalBody = { detail: 'Abebe Kebede 123456789012 is blocked' };

    it.each([401, 403])(
      'maps %i to kind auth with a "check DIDIT_API_KEY" hint',
      async (status) => {
        fetchMock.mockResolvedValueOnce(
          json(status, { detail: 'You do not have permission' }),
        );

        const error = await failureOf(() => client.getDecision(SESSION_ID));
        expect(error.kind).toBe('auth');
        expect(error.status).toBe(status);
        expect(error.message).toContain('check DIDIT_API_KEY');
      },
    );

    it.each([
      [400, 'bad_request'],
      [404, 'not_found'],
      [500, 'server'],
      [503, 'server'],
    ] as const)(
      'maps %i to kind %s without including the response body',
      async (status, kind) => {
        fetchMock.mockResolvedValueOnce(json(status, personalBody));

        const error = await failureOf(
          () => client.createSession({ vendorData: 'user-1' }),
          'Abebe',
          '123456789012',
        );
        expect(error.kind).toBe(kind);
        expect(error.status).toBe(status);
      },
    );

    it('maps 429 to rate_limited with Retry-After in seconds', async () => {
      fetchMock.mockResolvedValueOnce(json(429, {}, { 'retry-after': '30' }));

      const error = await failureOf(() =>
        client.createSession({ vendorData: 'user-1' }),
      );
      expect(error.kind).toBe('rate_limited');
      expect(error.retryAfterSeconds).toBe(30);
    });

    it('reads a Retry-After given as an HTTP date', async () => {
      const at = new Date(Date.now() + 90_000).toUTCString();
      fetchMock.mockResolvedValueOnce(json(429, {}, { 'retry-after': at }));

      const error = await failureOf(() =>
        client.createSession({ vendorData: 'user-1' }),
      );
      expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(88);
      expect(error.retryAfterSeconds).toBeLessThanOrEqual(90);
    });

    it('leaves retryAfterSeconds undefined when the header is missing', async () => {
      fetchMock.mockResolvedValueOnce(json(429, {}));

      const error = await failureOf(() =>
        client.createSession({ vendorData: 'user-1' }),
      );
      expect(error.retryAfterSeconds).toBeUndefined();
    });

    it('times out after timeoutMs (10 s by default)', async () => {
      client = new HttpDiditClient({ ...OPTIONS, timeoutMs: 20 });
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () =>
              reject(init!.signal!.reason),
            );
          }),
      );

      const error = await failureOf(() => client.getDecision(SESSION_ID));
      expect(error.kind).toBe('timeout');
      expect(error.message).toContain('timed out after 20 ms');
    });

    it('maps a connection failure to kind network', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

      const error = await failureOf(() => client.getDecision(SESSION_ID));
      expect(error.kind).toBe('network');
    });

    it.each([
      ['not JSON', new Response('<html>oops</html>', { status: 200 })],
      ['a JSON array', json(200, [])],
      ['missing status', json(200, { session_id: SESSION_ID })],
      [
        'id_verifications not an array',
        json(200, {
          session_id: SESSION_ID,
          status: 'Approved',
          id_verifications: {},
        }),
      ],
    ])(
      'maps a 2xx body that is %s to invalid_response',
      async (_label, response) => {
        fetchMock.mockResolvedValueOnce(response);

        const error = await failureOf(() => client.getDecision(SESSION_ID));
        expect(error.kind).toBe('invalid_response');
      },
    );
  });
});
