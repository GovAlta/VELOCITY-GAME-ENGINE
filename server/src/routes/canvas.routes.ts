import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/app-error';
import { logAuditEvent } from '../utils/audit-logger';

const router = Router();

// ─── Canvas Data (all projects + modules + dependencies for rendering) ───

router.get('/', asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const [projects, modules, dependencies] = await Promise.all([
    pool.query(
      `SELECT p.pk_project, p.project_code, p.project_name, p.project_status,
              p.project_percent_complete, p.project_start_date, p.project_end_date,
              p.canvas_x, p.canvas_y,
              m.ministry_code, m.ministry_name
       FROM project p
       LEFT JOIN ministry m ON m.pk_ministry = p.fk_project_ministry
       WHERE p.is_deleted = false
       ORDER BY p.project_name`
    ),
    pool.query(
      `SELECT mod.pk_module, mod.fk_module_project, mod.module_name, mod.module_status,
              mod.module_percent_complete, mod.canvas_x, mod.canvas_y
       FROM module mod
       WHERE mod.is_deleted = false
       ORDER BY mod.module_sort_order, mod.module_name`
    ),
    pool.query(
      `SELECT d.pk_project_dependency, d.fk_dependency_from, d.fk_dependency_to,
              d.dependency_type, d.dependency_label,
              pf.project_name AS from_name, pt.project_name AS to_name
       FROM project_dependency d
       JOIN project pf ON pf.pk_project = d.fk_dependency_from
       JOIN project pt ON pt.pk_project = d.fk_dependency_to
       WHERE pf.is_deleted = false AND pt.is_deleted = false`
    ),
  ]);

  sendSuccess(res, {
    projects: projects.rows,
    modules: modules.rows,
    dependencies: dependencies.rows,
  });
}));

// ─── Save positions (batch) ───

router.post('/positions', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { projects, modules } = req.body;

  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (p.id && typeof p.x === 'number' && typeof p.y === 'number') {
        await pool.query(
          'UPDATE project SET canvas_x = $1, canvas_y = $2 WHERE pk_project = $3',
          [p.x, p.y, p.id]
        );
      }
    }
  }

  if (Array.isArray(modules)) {
    for (const m of modules) {
      if (m.id && typeof m.x === 'number' && typeof m.y === 'number') {
        await pool.query(
          'UPDATE module SET canvas_x = $1, canvas_y = $2 WHERE pk_module = $3',
          [m.x, m.y, m.id]
        );
      }
    }
  }

  sendSuccess(res, { saved: true });
}));

// ─── Reset all positions ───

router.post('/reset', authenticate, authorize('project_lead'), csrf, asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  await pool.query('UPDATE project SET canvas_x = NULL, canvas_y = NULL WHERE is_deleted = false');
  await pool.query('UPDATE module SET canvas_x = NULL, canvas_y = NULL WHERE is_deleted = false');
  sendSuccess(res, { reset: true });
}));

// ─── Dependencies CRUD ───

router.get('/dependencies', asyncHandler(async (_req: Request, res: Response): Promise<void> => {
  const result = await pool.query(
    `SELECT d.*, pf.project_name AS from_name, pf.project_code AS from_code,
            pt.project_name AS to_name, pt.project_code AS to_code
     FROM project_dependency d
     JOIN project pf ON pf.pk_project = d.fk_dependency_from
     JOIN project pt ON pt.pk_project = d.fk_dependency_to
     WHERE pf.is_deleted = false AND pt.is_deleted = false
     ORDER BY d.created_at`
  );
  sendSuccess(res, result.rows);
}));

router.post('/dependencies', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { fromProjectId, toProjectId, type, label, notes } = req.body;
  if (!fromProjectId || !toProjectId) throw AppError.badRequest('Both fromProjectId and toProjectId are required');
  if (fromProjectId === toProjectId) throw AppError.badRequest('Cannot link a project to itself');

  const result = await pool.query(
    `INSERT INTO project_dependency (fk_dependency_from, fk_dependency_to, dependency_type, dependency_label, dependency_notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (fk_dependency_from, fk_dependency_to) DO UPDATE SET
       dependency_type = EXCLUDED.dependency_type,
       dependency_label = EXCLUDED.dependency_label,
       dependency_notes = EXCLUDED.dependency_notes
     RETURNING *`,
    [fromProjectId, toProjectId, type || 'other', label || null, notes || null, req.user!.id]
  );
  logAuditEvent({ action: 'INSERT', tableName: 'project_dependency', recordId: result.rows[0].pk_project_dependency, userId: req.user!.id, newData: { from: fromProjectId, to: toProjectId, type: type || 'other', label } }).catch(() => {});
  sendSuccess(res, result.rows[0], 201);
}));

router.delete('/dependencies/:id', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const result = await pool.query('DELETE FROM project_dependency WHERE pk_project_dependency = $1 RETURNING *', [req.params.id as string]);
  if (!result.rows[0]) throw AppError.notFound('Dependency not found');
  logAuditEvent({ action: 'DELETE', tableName: 'project_dependency', recordId: req.params.id as string, userId: req.user!.id, oldData: { from: result.rows[0].fk_dependency_from, to: result.rows[0].fk_dependency_to } }).catch(() => {});
  res.status(204).end();
}));

export default router;
