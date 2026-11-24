import type { EntityManager } from 'typeorm';

// Ending a session ends its push devices, in the caller's transaction (decided 2026-11-24). Plain
// functions, not a service, so the sign-in code (TokenService) can call them without depending on
// the push module.

/** One session ended (logout): its devices stop receiving notices. */
export async function deleteSessionDevices(
  manager: EntityManager,
  sessionId: string,
): Promise<void> {
  await manager.query(`DELETE FROM devices WHERE session_id = $1`, [sessionId]);
}

/** Every session of a user ended (token reuse A5, a ban, the lost-SIM move): all their devices go. */
export async function deleteUserDevices(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  await manager.query(`DELETE FROM devices WHERE user_id = $1`, [userId]);
}
