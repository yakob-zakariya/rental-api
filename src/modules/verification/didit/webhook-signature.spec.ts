import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  SIGNATURE_MAX_SKEW_SECONDS,
  verifyDiditSignature,
} from './webhook-signature.js';

// Reference vector computed with Python, using exactly the calls from Didit's docs:
//   V2:  json.dumps(shorten_floats(body), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
//   raw: json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True)  (wire bytes)
// It covers Unicode (Spanish, Amharic, emoji), U+2028, quotes, "/", "<", a newline, nested
// objects, arrays, empty {} and [], booleans, null and a whole-valued float (100.0).
const FIXTURE_SECRET = 'fixture-webhook-secret';
// Written by Python (ASCII-escaped wire bytes); a .txt so no formatter can rewrite the escapes.
const FIXTURE_WIRE = readFileSync(
  join(import.meta.dirname, '__fixtures__', 'webhook-wire.txt'),
  'utf8',
);
const FIXTURE_V2 =
  '9db596a0b993be8c829f7fd1e380b8bd3561e9a7da2be01a47d3aebaa84ce1c8';
const FIXTURE_RAW =
  '26525016d9b4ea25fd86946ead9e1181f09c8d3772cf0e3162c4e4767b6be7bf';
const NOW = 1793400000;

const SECRET = 'webhook-secret';
const sign = (data: string, secret = SECRET) =>
  createHmac('sha256', secret).update(data).digest('hex');

const delivery = (
  overrides: {
    headers?: Record<string, string | undefined>;
    body?: unknown;
    rawBody?: Buffer;
  } = {},
) => {
  const body = overrides.body ?? { event_id: 'e1', status: 'Approved', n: 1 };
  const headers: Record<string, string | undefined> = {
    'x-timestamp': String(NOW),
    'x-signature-v2': sign(canonicalJson(body)),
    ...overrides.headers,
  };
  return {
    headers,
    body,
    rawBody: overrides.rawBody,
    secret: SECRET,
    nowSeconds: NOW,
  };
};

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order, and is compact', () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, 1, { z: 1, y: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[3,1,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps Unicode unescaped', () => {
    expect(canonicalJson({ name: 'José አበበ 😀' })).toBe(
      '{"name":"José አበበ 😀"}',
    );
  });

  it('writes a whole-valued float as an integer once parsed (Didit shortens 100.0 to 100)', () => {
    expect(canonicalJson(JSON.parse('{"score":100.0,"ratio":0.5}'))).toBe(
      '{"ratio":0.5,"score":100}',
    );
  });

  it('matches Python json.dumps(sort_keys, compact, ensure_ascii=False) on the reference payload', () => {
    const canonical = canonicalJson(JSON.parse(FIXTURE_WIRE));

    expect(sign(canonical, FIXTURE_SECRET)).toBe(FIXTURE_V2);
  });
});

