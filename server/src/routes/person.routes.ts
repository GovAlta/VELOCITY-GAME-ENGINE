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

/**
 * GET /api/v1/persons/search?q=name
 * Typeahead fuzzy search
 */
router.get('/search', authenticate, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const q = (req.query.q as string || '').trim();
  if (q.length < 1) { sendSuccess(res, []); return; }

  const result = await pool.query(
    `SELECT pk_person, person_display_name, person_email, person_organization, person_is_fte
     FROM person
     WHERE person_display_name ILIKE $1
     ORDER BY similarity(person_display_name, $2) DESC, person_display_name ASC
     LIMIT 20`,
    [`%${q}%`, q]
  );
  sendSuccess(res, result.rows);
}));

/**
 * GET /api/v1/persons
 * Paginated person directory with filters
 */
router.get('/', authenticate, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
  const offset = (page - 1) * limit;
  const search = (req.query.search as string || '').trim();
  const type = (req.query.type as string || '').trim(); // 'fte' | 'contractor' | ''

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (search) {
    conditions.push(`person_display_name ILIKE $${idx++}`);
    params.push(`%${search}%`);
  }
  if (type === 'fte') { conditions.push(`person_is_fte = true`); }
  if (type === 'contractor') { conditions.push(`person_is_fte = false`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM person ${where}`, params);
  const total = countResult.rows[0].total;

  const dataParams = [...params, limit, offset];
  const result = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*)::int FROM project_lead pl WHERE pl.fk_project_lead_person = p.pk_person) AS assignment_count
     FROM person p
     ${where}
     ORDER BY p.person_display_name ASC
     LIMIT $${idx++} OFFSET $${idx}`,
    dataParams
  );

  sendSuccess(res, {
    data: result.rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}));

/**
 * GET /api/v1/persons/:id
 * Get person with their project assignments
 */
router.get('/:id', authenticate, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const personResult = await pool.query(`SELECT * FROM person WHERE pk_person = $1`, [id]);
  if (!personResult.rows[0]) throw AppError.notFound('Person not found');

  const assignments = await pool.query(
    `SELECT pl.*, p.project_name, m.ministry_code
     FROM project_lead pl
     JOIN project p ON p.pk_project = pl.fk_project_lead_project
     LEFT JOIN ministry m ON m.pk_ministry = p.fk_project_ministry
     WHERE pl.fk_project_lead_person = $1 AND p.is_deleted = false
     ORDER BY p.project_name`,
    [id]
  );

  sendSuccess(res, { ...personResult.rows[0], assignments: assignments.rows });
}));

/**
 * POST /api/v1/persons
 * Create new person
 */
router.post('/', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { displayName, email, organization, isFte, notes, githubHandle } = req.body;
  if (!displayName?.trim()) throw AppError.badRequest('Display name is required');

  const result = await pool.query(
    `INSERT INTO person (person_display_name, person_email, person_organization, person_is_fte, person_notes, person_github_handle)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [displayName.trim(), email || null, organization || null, isFte ?? true, notes || null, githubHandle?.trim() || null]
  );
  logAuditEvent({ action: 'INSERT', tableName: 'person', recordId: result.rows[0].pk_person, userId: req.user!.id, newData: { name: displayName.trim() } }).catch(() => {});
  sendSuccess(res, result.rows[0], 201);
}));

router.put('/:id', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const { displayName, email, organization, isFte, notes, githubHandle } = req.body;

  if (!displayName?.trim()) throw AppError.badRequest('Display name is required');

  const result = await pool.query(
    `UPDATE person SET
       person_display_name = $2, person_email = $3, person_organization = $4,
       person_is_fte = $5, person_notes = $6, person_github_handle = $7
     WHERE pk_person = $1 RETURNING *`,
    [id, displayName.trim(), email?.trim() || null, organization?.trim() || null, isFte ?? true, notes?.trim() || null, githubHandle?.trim() || null]
  );
  if (!result.rows[0]) throw AppError.notFound('Person not found');

  await pool.query(
    `UPDATE project_lead SET lead_name = $2, lead_is_fte = $3, lead_organization = $4 WHERE fk_project_lead_person = $1`,
    [id, displayName.trim(), isFte ?? true, organization?.trim() || null]
  );

  logAuditEvent({ action: 'UPDATE', tableName: 'person', recordId: id, userId: req.user!.id, newData: { name: displayName.trim(), email } }).catch(() => {});
  sendSuccess(res, result.rows[0]);
}));

router.delete('/:id', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  await pool.query(`DELETE FROM project_lead WHERE fk_project_lead_person = $1`, [id]);
  const result = await pool.query(`DELETE FROM person WHERE pk_person = $1 RETURNING *`, [id]);
  if (!result.rows[0]) throw AppError.notFound('Person not found');
  logAuditEvent({ action: 'DELETE', tableName: 'person', recordId: id, userId: req.user!.id, oldData: { name: result.rows[0].person_display_name } }).catch(() => {});
  res.status(204).end();
}));

/**
 * POST /api/v1/persons/:id/merge
 * Merge another person INTO this one. Survivor = :id, victim = body.mergePersonId
 * All assignments from victim are transferred to survivor, then victim is deleted.
 */
router.post('/:id/merge', authenticate, authorize('project_lead'), csrf, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const survivorId = req.params.id as string;
  const victimId = req.body.mergePersonId as string;
  if (!victimId) throw AppError.badRequest('mergePersonId is required');
  if (survivorId === victimId) throw AppError.badRequest('Cannot merge a person with themselves');

  // Verify both exist
  const [survivor, victim] = await Promise.all([
    pool.query(`SELECT * FROM person WHERE pk_person = $1`, [survivorId]),
    pool.query(`SELECT * FROM person WHERE pk_person = $1`, [victimId]),
  ]);
  if (!survivor.rows[0]) throw AppError.notFound('Survivor person not found');
  if (!victim.rows[0]) throw AppError.notFound('Merge target person not found');

  // Transfer assignments: update victim's project_lead rows to point to survivor
  // But skip if survivor already has an assignment for that project
  const transferred = await pool.query(
    `UPDATE project_lead
     SET fk_project_lead_person = $1, lead_name = $3
     WHERE fk_project_lead_person = $2
       AND fk_project_lead_project NOT IN (
         SELECT fk_project_lead_project FROM project_lead WHERE fk_project_lead_person = $1
       )
     RETURNING *`,
    [survivorId, victimId, survivor.rows[0].person_display_name]
  );

  // Delete remaining (duplicate project assignments)
  await pool.query(`DELETE FROM project_lead WHERE fk_project_lead_person = $1`, [victimId]);

  // Delete the victim person
  await pool.query(`DELETE FROM person WHERE pk_person = $1`, [victimId]);

  sendSuccess(res, {
    survivor: survivor.rows[0],
    victimDeleted: victim.rows[0].person_display_name,
    assignmentsTransferred: transferred.rowCount,
  });

  logAuditEvent({ action: 'UPDATE', tableName: 'person', recordId: survivorId, userId: req.user!.id, newData: { merged_from: victim.rows[0].person_display_name, merged_from_id: victimId, assignmentsTransferred: transferred.rowCount } }).catch(() => {});
}));

export default router;
