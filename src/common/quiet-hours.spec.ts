import { isQuietTime, minutesOfDayIn } from './dates.js';

// Quiet hours (decided 2026-11-24): 20:00–08:00 in Addis Ababa (UTC+3, no daylight saving).
const addis = (time: string) => new Date(`2026-11-24T${time}:00+03:00`);

describe('quiet hours', () => {
  it('reads the local time in Addis Ababa', () => {
    expect(minutesOfDayIn('Africa/Addis_Ababa', addis('07:59'))).toBe(
      7 * 60 + 59,
    );
    expect(
      minutesOfDayIn('Africa/Addis_Ababa', new Date('2026-11-24T21:30:00Z')),
    ).toBe(30);
  });

  it.each([
    ['07:59', true],
    ['08:00', false],
    ['12:00', false],
    ['19:59', false],
    ['20:00', true],
    ['23:59', true],
    ['00:00', true],
  ])('20:00–08:00 at %s: quiet = %s', (time, quiet) => {
    expect(isQuietTime(addis(time), '20:00', '08:00')).toBe(quiet);
  });

  it('a window inside one day (13:00–14:00), and none when start equals end', () => {
    expect(isQuietTime(addis('12:59'), '13:00', '14:00')).toBe(false);
    expect(isQuietTime(addis('13:00'), '13:00', '14:00')).toBe(true);
    expect(isQuietTime(addis('14:00'), '13:00', '14:00')).toBe(false);
    expect(isQuietTime(addis('03:00'), '08:00', '08:00')).toBe(false);
  });
});
