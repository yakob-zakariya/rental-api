/** An Ethiopian mobile number in E.164: Ethio Telecom (+2519…) or Safaricom (+2517…). */
export const ETHIOPIAN_MOBILE_E164 = /^\+251[79]\d{8}$/;

// Separators people type or paste: spaces, hyphens, dots, parentheses.
const SEPARATORS = /[\s\-.()]/g;
// After removing separators, only ASCII digits with at most one leading '+'.
const DIGITS = /^\+?\d+$/;
const COUNTRY_PREFIXES = ['+251', '00251', '251'];
const SUBSCRIBER = /^[79]\d{8}$/;

/**
 * Normalises an Ethiopian mobile number to E.164 (`+2519XXXXXXXX` / `+2517XXXXXXXX`).
 * Accepts the local forms `09…`, `9…`, `07…`, `7…`, and the country-code forms `+251…`, `251…`,
 * `00251…`, with a mistaken trunk `0` after the country code (`+2510911…`) tolerated.
 * Returns null for anything else: landlines, foreign numbers, wrong lengths, other characters.
 *
 * This is the "Ethiopian mobile numbers only" policy; the database only enforces general E.164.
 */
export function normaliseEthiopianMobile(input: string): string | null {
  const compact = input.trim().replace(SEPARATORS, '');
  if (!DIGITS.test(compact)) return null;

  const prefix = COUNTRY_PREFIXES.find((p) => compact.startsWith(p));
  // A leading '+' is only valid as part of +251.
  if (!prefix && compact.startsWith('+')) return null;

  let subscriber = prefix ? compact.slice(prefix.length) : compact;
  // One trunk 0: normal in the local form (09…), a common mistake after the country code (+2510…).
  if (subscriber.startsWith('0')) subscriber = subscriber.slice(1);

  return SUBSCRIBER.test(subscriber) ? `+251${subscriber}` : null;
}
