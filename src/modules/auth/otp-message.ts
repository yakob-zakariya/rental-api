// All user-facing OTP SMS text lives here. Phase 1 is English only; add other languages
// (am, om) by switching on the recipient's language here.

export function otpSmsText(code: string, ttlSeconds: number): string {
  return `Your rental code is ${code}. Valid for ${formatDuration(ttlSeconds)}. Never share this code with anyone.`;
}

function formatDuration(seconds: number): string {
  if (seconds % 60 !== 0) return plural(seconds, 'second');
  return plural(seconds / 60, 'minute');
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
