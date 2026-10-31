import { normaliseName } from './name.js';

describe('normaliseName (V7)', () => {
  it.each([
    ['Abebe Kebede', 'abebe kebede'],
    ['ABEBE   KEBEDE', 'abebe kebede'],
    ['  Abebe\tKebede\n', 'abebe kebede'],
    ['José Ñúñez', 'jose nunez'],
    ['Mary-Jane O’Neil', 'mary jane o neil'],
    ['Dr. Abebe, Kebede.', 'dr abebe kebede'],
    ['ＡＢＥＢＥ', 'abebe'], // full-width
    ['አበበ ከበደ', 'አበበ ከበደ'], // Ge'ez kept as is
  ])('%j → %j', (name, expected) => {
    expect(normaliseName(name)).toBe(expected);
  });

  it('makes names that differ only in case, accents, punctuation or spacing equal', () => {
    expect(normaliseName('ABEBE KEBEDE')).toBe(normaliseName('abebe  kebede.'));
    expect(normaliseName('Jose Nunez')).toBe(normaliseName('José Núñez'));
  });

  it('keeps genuinely different names different', () => {
    expect(normaliseName('Abebe Kebede')).not.toBe(
      normaliseName('Abebe Bikila'),
    );
    expect(normaliseName('Abebe Kebede')).not.toBe(
      normaliseName('Kebede Abebe'),
    );
  });
});
