/**
 * The lister's name as the public sees it (spec L7): the first word of the verified full name and
 * the first letter of the second, e.g. "Yakob Z." from "Yakob Zekariya Aman" (Ethiopian names
 * are given name, father's name, grandfather's name). One word only: that word. The full name is
 * never public.
 *
 * Capitals: a word written all in capitals or all in small letters (passports' machine-readable
 * lines are in capitals) is shown with only its first letter capital; a word that already mixes
 * cases ("McDonald") is kept as written. Scripts without case (Ge'ez) pass through unchanged.
 * Passport word order is checked in the live Didit test (decided 2026-11-24).
 */
export function publicName(fullName: string | null): string | null {
  const words = (fullName ?? '')
    .normalize('NFC')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) return null;
  const first = tidyCase(words[0]);
  if (words.length === 1) return first;
  // The first letter of the second word as a reader sees it (a grapheme), so a letter with a
  // combining mark, or a Ge'ez letter, is never cut in half.
  const initial = firstGrapheme(tidyCase(words[1]));
  return `${first} ${initial}.`;
}

function tidyCase(word: string): string {
  const upper = word.toLocaleUpperCase();
  const lower = word.toLocaleLowerCase();
  const sameCase = word === upper || word === lower;
  if (!sameCase || upper === lower) return word; // mixed case, or no case at all (Ge'ez)
  // Each part of a hyphenated name gets its capital: "abdul-kadir" → "Abdul-Kadir".
  return lower.replace(
    /(^|[-'’])(\p{L})/gu,
    (_match, sep: string, letter: string) => sep + letter.toLocaleUpperCase(),
  );
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function firstGrapheme(word: string): string {
  const first = graphemes.segment(word)[Symbol.iterator]().next();
  return first.done ? '' : first.value.segment;
}
