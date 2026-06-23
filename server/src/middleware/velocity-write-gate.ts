import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import { requireVelocityMove } from '../utils/project-permissions';

/**
 * Membership / write gate for the velocity board.
 *
 * The legacy `authorize('runner')` checked system role only — any runner could
 * make a move on any project, including claimed projects they weren't a member
 * of. With the harness running many velo-listener.js processes that fan in via
 * different API keys, listeners were stepping on each other's projects.
 *
 * This middleware reads `:moduleId` from the path, resolves the owning project
 * once (cached in-memory for 60s — module→project is essentially static), and
 * delegates to `requireVelocityMove`, which encodes the velocity-specific rule:
 *
 *   - Open project (no active members) → any runner+ may write.
 *   - Claimed project (≥1 active member) → must be a member.
 *     ADMIN ROLE DOES NOT BYPASS THIS for velocity moves — admins are
 *     platform operators, not players. An admin who needs to play in a
 *     claimed project must add themselves as a member first.
 *   - Locked project → only the locker (or admin force) may write.
 *
 * Throws 403 NOT_A_MEMBER (or 423 PROJECT_LOCKED) so clients can branch
 * deterministically. Mount AFTER authenticate so req.user is populated.
 */

const moduleProjectCache = new Map<string, { projectId: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

async function resolveProjectIdForModule(moduleId: string): Promise<string | null> {
  const cached = moduleProjectCache.get(moduleId);
  if (cached && cached.expiresAt > Date.now()) return cached.projectId;

  const result = await pool.query<{ fk_module_project: string }>(
    `SELECT fk_module_project FROM module WHERE pk_module = $1 AND is_deleted = false`,
    [moduleId],
  );
  const projectId = result.rows[0]?.fk_module_project ?? null;
  if (projectId) {
    moduleProjectCache.set(moduleId, {
      projectId,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }
  return projectId;
}

export function velocityWriteGate(req: Request, _res: Response, next: NextFunction): void {
  const moduleId = (req.params as Record<string, string | undefined>).moduleId;
  const user = req.user;
  if (!moduleId) {
    next(AppError.badRequest('velocityWriteGate requires :moduleId in the route'));
    return;
  }
  if (!user) {
    next(new Error('velocityWriteGate requires authenticate to run first'));
    return;
  }
  resolveProjectIdForModule(moduleId)
    .then((projectId) => {
      if (!projectId) {
        return next(AppError.notFound('Module not found'));
      }
      return requireVelocityMove(projectId, user).then(() => next());
    })
    .catch(next);
}

/**
 * Test-only helper to clear the cache between specs.
 */
export function __resetVelocityWriteGateCacheForTests(): void {
  moduleProjectCache.clear();
}
