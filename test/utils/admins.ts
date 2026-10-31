import type { DataSource } from 'typeorm';
import { createAdmin } from '../../src/modules/admin/admin-users.js';

/**
 * A staff row for tests that only need a valid admin id (foreign keys). Not usable for login:
 * its password hash is a placeholder. Use signInAdmin for login tests.
 */
export async function insertTestAdmin(
  db: DataSource,
  role = 'moderator',
): Promise<string> {
  const [row] = await db.query<{ id: string }[]>(
    `INSERT INTO admin_users (email, password_hash, role)
     VALUES ('admin-' || gen_random_uuid() || '@example.test', 'not-a-real-hash', $1)
     RETURNING id`,
    [role],
  );
  return row.id;
}

/** A real staff account (argon2id password), via the same code as the admin:create CLI. */
export async function createTestAdmin(
  db: DataSource,
  {
    role = 'moderator',
    email = `staff-${Math.random().toString(36).slice(2)}@example.test`,
    password = 'correct horse battery',
  } = {},
) {
  const admin = await createAdmin(db.manager, { email, role, password });
  return { id: admin.id, email: admin.email, password };
}
