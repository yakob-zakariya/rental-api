import { createHmac, timingSafeEqual } from 'node:crypto';

// Didit webhook signatures (docs/didit-integration.md §3, https://docs.didit.me/integration/webhooks).
// X-Signature-V2 = HMAC-SHA256(secret, canonical JSON of the parsed body), lowercase hex.
// X-Signature    = HMAC-SHA256(secret, raw request bytes) — fallback only.
// X-Signature-Simple is deliberately NOT accepted: it doesn't cover `decision`.

export const SIGNATURE_MAX_SKEW_SECONDS = 300;

export type SignatureCheck =
  | { ok: true; via: 'v2' | 'raw' }
  | { ok: false; reason: 'missing_headers' | 'stale' | 'bad_signature' };

type Headers = Record<string, string | string[] | undefined>;

/**
 * Didit's V2 canonical form: object keys sorted recursively, compact, Unicode unescaped.
 * Whole-valued floats need no handling here: JSON.parse already turns 100.0 into 100.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Checks a delivery: X-Timestamp within ±300 s, then X-Signature-V2 over the canonical body, then
 * X-Signature over the raw bytes. Each also matches its `-Previous` header (sent for 24 h after a
 * secret rotation, signed with the old secret).
 */
export function verifyDiditSignature(input: {
  headers: Headers;
  body: unknown;
  rawBody?: Buffer;
  secret: string;
  nowSeconds: number;
}): SignatureCheck {
  const { headers, body, rawBody, secret, nowSeconds } = input;
  const timestamp = first(headers['x-timestamp']);
  const v2 = signatures(headers, 'x-signature-v2');
  const raw = signatures(headers, 'x-signature');
  if (!timestamp || (v2.length === 0 && raw.length === 0)) {
    return { ok: false, reason: 'missing_headers' };
  }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'stale' };
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'stale' };
  }

  if (v2.length > 0 && body !== undefined) {
    const expected = hmacHex(secret, canonicalJson(body));
    if (v2.some((signature) => safeEqual(signature, expected)))
      return { ok: true, via: 'v2' };
  }
  if (raw.length > 0 && rawBody) {
    const expected = hmacHex(secret, rawBody);
    if (raw.some((signature) => safeEqual(signature, expected)))
      return { ok: true, via: 'raw' };
  }
  return { ok: false, reason: 'bad_signature' };
}

function signatures(headers: Headers, name: string): string[] {
  return [first(headers[name]), first(headers[`${name}-previous`])]
    .filter((value): value is string => !!value)
    .map((value) => value.trim().toLowerCase());
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
