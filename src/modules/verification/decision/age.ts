/** Spec: dates are shown and decided in Ethiopia's time zone. */
export const DECISION_TIME_ZONE = 'Africa/Addis_Ababa';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD (e.g. rejects 2023-02-29). */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * V4: under 18 on `onDate` (both YYYY-MM-DD). Someone born on 29 February turns 18 on 1 March
 * in non-leap years. Treats the date of birth as Gregorian (T2.9: Didit returns Fayda's in Gregorian).
 */
export function isUnder18(dateOfBirth: string, onDate: string): boolean {
  if (!isIsoDate(dateOfBirth) || !isIsoDate(onDate)) {
    throw new Error('isUnder18 needs YYYY-MM-DD dates');
  }
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = onDate.split('-').map(Number);
  const hadBirthdayThisYear = tm > bm || (tm === bm && td >= bd);
  const age = ty - by - (hadBirthdayThisYear ? 0 : 1);
  return age < 18;
}
