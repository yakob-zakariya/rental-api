import type { Request } from 'express';
import type { User } from '../modules/users/user.entity.js';

/** What the global app guards attach to a request. */
export interface AuthRequest extends Request {
  /** Set by JwtAuthGuard from the access token's `sub`. */
  authUserId?: string;
  /** Set by ActiveAccountGuard, loaded fresh from the database. */
  currentUser?: User;
}
