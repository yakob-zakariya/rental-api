import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import {
  hashIdentity,
  IdentityHasher,
  IdentityHashInputError,
  normaliseIdNumber,
} from './identity-hasher.js';
import { IdentityKind } from './verification.enums.js';

const PEPPER = 'test-id-hash-pepper-0123456789abcdef';
const { FaydaFin, FaydaFan, Passport } = IdentityKind;

/** The spec's formula, computed independently of the code under test. */
const expected = (input: string, pepper = PEPPER) =>
  createHmac('sha256', pepper).update(input, 'utf8').digest('hex');

describe('normaliseIdNumber (V10)', () => {
  it.each([
    ['EP1234567', 'EP1234567'],
    ['ep1234567', 'EP1234567'],
    ['ep 123-4567', 'EP1234567'],
    ['EP\t123\n4567', 'EP1234567'],
    ['EP 1234567', 'EP1234567'], // non-breaking space
    ['EP–1234567', 'EP1234567'], // en dash
    ['EP—1234567', 'EP1234567'], // em dash
    ['EP‐1234567', 'EP1234567'], // U+2010 hyphen
    ['EP−1234567', 'EP−1234567'], // minus sign is math, not dash punctuation: kept
    ['ＥＰ１２３４５６７', 'EP1234567'], // full-width letters and digits (NFKC)
    ['  1234 5678 9012  ', '123456789012'],
  ])('%j → %j', (raw, normalised) => {
    expect(normaliseIdNumber(raw)).toBe(normalised);
  });
});

describe('hashIdentity (hard rule 2, V10)', () => {
  it('hashes a Fayda FIN as HMAC(pepper, "fayda_fin:" + number)', () => {
    expect(
      hashIdentity(PEPPER, { kind: FaydaFin, number: '123456789012' }),
    ).toBe(expected('fayda_fin:123456789012'));
  });

  it('hashes a Fayda FAN as HMAC(pepper, "fayda_fan:" + number)', () => {
    expect(
      hashIdentity(PEPPER, { kind: FaydaFan, number: '1234567890123456' }),
    ).toBe(expected('fayda_fan:1234567890123456'));
  });

  it('hashes a passport as HMAC(pepper, "passport:" + country + ":" + number)', () => {
    expect(
      hashIdentity(PEPPER, {
        kind: Passport,
        number: 'EP1234567',
        country: 'ETH',
      }),
    ).toBe(expected('passport:ETH:EP1234567'));
  });

  it('returns 64 lowercase hex characters', () => {
    expect(hashIdentity(PEPPER, { kind: FaydaFin, number: '1' })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it.each([
    ['an en dash', 'EP–123–4567'],
    ['a U+2010 hyphen', 'EP‐123‐4567'],
    ['full-width digits', 'EP１２３４５６７'],
    ['spaces, a hyphen and lowercase', 'ep 123-4567'],
  ])('gives %s the same hash as the plain ASCII form', (_label, number) => {
    const plain = hashIdentity(PEPPER, {
      kind: Passport,
      number: 'EP1234567',
      country: 'ETH',
    });

    expect(
      hashIdentity(PEPPER, { kind: Passport, number, country: 'ETH' }),
    ).toBe(plain);
  });

  it('gives a full-width Fayda number the same hash as the ASCII digits', () => {
    expect(
      hashIdentity(PEPPER, {
        kind: FaydaFin,
        number: '１２３４ ５６７８ ９０１２',
      }),
    ).toBe(hashIdentity(PEPPER, { kind: FaydaFin, number: '123456789012' }));
  });

  it('distinguishes FIN from FAN for the same digits (the kind is part of the input)', () => {
    expect(
      hashIdentity(PEPPER, { kind: FaydaFin, number: '123456789012' }),
    ).not.toBe(
      hashIdentity(PEPPER, { kind: FaydaFan, number: '123456789012' }),
    );
  });

  it('distinguishes the same passport number from different countries', () => {
    expect(
      hashIdentity(PEPPER, {
        kind: Passport,
        number: 'A1234567',
        country: 'ETH',
      }),
    ).not.toBe(
      hashIdentity(PEPPER, {
        kind: Passport,
        number: 'A1234567',
        country: 'KEN',
      }),
    );
  });

  it('accepts a lowercase or padded country', () => {
    const upper = hashIdentity(PEPPER, {
      kind: Passport,
      number: 'EP1',
      country: 'ETH',
    });

    expect(
      hashIdentity(PEPPER, { kind: Passport, number: 'EP1', country: 'eth' }),
    ).toBe(upper);
    expect(
      hashIdentity(PEPPER, { kind: Passport, number: 'EP1', country: ' ETH ' }),
    ).toBe(upper);
  });

  it('depends on the pepper', () => {
    const identifier = { kind: FaydaFin, number: '123456789012' } as const;

    expect(hashIdentity(PEPPER, identifier)).not.toBe(
      hashIdentity(`${PEPPER}x`, identifier),
    );
  });

  describe('rejects bad input without revealing the number', () => {
    const SECRET_NUMBER = 'EP7654321';

    const failureOf = (call: () => unknown) => {
      try {
        call();
      } catch (error) {
        expect(error).toBeInstanceOf(IdentityHashInputError);
        const text = `${(error as Error).message} ${(error as Error).stack}`;
        expect(text).not.toContain(SECRET_NUMBER);
        expect(text).not.toContain('7654321');
        return (error as Error).message;
      }
      throw new Error('expected hashIdentity to throw');
    };

    it.each(['', 'ET', 'ETHI', 'E1H', 'É T H', '   '])(
      'rejects country %j',
      (country) => {
        expect(
          failureOf(() =>
            hashIdentity(PEPPER, {
              kind: Passport,
              number: SECRET_NUMBER,
              country,
            }),
          ),
        ).toContain('alpha-3');
      },
    );

    it.each(['', '   ', '-', ' –   ', '\t'])(
      'rejects number %j as empty',
      (number) => {
        expect(
          failureOf(() => hashIdentity(PEPPER, { kind: FaydaFin, number })),
        ).toBe('ID number is empty');
      },
    );
  });
});

describe('IdentityHasher', () => {
  it('hashes with ID_HASH_PEPPER from config', () => {
    const config = { get: vi.fn().mockReturnValue(PEPPER) };
    const hasher = new IdentityHasher(
      config as unknown as ConfigService<never, true>,
    );

    expect(hasher.hash({ kind: FaydaFin, number: '123456789012' })).toBe(
      expected('fayda_fin:123456789012'),
    );
    expect(config.get).toHaveBeenCalledWith('ID_HASH_PEPPER', { infer: true });
  });
});
