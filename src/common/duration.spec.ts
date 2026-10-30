import { durationToSeconds } from './duration.js';

describe('durationToSeconds', () => {
  it.each([
    ['45s', 45],
    ['15m', 900],
    ['8h', 28_800],
    ['30d', 2_592_000],
    ['0s', 0],
  ])('%s → %i', (input, expected) => {
    expect(durationToSeconds(input)).toBe(expected);
  });

  it.each(['15', '15 m', '1.5h', '2w', '', 'm'])('rejects %j', (input) => {
    expect(() => durationToSeconds(input)).toThrow('Invalid duration');
  });
});
