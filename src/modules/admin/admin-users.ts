import type { EntityManager } from 'typeorm';
import { AdminRole } from './admin.enums.js';
import { normaliseEmail } from './admin-auth.service.js';
import { AdminUser } from './admin-user.entity.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from './password.js';

export class CreateAdminError extends Error {
  readonly name = 'CreateAdminError';
}

/**
 * Creates a staff account (the `admin:create` CLI; there is no open endpoint for it). The
 * password is hashed with argon2id and never stored or logged in clear.
 */
export async function createAdmin(
  manager: EntityManager,
  input: { email: string; role: string; password: string },
): Promise<AdminUser> {
  const email = normaliseEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new CreateAdminError('Not a valid email address');
  }
  if (!Object.values<string>(AdminRole).includes(input.role)) {
    throw new CreateAdminError(
      `Role must be one of ${Object.values(AdminRole).join(', ')}`,
    );
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    throw new CreateAdminError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const admins = manager.getRepository(AdminUser);
  if (await admins.existsBy({ email })) {
    throw new CreateAdminError(`An admin with email ${email} already exists`);
  }
  return admins.save(
    admins.create({
      email,
      role: input.role as AdminRole,
      passwordHash: await hashPassword(input.password),
    }),
  );
}
