import { validateSync } from 'class-validator';
import { CharLength, charCount, IsCalendarDate } from './validators.js';

class Sample {
  @CharLength(1, 3)
  text: unknown;

  @IsCalendarDate()
  date: unknown;
}

const errorsFor = (text: unknown, date: unknown = '2026-12-01') => {
  const sample = Object.assign(new Sample(), { text, date });
  return validateSync(sample).map((e) => e.property);
};

describe('CharLength (counts as Postgres does)', () => {
  it('counts an emoji as one character, where String.length counts two', () => {
    expect('🏠'.length).toBe(2);
    expect(charCount('🏠')).toBe(1);
    expect(errorsFor('🏠🏠🏠')).toEqual([]);
  });

  it('counts Amharic letters one each', () => {
    expect(errorsFor('ሀሁሂ')).toEqual([]);
    expect(errorsFor('ሀሁሂሃ')).toEqual(['text']);
  });

  it.each([[''], ['abcd'], [123], [null]])('refuses %j', (value) => {
    expect(errorsFor(value)).toEqual(['text']);
  });
});

describe('IsCalendarDate', () => {
  it.each(['2026-12-01', '2028-02-29'])('accepts %s', (date) => {
    expect(errorsFor('a', date)).toEqual([]);
  });

  it.each(['2027-02-29', '2026-13-01', '01/12/2026', '2026-12-1', 20261201])(
    'refuses %j',
    (date) => {
      expect(errorsFor('a', date)).toEqual(['date']);
    },
  );
});
