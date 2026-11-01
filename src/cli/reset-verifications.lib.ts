import type { EntityManager } from 'typeorm';

/**
 * Development-only: wipes verification data so the sandbox's single fake identity can be approved
 * again for a fresh test account (otherwise V6 blocks every account after the first approval).
 * Used by `npm run dev:reset-verifications`; never wired into the app.
 */

/** Deleted in this order (foreign keys: identity_hashes → identity_verifications). */
export const RESET_TABLES = [
  'identity_hashes',
  'banned_identities',
  'verification_webhook_events',
  'identity_verifications',
] as const;

export type ResetTable = (typeof RESET_TABLES)[number];

export interface ResetCounts {
  tables: Record<ResetTable, number>;
  /** Users whose verification fields are reset (every user). */
  users: number;
  /** Banned users (users.status = 'banned'): left as they are; unban them separately. */
  bannedUsers: number;
}

export class ResetRefusedError extends Error {}

/**
 * Refuses unless NODE_ENV is exactly `development` and the connected database's name doesn't end
 * in `_prod`. Pass the raw NODE_ENV (not a defaulted one) and the name Postgres reports.
 */
export function assertResetAllowed(input: {
  nodeEnv: string | undefined;
  databaseName: string;
}): void {
  if (input.nodeEnv !== 'development') {
    throw new ResetRefusedError(
      `Refusing to reset: NODE_ENV must be "development" (it is ${
        input.nodeEnv === undefined ? 'not set' : `"${input.nodeEnv}"`
      })`,
    );
  }
  if (input.databaseName.toLowerCase().endsWith('_prod')) {
    throw new ResetRefusedError(
      `Refusing to reset: database "${input.databaseName}" looks like production (ends in _prod)`,
    );
  }
}

/** Only the exact word `reset` (surrounding spaces ignored) confirms. */
export function isConfirmed(answer: string): boolean {
  return answer.trim() === 'reset';
}

export async function countResettable(
  manager: EntityManager,
): Promise<ResetCounts> {
  const tables = {} as Record<ResetTable, number>;
  for (const table of RESET_TABLES) {
    const [{ count }] = await manager.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    tables[table] = count;
  }
  const [{ users, banned }] = await manager.query<
    { users: number; banned: number }[]
  >(
    `SELECT count(*)::int AS users,
            count(*) FILTER (WHERE status = 'banned')::int AS banned
     FROM users`,
  );
  return { tables, users, bannedUsers: banned };
}

/**
 * Deletes every row of RESET_TABLES and clears every user's verification fields. Run it inside a
 * transaction. Leaves users.status (moderation), refresh tokens, staff accounts and admin_actions
 * (append-only) alone.
 *
 * This writes users.verification_status directly instead of through
 * recomputeVerificationStatus: that never clears a verified name and date of birth (V9), and
 * this dev tool must. Nothing in the app may do this.
 */
export async function resetVerifications(
  manager: EntityManager,
): Promise<ResetCounts> {
  const counts = await countResettable(manager);
  for (const table of RESET_TABLES) {
    await manager.query(`DELETE FROM ${table}`);
  }
  await manager.query(
    `UPDATE users
     SET verification_status = 'not_verified', verified_at = NULL, full_name = NULL,
         date_of_birth = NULL`,
  );
  return counts;
}

export function describeCounts(counts: ResetCounts): string {
  const lines = RESET_TABLES.map(
    (table) => `  ${table}: ${counts.tables[table]} rows`,
  );
  lines.push(
    `  users: ${counts.users} reset to not_verified (verified_at, full_name, date_of_birth cleared)`,
  );
  if (counts.bannedUsers > 0) {
    lines.push(
      `  note: ${counts.bannedUsers} banned user(s) stay banned (users.status is left alone)`,
    );
  }
  return lines.join('\n');
}
