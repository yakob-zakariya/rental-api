import type { Request } from 'express';
import type { AdminUser } from './admin-user.entity.js';

/** What AdminAuthGuard attaches to a request. */
export interface AdminRequest extends Request {
  /** Loaded fresh from the database on every request (active admins only). */
  currentAdmin?: AdminUser;
}
