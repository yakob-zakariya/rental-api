import { DiditApiError } from './didit-api.error.js';
import { DiditClient } from './didit-client.js';
import { trimIdVerifications } from './decision-parser.js';
import {
  type DiditDecision,
  type DiditSession,
  EXPECTED_DOCUMENT_TYPES,
} from './didit.types.js';

export interface DiditClientOptions {
  baseUrl: string;
  apiKey: string;
  workflowId: string;
  callbackUrl: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;

/**
 * Didit Sessions API v3 over fetch (docs/didit-integration.md §1).
 * - POST /v3/session/                     → createSession
 * - GET  /v3/session/{id}/decision/       → getDecision
 * Auth is the `x-api-key` header. Responses are mapped to our camelCase types and trimmed by
 * trimIdVerifications: nothing else from Didit's payload (images, address, MRZ, …) leaves it.
 */
export class HttpDiditClient extends DiditClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: DiditClientOptions) {
    super();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createSession({
    vendorData,
  }: {
    vendorData: string;
  }): Promise<DiditSession> {
    const body = await this.request('POST', '/v3/session/', {
      workflow_id: this.options.workflowId,
      vendor_data: vendorData,
      callback: this.options.callbackUrl,
      expected_details: {
        expected_document_types: [...EXPECTED_DOCUMENT_TYPES],
      },
    });

    const session = {
      sessionId: str(body.session_id),
      sessionToken: str(body.session_token),
      url: str(body.url),
      status: str(body.status),
    };
    if (
      !session.sessionId ||
      !session.sessionToken ||
      !session.url ||
      !session.status
    ) {
      throw invalidResponse('POST /v3/session/');
    }
    return session as DiditSession;
  }

  async getDecision(sessionId: string): Promise<DiditDecision> {
    const path = `/v3/session/${encodeURIComponent(sessionId)}/decision/`;
    const body = await this.request('GET', path);

    const id = str(body.session_id);
    const status = str(body.status);
    const items = body.id_verifications ?? [];
    if (!id || !status || !Array.isArray(items))
      throw invalidResponse(`GET ${path}`);

    return {
      sessionId: id,
      status,
      vendorData: str(body.vendor_data),
      idVerifications: trimIdVerifications(items),
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload?: Json,
  ): Promise<Json> {
    const label = `${method} ${path}`;
    let response: Response;
    try {
      response = await fetch(new URL(path, this.options.baseUrl), {
        method,
        headers: {
          'x-api-key': this.options.apiKey,
          accept: 'application/json',
          ...(payload && { 'content-type': 'application/json' }),
        },
        ...(payload && { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new DiditApiError(
        timedOut ? 'timeout' : 'network',
        timedOut
          ? `Didit ${label} timed out after ${this.timeoutMs} ms`
          : `Didit ${label} failed: network error`,
      );
    }

    if (!response.ok) throw errorFor(label, response);

    try {
      const json: unknown = await response.json();
      if (isObject(json)) return json;
    } catch {
      // fall through
    }
    throw invalidResponse(label);
  }
}

function errorFor(label: string, response: Response): DiditApiError {
  const { status } = response;
  if (status === 401 || status === 403) {
    return new DiditApiError(
      'auth',
      `Didit ${label} was refused (${status}): check DIDIT_API_KEY`,
      status,
    );
  }
  if (status === 404)
    return new DiditApiError('not_found', `Didit ${label}: not found`, status);
  if (status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    return new DiditApiError(
      'rate_limited',
      `Didit ${label} was rate limited (429)`,
      status,
      retryAfter,
    );
  }
  if (status >= 500) {
    return new DiditApiError(
      'server',
      `Didit ${label} failed (${status})`,
      status,
    );
  }
  return new DiditApiError(
    'bad_request',
    `Didit ${label} was rejected (${status})`,
    status,
  );
}

/** Retry-After is either seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at)
    ? undefined
    : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

const invalidResponse = (label: string) =>
  new DiditApiError(
    'invalid_response',
    `Didit ${label} returned an unexpected response`,
  );

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
