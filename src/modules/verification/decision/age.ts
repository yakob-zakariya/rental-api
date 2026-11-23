import { ADDIS_ABABA_TIME_ZONE, isIsoDate } from '../../../common/dates.js';

// Moved to common/dates.ts (shared with listings, T2.2); re-exported so imports here keep working.
export { isIsoDate, todayIn } from '../../../common/dates.js';

/** Spec: dates are shown and decided in Ethiopia's time zone. */
export const DECISION_TIME_ZONE = ADDIS_ABABA_TIME_ZONE;

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
