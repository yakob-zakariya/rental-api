import { BadRequestException } from '@nestjs/common';
import { decodeBrowseCursor, encodeBrowseCursor } from './browse-cursor.js';

const ID = '0b9d6e3a-2f4c-4a8b-8c1d-7e6f5a4b3c2d';

describe('browse cursor (G5)', () => {
  it.each([
    { sort: 'newest' as const, value: '2026-11-24T10:00:00.123456Z', id: ID },
    { sort: 'rent_asc' as const, value: 25000, id: ID },
    { sort: 'rent_desc' as const, value: 25000, id: ID },
    { sort: 'distance' as const, value: 1200, id: ID },
  ])('round-trips a $sort cursor', (cursor) => {
    expect(decodeBrowseCursor(encodeBrowseCursor(cursor), cursor.sort)).toEqual(
      cursor,
    );
  });

  const refuses = (raw: string, sort: 'newest' | 'rent_asc' = 'newest') => {
    try {
      decodeBrowseCursor(raw, sort);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        code: 'INVALID_CURSOR',
      });
      return;
    }
    throw new Error('expected INVALID_CURSOR');
  };

  it('refuses a cursor made for another sort', () => {
    refuses(
      encodeBrowseCursor({ sort: 'rent_asc', value: 1, id: ID }),
      'newest',
    );
  });

  it.each([
    ['not base64 JSON', 'nope'],
    [
      'a bad id',
      encodeBrowseCursor({
        sort: 'newest',
        value: '2026-11-24T10:00:00.123456Z',
        id: 'x',
      }),
    ],
    [
      'a bad timestamp',
      encodeBrowseCursor({ sort: 'newest', value: 'yesterday', id: ID }),
    ],
    [
      'extra parts',
      Buffer.from(
        JSON.stringify(['newest', '2026-11-24T10:00:00.123456Z', ID, 1]),
      ).toString('base64url'),
    ],
  ])('refuses %s', (_name, raw) => {
    refuses(raw);
  });

  it.each([-1, 1.5, '1000'])('refuses the rent value %j', (value) => {
    refuses(
      Buffer.from(JSON.stringify(['rent_asc', value, ID])).toString(
        'base64url',
      ),
      'rent_asc',
    );
  });
});
