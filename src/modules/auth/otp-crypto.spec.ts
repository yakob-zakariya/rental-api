import { createHmac, randomInt } from 'node:crypto';
import { generateOtpCode, hashOtpCode, otpCodeMatches } from './otp-crypto.js';

// ESM namespaces can't be spied on; wrap the real randomInt so one test can pin its value.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

const SECRET = 'test-otp-hash-secret-0123456789abcdef';
const PHONE = '+251911234567';

describe('generateOtpCode', () => {
  it('always returns exactly 6 digits', () => {
    for (let i = 0; i < 2000; i++) expect(generateOtpCode()).toMatch(/^\d{6}$/);
  });

  it('keeps leading zeros', () => {
    vi.mocked(randomInt).mockReturnValueOnce(42 as never);

    expect(generateOtpCode()).toBe('000042');
  });
});

describe('hashOtpCode', () => {
  it('is HMAC_SHA256(secret, phone + ":" + code) in hex (rule A9)', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`${PHONE}:123456`)
      .digest('hex');

    expect(hashOtpCode(SECRET, PHONE, '123456')).toBe(expected);
  });

  it('depends on the phone, so a hash is useless for another number', () => {
    expect(hashOtpCode(SECRET, PHONE, '123456')).not.toBe(
      hashOtpCode(SECRET, '+251711234567', '123456'),
    );
  });
});

describe('otpCodeMatches', () => {
  const stored = hashOtpCode(SECRET, PHONE, '123456');

  it('matches the right code', () => {
    expect(otpCodeMatches(SECRET, PHONE, '123456', stored)).toBe(true);
  });

  it.each([
    ['wrong code', '654321'],
    ['too short', '12345'],
    ['too long', '1234567'],
    ['not digits', '12345a'],
    ['empty', ''],
  ])('rejects a %s without throwing', (_label, code) => {
    expect(otpCodeMatches(SECRET, PHONE, code, stored)).toBe(false);
  });

  it('rejects when the secret differs', () => {
    expect(otpCodeMatches(`${SECRET}x`, PHONE, '123456', stored)).toBe(false);
  });

  it('rejects a malformed stored hash without throwing', () => {
    expect(otpCodeMatches(SECRET, PHONE, '123456', 'abc')).toBe(false);
  });
});
