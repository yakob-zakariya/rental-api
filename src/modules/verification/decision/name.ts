/**
 * V7 name normalisation: NFKD, strip diacritics, lowercase, remove punctuation, collapse
 * whitespace. Non-Latin letters (e.g. Ge'ez) are kept as they are, so they only ever match
 * identical text. Used to compare names, never to store them.
 */
export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\p{P}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
