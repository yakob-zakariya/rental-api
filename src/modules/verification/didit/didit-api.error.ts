export type DiditApiErrorKind =
  /** 401/403: the API key is missing, wrong, expired or lacks the privilege. */
  | 'auth'
  | 'bad_request'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'network'
  /** 2xx, but the body isn't the JSON shape we expect. */
  | 'invalid_response';

/**
 * A failed Didit call. Messages say what went wrong and where, but never include response
 * bodies (they can contain personal data) or the API key.
 */
export class DiditApiError extends Error {
  readonly name = 'DiditApiError';

  constructor(
    readonly kind: DiditApiErrorKind,
    message: string,
    readonly status?: number,
    /** From Retry-After on a 429, in seconds. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}
