import { BadRequestException } from '@nestjs/common';
import {
  assertSafeDetails,
  containsIdNumber,
  MAX_DETAIL_LENGTH,
} from './audit-details.js';

describe('containsIdNumber', () => {
  it.each([
    ['a Fayda FIN', 'checked 123456789012 in Didit'],
    ['a FAN', 'FAN 1234567890123456'],
    ['exactly 9 digits', 'ref 123456789'],
    ['digits split by spaces', 'number 1234 5678 9012'],
    ['digits split by dashes', 'number 1234-5678-9012'],
    ['an en dash and a non-breaking space', 'number 1234–5678 9012'],
    ['full-width digits', 'number １２３４５６７８９０１２'],
    ['full-width digits with spaces', '１２３ ４５６ ７８９'],
    ['a passport number', 'passport EP1234567 looked fine'],
    ['a passport with one letter', 'A1234567'],
    ['a passport with a space', 'passport EP 1234567'],
    ['a passport with a dash', 'passport EP-123-4567'],
    ['a passport in full-width', 'ＥＰ１２３４５６７'],
    ['a passport in lowercase', 'ep1234567'],
    // The capital-letter rule only decides when separators are joined; the match itself ignores case.
    ['a lowercase passport in a note, no separators', 'note: ep1234567'],
    ['a lowercase passport right after punctuation', 'note:ep1234567'],
    ['a mixed-case passport', 'Ep1234567'],
    [
      'a lowercase passport with dashes only between digits',
      'note: ep123-4567',
    ],
    ['a phone number', 'called 0911 234 567'],
  ])('flags %s', (_label, text) => {
    expect(containsIdNumber(text)).toBe(true);
  });

  it.each([
    ['plain text', 'Photo was blurry, asked the user to retry'],
    ['a date', 'seen on 2026-10-31'],
    ['8 digits', 'ref 12345678'],
    ['short numbers', 'attempt 3 of 3, age 17'],
    ['a word then a short number', 'room A12345'],
    ['a longer word before digits', 'code123456'],
    ['a lowercase word, a space, then a number', 'on 2026-10-31 and at 123456'],
    // Not joined across a separator after lowercase letters (so ordinary words stay words).
    ['lowercase letters, a space, then 7 digits', 'note: ep 1234567'],
    ['Amharic text', 'ፎቶው ግልጽ አይደለም'],
    ['empty', ''],
  ])('allows %s', (_label, text) => {
    expect(containsIdNumber(text)).toBe(false);
  });
});

describe('assertSafeDetails', () => {
  it('accepts the allowed keys', () => {
    expect(() =>
      assertSafeDetails({
        reason: 'Fraud report',
        note: 'Name matched the console',
        reasonCode: 'PHOTO_UNCLEAR',
        enteredFields: ['idNumber', 'dateOfBirth'],
        previousOutcome: 'manual_review',
        newOutcome: 'approved',
      }),
    ).not.toThrow();
    expect(() => assertSafeDetails({})).not.toThrow();
  });

  it.each(['reason', 'note', 'reasonCode'] as const)(
    'rejects an ID number in %s with 400 NOTE_CONTAINS_ID_NUMBER',
    (key) => {
      try {
        assertSafeDetails({ [key]: 'number 123456789012' });
        throw new Error('expected a rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toEqual({
          code: 'NOTE_CONTAINS_ID_NUMBER',
        });
      }
    },
  );

  it('rejects unknown keys (no ID number under another name)', () => {
    expect(() => assertSafeDetails({ idNumber: '123' } as never)).toThrow(
      'may not contain "idNumber"',
    );
  });

  it('rejects a field value in enteredFields (names only)', () => {
    expect(() => assertSafeDetails({ enteredFields: ['EP 1234567'] })).toThrow(
      'field names',
    );
    expect(() =>
      assertSafeDetails({ enteredFields: 'idNumber' as never }),
    ).toThrow('field names');
  });

  it('rejects over-long or non-string text', () => {
    expect(() =>
      assertSafeDetails({ note: 'x'.repeat(MAX_DETAIL_LENGTH + 1) }),
    ).toThrow('at most');
    expect(() => assertSafeDetails({ note: 42 as never })).toThrow(
      'must be a string',
    );
  });
});
