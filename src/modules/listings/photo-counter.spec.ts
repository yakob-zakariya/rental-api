import { MIN_PHOTOS_TO_SUBMIT, NoPhotosYet } from './photo-counter.js';

describe('photos before Step 3 (decided 2026-11-23)', () => {
  it('a listing needs 3 photos to submit (P2-4)', () => {
    expect(MIN_PHOTOS_TO_SUBMIT).toBe(3);
  });

  it('until T3.2, no property has any, so nothing can be submitted outside tests', async () => {
    expect(await new NoPhotosYet().count()).toBe(0);
  });
});
