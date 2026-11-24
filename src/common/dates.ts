/** Dates are shown and decided in Ethiopia's time zone (CLAUDE.md conventions). */
export const ADDIS_ABABA_TIME_ZONE = 'Africa/Addis_Ababa';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD (e.g. rejects 2023-02-29). */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** 'HH:MM' (24-hour), as the quiet-hours settings are written. */
export const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes since midnight of a 'HH:MM' time. */
export function clockTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes since local midnight of `at` in the given time zone. */
export function minutesOfDayIn(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return part('hour') * 60 + part('minute');
}

/**
 * True inside quiet hours: from `start` (included) to `end` (excluded), 'HH:MM' local times.
 * Crosses midnight when start > end (20:00–08:00); start = end means no quiet hours.
 */
export function isQuietTime(
  at: Date,
  start: string,
  end: string,
  timeZone: string = ADDIS_ABABA_TIME_ZONE,
): boolean {
  const now = minutesOfDayIn(timeZone, at);
  const from = clockTimeToMinutes(start);
  const to = clockTimeToMinutes(end);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** Today's date (YYYY-MM-DD) in the given time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
