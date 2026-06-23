import { Request, Response, NextFunction } from 'express';
import { pool } from '../config/database';
import { AppError } from '../utils/app-error';

/**
 * Optimistic-concurrency middleware.
 *
 * If the request includes an If-Match header, compare it to the current
 * revision counter. Mismatch → 412 PRECONDITION_FAILED with the current
 * value so the client can refetch + decide whether to retry.
 *
 * If the header is absent, the middleware is a no-op (concurrency check is
 * advisory; clients that don't supply it accept lost-write risk).
 *
 * Two flavors:
 *   - ifMatchProject:    reads project_revision from project where pk_project = req.params.id
 *   - ifMatchVelocityStep: reads step_revision from module_velocity where (fk_mv_module, step_name)
 *                          matches req.params.moduleId + req.params.stepName
 */

function parseIfMatch(req: Request): number | null {
  const raw = req.header('If-Match');
  if (!raw) return null;
  // Accept both `7` and `"7"` (RFC 7232 says ETags are quoted; we're lenient.)
  const cleaned = raw.replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

function preconditionFailed(currentRevision: number): AppError {
  return new AppError(
    `Stale revision — current is ${currentRevision}. Re-fetch and try again.`,
    412,
    'PRECONDITION_FAILED',
    [{ field: 'currentRevision', message: String(currentRevision) }],
  );
}

export function ifMatchProject(req: Request, _res: Response, next: NextFunction): void {
  const expected = parseIfMatch(req);
  if (expected === null) { next(); return; }
  const projectId = (req.params as Record<string, string>).id;
  if (!projectId) { next(); return; }

  pool
    .query<{ project_revision: number }>(
      `SELECT project_revision FROM project WHERE pk_project = $1 AND is_deleted = false`,
      [projectId],
    )
    .then(({ rows }) => {
      if (rows.length === 0) return next(AppError.notFound('Project not found'));
      const current = rows[0].project_revision;
      if (current !== expected) return next(preconditionFailed(current));
      next();
    })
    .catch(next);
}

export function ifMatchVelocityStep(req: Request, _res: Response, next: NextFunction): void {
  const expected = parseIfMatch(req);
  if (expected === null) { next(); return; }
  const params = req.params as Record<string, string>;
  const moduleId = params.moduleId;
  const stepName = params.stepName;
  if (!moduleId || !stepName) { next(); return; }

  pool
    .query<{ step_revision: number }>(
      `SELECT step_revision FROM module_velocity
        WHERE fk_mv_module = $1 AND step_name = $2`,
      [moduleId, stepName],
    )
    .then(({ rows }) => {
      if (rows.length === 0) return next(AppError.notFound('Velocity step not found'));
      const current = rows[0].step_revision;
      if (current !== expected) return next(preconditionFailed(current));
      next();
    })
    .catch(next);
}

/**
 * Helper: fetch current project_revision (for endpoint responses that
 * include the version so clients can include it in their next If-Match).
 */
export async function getProjectRevision(projectId: string): Promise<number | null> {
  const { rows } = await pool.query<{ project_revision: number }>(
    `SELECT project_revision FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId],
  );
  return rows[0]?.project_revision ?? null;
}

export async function getStepRevision(moduleId: string, stepName: string): Promise<number | null> {
  const { rows } = await pool.query<{ step_revision: number }>(
    `SELECT step_revision FROM module_velocity WHERE fk_mv_module = $1 AND step_name = $2`,
    [moduleId, stepName],
  );
  return rows[0]?.step_revision ?? null;
}
