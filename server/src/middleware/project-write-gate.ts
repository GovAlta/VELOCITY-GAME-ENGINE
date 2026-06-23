import { Request, Response, NextFunction } from 'express';
import { requireProjectWrite } from '../utils/project-permissions';

/**
 * Middleware that enforces the unified project-write gate:
 *   - System role (runner / project_lead / admin)
 *   - Membership (open project: any role-eligible user; claimed: members only)
 *   - Lock (when locked, only locker — or admin — can write)
 *
 * Replaces the legacy `authorize('project_lead')` on every project-scoped
 * write route. Reads `:id` from the path; works for both /projects/:id and
 * sub-resource paths like /projects/:id/modules/:moduleId.
 */
export function projectWriteGate(req: Request, _res: Response, next: NextFunction): void {
  const projectId = (req.params as Record<string, string | undefined>).id;
  const user = req.user;
  if (!projectId) {
    next();
    return;
  }
  if (!user) {
    next(new Error('projectWriteGate requires authenticate to run first'));
    return;
  }
  requireProjectWrite(projectId, user)
    .then(() => next())
    .catch(next);
}
