import { DECISION_TIME_ZONE, isIsoDate, isUnder18, todayIn } from './age.js';

describe('isIsoDate', () => {
  it.each(['1990-05-17', '2024-02-29', '2000-12-31'])('accepts %s', (date) => {
    expect(isIsoDate(date)).toBe(true);
  });

  it.each([
    '2023-02-29',
    '1990-13-01',
    '1990-00-10',
    '1990-05-32',
    '90-05-17',
    '1990/05/17',
    '1990-5-17',
    '',
    'x',
  ])('rejects %j', (date) => {
    expect(isIsoDate(date)).toBe(false);
  });
});

describe('isUnder18 (V4)', () => {
  it.each([
    ['the day before the 18th birthday', '2008-10-31', '2026-10-30', true],
    ['on the 18th birthday', '2008-10-31', '2026-10-31', false],
    ['the day after', '2008-10-31', '2026-11-01', false],
    ['a month before', '2008-11-30', '2026-10-31', true],
    ['an adult', '1990-05-17', '2026-10-31', false],
    ['a child', '2015-01-01', '2026-10-31', true],
    [
      'born 29 Feb, on 28 Feb of a non-leap 18th year',
      '2008-02-29',
      '2026-02-28',
      true,
    ],
    [
      'born 29 Feb, on 1 Mar of a non-leap 18th year',
      '2008-02-29',
      '2026-03-01',
      false,
    ],
    // (A leap year + 18 is never a leap year, so the 18th birthday of a 29 Feb baby is always 1 Mar.)
    [
      'born 29 Feb 2004, a day before turning 18',
      '2004-02-29',
      '2022-02-28',
      true,
    ],
  ])('%s', (_label, dob, on, expected) => {
    expect(isUnder18(dob, on)).toBe(expected);
  });

  it('rejects malformed dates instead of guessing', () => {
    expect(() => isUnder18('2008-02-30', '2026-10-31')).toThrow('YYYY-MM-DD');
    expect(() => isUnder18('1990-05-17', '31/10/2026')).toThrow('YYYY-MM-DD');
  });
});

describe('todayIn', () => {
  it('uses Africa/Addis_Ababa (UTC+3) for the decision date', () => {
    // 22:30 UTC on 30 Oct is already 31 Oct in Addis Ababa.
    expect(todayIn(DECISION_TIME_ZONE, new Date('2026-10-30T22:30:00Z'))).toBe(
      '2026-10-31',
    );
    expect(todayIn(DECISION_TIME_ZONE, new Date('2026-10-30T20:59:00Z'))).toBe(
      '2026-10-30',
    );
  });

  it('decides V4 by the Addis Ababa date, not UTC', () => {
    // UTC still says 30 Oct (the day before the 18th birthday); Addis Ababa says 31 Oct.
    const now = new Date('2026-10-30T22:30:00Z');
    expect(isUnder18('2008-10-31', todayIn(DECISION_TIME_ZONE, now))).toBe(
      false,
    );
  });
});
