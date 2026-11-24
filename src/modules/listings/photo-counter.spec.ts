import {
  MAX_PHOTOS_PER_PROPERTY,
  MIN_PHOTOS_TO_SUBMIT,
} from './photo-counter.js';

describe('photo limits (P1, P2-4)', () => {
  it('a listing needs 3 photos to submit, and a property may have at most 12', () => {
    expect(MIN_PHOTOS_TO_SUBMIT).toBe(3);
    expect(MAX_PHOTOS_PER_PROPERTY).toBe(12);
  });
});