describe('verifyDiditSignature', () => {
  it('accepts the Python-signed reference payload via X-Signature-V2', () => {
    expect(
      verifyDiditSignature({
        headers: { 'x-timestamp': String(NOW), 'x-signature-v2': FIXTURE_V2 },
        body: JSON.parse(FIXTURE_WIRE),
        secret: FIXTURE_SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true, via: 'v2' });
  });

  it('accepts the Python-signed reference payload via raw X-Signature only', () => {
    expect(
      verifyDiditSignature({
        headers: { 'x-timestamp': String(NOW), 'x-signature': FIXTURE_RAW },
        body: JSON.parse(FIXTURE_WIRE),
        rawBody: Buffer.from(FIXTURE_WIRE, 'utf8'),
        secret: FIXTURE_SECRET,
        nowSeconds: NOW,
      }),
    ).toEqual({ ok: true, via: 'raw' });
  });

  it('accepts a valid V2 signature', () => {
    expect(verifyDiditSignature(delivery())).toEqual({ ok: true, via: 'v2' });
  });

  it('accepts an uppercase hex signature', () => {
    const d = delivery();
    d.headers['x-signature-v2'] = d.headers['x-signature-v2']!.toUpperCase();

    expect(verifyDiditSignature(d)).toEqual({ ok: true, via: 'v2' });
  });

  it('accepts a match on X-Signature-V2-Previous (secret rotation)', () => {
    const body = { event_id: 'e1' };
    const d = delivery({
      body,
      headers: {
        'x-signature-v2': sign(
          canonicalJson(body),
          'the-new-secret-we-do-not-have-yet',
        ),
        'x-signature-v2-previous': sign(canonicalJson(body)),
      },
    });

    expect(verifyDiditSignature(d)).toEqual({ ok: true, via: 'v2' });
  });

  it('falls back to X-Signature (and its -Previous) when V2 does not match', () => {
    const raw = '{"event_id":"e1"}';
    const d = delivery({
      body: JSON.parse(raw),
      rawBody: Buffer.from(raw),
      headers: {
        'x-signature-v2': 'f'.repeat(64),
        'x-signature': 'e'.repeat(64),
        'x-signature-previous': sign(raw),
      },
    });

    expect(verifyDiditSignature(d)).toEqual({ ok: true, via: 'raw' });
  });

  it.each([
    [
      'a wrong secret',
      (d: ReturnType<typeof delivery>) => (d.secret = 'other'),
    ],
    [
      'a tampered body',
      (d: ReturnType<typeof delivery>) =>
        ((d.body as Record<string, unknown>).status = 'Declined'),
    ],
    [
      'a truncated signature',
      (d: ReturnType<typeof delivery>) =>
        (d.headers['x-signature-v2'] = d.headers['x-signature-v2']!.slice(
          0,
          63,
        )),
    ],
    [
      'X-Signature without a raw body',
      (d: ReturnType<typeof delivery>) => {
        d.headers['x-signature'] = d.headers['x-signature-v2'];
        d.headers['x-signature-v2'] = 'f'.repeat(64);
      },
    ],
  ])('rejects %s as bad_signature', (_label, mutate) => {
    const d = delivery();
    mutate(d);

    expect(verifyDiditSignature(d)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('never accepts X-Signature-Simple, even when it is valid', () => {
    const body = {
      timestamp: NOW,
      session_id: 's1',
      status: 'Approved',
      webhook_type: 'status.updated',
    };
    const simple = sign(`${NOW}:s1:Approved:status.updated`);
    const d = delivery({
      body,
      headers: { 'x-signature-v2': undefined, 'x-signature-simple': simple },
    });

    expect(verifyDiditSignature(d)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it.each([
    ['no X-Timestamp', { 'x-timestamp': undefined }],
    ['no signature headers', { 'x-signature-v2': undefined }],
  ])('rejects %s as missing_headers', (_label, headers) => {
    expect(verifyDiditSignature(delivery({ headers }))).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it.each([
    ['301 s old', NOW - SIGNATURE_MAX_SKEW_SECONDS - 1],
    ['301 s in the future', NOW + SIGNATURE_MAX_SKEW_SECONDS + 1],
  ])('rejects a timestamp %s as stale', (_label, timestamp) => {
    expect(
      verifyDiditSignature(
        delivery({ headers: { 'x-timestamp': String(timestamp) } }),
      ),
    ).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it.each([NOW - SIGNATURE_MAX_SKEW_SECONDS, NOW + SIGNATURE_MAX_SKEW_SECONDS])(
    'accepts a timestamp exactly 300 s away (%i)',
    (timestamp) => {
      expect(
        verifyDiditSignature(
          delivery({ headers: { 'x-timestamp': String(timestamp) } }),
        ).ok,
      ).toBe(true);
    },
  );

  it.each(['abc', '1.5', '-1', ''])(
    'rejects a non-numeric timestamp %j',
    (timestamp) => {
      const result = verifyDiditSignature(
        delivery({ headers: { 'x-timestamp': timestamp } }),
      );

      expect(result.ok).toBe(false);
    },
  );
});
