import { normaliseEthiopianMobile } from '../../../common/phone/ethiopian-phone.js';

/**
 * Ways a lister can be reached that bypass contact requests (decided 2026-11-24): brokers in Addis
 * pull people off-platform with a phone number or, more and more, a Telegram handle or link.
 */
export type ContactKind = 'phone' | 'telegram' | 'email' | 'url';

const KIND_ORDER: readonly ContactKind[] = [
  'phone',
  'telegram',
  'email',
  'url',
];

// A run that could be a phone number: digits, optionally a leading +, with spaces, dashes, dots
// or brackets in between (as people type them: "0911 23 45 67", "+251-911-234-567").
const DIGIT_RUN = /\+?\d[\d\s\-.()]{6,}\d/g;

const EMAIL =
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[\p{L}]{2,}/gu;

// t.me/name, telegram.me/name, telegram.dog/name, tg://resolve?domain=name, with or without https.
const TELEGRAM_LINK =
  /(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\/\S+|tg:\/\/\S+/giu;

// @name as Telegram allows it: 5–32 letters, digits or underscores, starting with a letter, not
// part of an email or a longer word.
const TELEGRAM_HANDLE =
  /(?<![\p{L}\p{N}_.@])@[A-Za-z][A-Za-z0-9_]{4,31}(?![A-Za-z0-9_])/gu;

// A link: with a scheme or www., or a bare domain with a common ending (bole-homes.com, x.et).
const URL =
  /(?:https?:\/\/|www\.)\S+|(?<![\p{L}\p{N}@.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|et|io|me|info|biz|app|co|online|site|link)(?:\/\S*)?(?![\p{L}\p{N}])/giu;

/**
 * The kinds of contact details in a text, in a fixed order, each kind once. A hint for the
 * reviewer (R1), not a guarantee: deliberately disguised details (digits written as words, "O"
 * for zero, Ge'ez numerals, "t . me") get through, and the reviewer reads the text anyway.
 *
 * Phone runs are checked with the sign-up rule (normaliseEthiopianMobile), so a rent such as
 * 25,000 or 1,500,000, a floor or a year is not a phone number. A run is tried group by group,
 * so a number next to other digits ("0911234567 25000") is still found. Matches are removed as they are
 * found (emails before handles, Telegram links before other links), so one detail counts once.
 */
export function findContacts(text: string): ContactKind[] {
  let rest = text.normalize('NFKC');
  const found = new Set<ContactKind>();
  const take = (
    pattern: RegExp,
    kind: ContactKind,
    accept: (match: string) => boolean = () => true,
  ) => {
    rest = rest.replace(pattern, (match) => {
      if (!accept(match)) return match;
      found.add(kind);
      return ' ';
    });
  };

  take(EMAIL, 'email');
  take(TELEGRAM_LINK, 'telegram');
  take(TELEGRAM_HANDLE, 'telegram');
  take(URL, 'url');
  take(DIGIT_RUN, 'phone', containsPhone);

  return KIND_ORDER.filter((kind) => found.has(kind));
}

/**
 * Whether some consecutive digit groups of a run form an Ethiopian mobile number. "+251 911 234
 * 567, 25000" has the groups +251 | 911 | 234 | 567 | 25000; "+251 911 234 567" is one of the
 * windows.
 */
function containsPhone(run: string): boolean {
  const groups = run.split(/[\s\-.()]+/).filter(Boolean);
  for (let i = 0; i < groups.length; i++) {
    let joined = '';
    for (let j = i; j < groups.length; j++) {
      joined += groups[j];
      const digits = joined.replace('+', '').length;
      if (digits > 14) break;
      if (digits >= 9 && normaliseEthiopianMobile(joined) !== null) return true;
    }
  }
  return false;
}
