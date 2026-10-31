import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from './admin.enums.js';

export const MIN_ROLE = Symbol('minAdminRole');

/**
 * The minimum staff role for a route (support < moderator < super_admin). Without it, reads
 * need any role and every other method needs moderator (fail closed; see requiredRole).
 */
export const Roles = (minimum: AdminRole) => SetMetadata(MIN_ROLE, minimum);
