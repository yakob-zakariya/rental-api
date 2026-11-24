import { assertStorageKey } from './photo-storage.js';

describe('photo storage keys (they appear in public URLs)', () => {
  it.each([
    'properties/0b9d6e3a-2f4c-4a8b-8c1d-7e6f5a4b3c2d/photo-1.jpg',
    'a',
    'a/b_c-d.e',
  ])('accepts %s', (key) => {
    expect(() => assertStorageKey(key)).not.toThrow();
  });

  it.each([
    '',
    '/leading-slash.jpg',
    'trailing/',
    'double//slash.jpg',
    '../escape.jpg',
    'a/../b.jpg',
    'Upper.jpg',
    'space here.jpg',
    'query?x=1',
    'percent%2F.jpg',
    'ሀ.jpg',
  ])('refuses %j', (key) => {
    expect(() => assertStorageKey(key)).toThrow('Invalid photo storage key');
  });
});
