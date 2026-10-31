/** Staff roles, lowest to highest (spec §5). */
export enum AdminRole {
  Support = 'support',
  Moderator = 'moderator',
  SuperAdmin = 'super_admin',
}

const RANK: Record<AdminRole, number> = {
  [AdminRole.Support]: 1,
  [AdminRole.Moderator]: 2,
  [AdminRole.SuperAdmin]: 3,
};

/** `actual` meets the minimum `required` role (super_admin ⊃ moderator ⊃ support). */
export function hasRole(actual: AdminRole, required: AdminRole): boolean {
  return RANK[actual] >= RANK[required];
}

const READ_METHODS = ['GET', 'HEAD'];

/**
 * The minimum role for an admin route. Fail closed: without @Roles, reads (GET/HEAD) need any
 * staff role (S2: support can read), and anything else needs moderator.
 */
export function requiredRole(
  method: string,
  declared: AdminRole | undefined,
): AdminRole {
  if (declared) return declared;
  return READ_METHODS.includes(method.toUpperCase())
    ? AdminRole.Support
    : AdminRole.Moderator;
}
