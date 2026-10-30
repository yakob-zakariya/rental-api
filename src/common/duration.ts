const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** '15m' → 900. Accepts the format validateEnv enforces for TTLs: digits plus s, m, h or d. */
export function durationToSeconds(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}
