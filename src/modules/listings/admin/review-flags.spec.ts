import { reviewFlags } from './review-flags.js';

const clean = {
  activeListings: 1,
  description: 'Bright two-bedroom flat near the main road.',
  landmark: 'Blue gate behind the pharmacy',
  unlistedNeighbourhoodName: null,
};

describe('reviewFlags (R1)', () => {
  it('a clean listing has no flags', () => {
    expect(reviewFlags(clean)).toEqual([]);
  });

  it('MANY_ACTIVE_LISTINGS above 2, counting this one: 2 is fine, 3 is flagged', () => {
    expect(reviewFlags({ ...clean, activeListings: 2 })).toEqual([]);
    expect(reviewFlags({ ...clean, activeListings: 3 })).toEqual([
      { code: 'MANY_ACTIVE_LISTINGS', activeListings: 3 },
    ]);
  });

  it('UNLISTED_NEIGHBOURHOOD with the typed name', () => {
    expect(
      reviewFlags({ ...clean, unlistedNeighbourhoodName: 'Gerji Mebrat Hail' }),
    ).toEqual([{ code: 'UNLISTED_NEIGHBOURHOOD', name: 'Gerji Mebrat Hail' }]);
  });

  it('CONTACT_IN_TEXT says which field holds which kind', () => {
    expect(
      reviewFlags({
        ...clean,
        description: 'Call 0911234567 or Telegram @AddisHomes',
        landmark: 'see t.me/addishomes',
        unlistedNeighbourhoodName: 'Gerji, abebe@gmail.com',
      }),
    ).toEqual([
      { code: 'UNLISTED_NEIGHBOURHOOD', name: 'Gerji, abebe@gmail.com' },
      {
        code: 'CONTACT_IN_TEXT',
        found: [
          { field: 'description', kinds: ['phone', 'telegram'] },
          { field: 'landmark', kinds: ['telegram'] },
          { field: 'unlistedNeighbourhoodName', kinds: ['email'] },
        ],
      },
    ]);
  });

  it('empty fields are fine', () => {
    expect(
      reviewFlags({ ...clean, description: null, landmark: null }),
    ).toEqual([]);
  });
});
