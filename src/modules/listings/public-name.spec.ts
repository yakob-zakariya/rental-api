import { publicName } from './public-name.js';

describe('publicName (L7)', () => {
  it.each([
    ['Yakob Zekariya Aman', 'Yakob Z.'], // as Didit returned a Fayda ID card (dev, 2026-11-24)
    ['YAKOB ZEKARIYA AMAN', 'Yakob Z.'], // passports' capitals
    ['yakob zekariya aman', 'Yakob Z.'],
    ['  Yakob   Zekariya\tAman ', 'Yakob Z.'],
    ['Yakob', 'Yakob'],
    ['YAKOB', 'Yakob'],
    ['ABDUL-KADIR MOHAMMED', 'Abdul-Kadir M.'],
    ["O'BRIEN SEAN", "O'Brien S."],
    ['McDonald Kebede', 'McDonald K.'],
    ['ዮሐንስ ተስፋዬ ገብሩ', 'ዮሐንስ ተ.'],
    ['Abebe ተስፋዬ', 'Abebe ተ.'],
    ['Jose E\u0301tienne', 'Jose \u00c9.'], // E + combining accent: kept as one letter (É)
  ])('%j → %j', (full, shown) => {
    expect(publicName(full)).toBe(shown);
  });

  it.each([[null], [''], ['   ']])('nothing to show for %j', (full) => {
    expect(publicName(full)).toBeNull();
  });

  it('never more than the first word and one letter', () => {
    const shown = publicName('Yakob Zekariya Aman')!;
    expect(shown).not.toContain('Zekariya');
    expect(shown).not.toContain('Aman');
  });
});
