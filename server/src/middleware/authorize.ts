import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/app-error';
import type { RoleName } from '../types/auth';

/**
 * Role definitions with hierarchy level (higher = more privilege).
 * Users can have multiple roles. Authorization checks if the user
 * holds ANY of the required roles.
 */
export const ROLE_LEVELS: Record<RoleName, number> = {
  user: 1,
  runner: 2,
  project_lead: 3,
  admin: 4,
};

export const ALL_ROLES: RoleName[] = ['user', 'project_lead', 'runner', 'admin'];

/**
 * Authorization middleware factory.
 *
 * Checks if the authenticated user has ANY of the specified roles.
 * Admin always passes (highest privilege).
 *
 * @param requiredRoles - Roles that grant access (user needs at least one)
 *
 * Usage:
 *   authorize('admin')                      // admin only
 *   authorize('project_lead', 'admin')      // project_lead or admin
 *   authorize('runner', 'project_lead')     // runner or project_lead (admin also passes)
 */
export function authorize(...requiredRoles: RoleName[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }

    const userRoles = req.user.roles || [req.user.role];

    // Admin always has access
    if (userRoles.includes('admin')) {
      next();
      return;
    }

    // Check if user has any of the required roles
    const hasRequiredRole = requiredRoles.some(r => userRoles.includes(r));

    if (!hasRequiredRole) {
      next(AppError.forbidden(`Requires one of: ${requiredRoles.join(', ')}`));
      return;
    }

    next();
  };
}

/**
 * Helper to get the highest-privilege role from a list.
 */
export function highestRole(roles: RoleName[]): RoleName {
  let best: RoleName = 'user';
  let bestLevel = 0;
  for (const r of roles) {
    const level = ROLE_LEVELS[r] || 0;
    if (level > bestLevel) {
      best = r;
      bestLevel = level;
    }
  }
  return best;
}
