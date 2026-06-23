import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { projectWriteGate } from '../middleware/project-write-gate';
import { ifMatchProject } from '../middleware/if-match';
import { idempotency } from '../middleware/idempotency';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/response';
import { pool } from '../config/database';
import * as projectController from '../controllers/project.controller';
import * as collabController from '../controllers/project-collaboration.controller';
import {
  listProjectsSchema,
  projectIdSchema,
  createProjectSchema,
  updateProjectSchema,
  createModuleSchema,
  updateModuleSchema,
  projectModuleIdSchema,
  createBudgetSchema,
  updateBudgetSchema,
  projectBudgetIdSchema,
  createLinkSchema,
  projectLinkIdSchema,
  createUpdateSchema,
  listUpdatesQuerySchema,
  linkApplicationSchema,
  linkContractSchema,
  projectLinkEntityIdSchema,
} from '../validators/project.validator';
import {
  cloneProjectSchema,
  renameVersionSchema,
  memberAddSchema,
  memberPatchSchema,
  transferOwnershipSchema,
  lockSchema,
  unlockSchema,
  clonePolicySchema,
  projectMembershipParamSchema,
} from '../validators/project-collaboration.validator';

const router = Router();

// ─── Projects ──────────────────────────────────────

/**
 * GET /api/projects
 * Public — list projects with pagination, filtering, sorting.
 */
router.get(
  '/',
  validate({ query: listProjectsSchema }),
  asyncHandler(projectController.list)
);

/**
 * GET /api/projects/:id
 * Public — get project detail by ID.
 */
router.get(
  '/:id',
  validate({ params: projectIdSchema }),
  asyncHandler(projectController.getById)
);

/**
 * POST /api/projects
 * Authenticated — create a new project.
 */
router.post(
  '/',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ body: createProjectSchema }),
  asyncHandler(projectController.create)
);

/**
 * PUT /api/projects/:id
 * Authenticated — update an existing project.
 */
router.put(
  '/:id',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: updateProjectSchema }),
  asyncHandler(projectController.update)
);

/**
 * DELETE /api/projects/:id
 * Authenticated — soft-delete a project.
 */
/**
 * POST /api/projects/:id/merge
 * Merge another project into this one (survivor = :id)
 */
router.post(
  '/:id/merge',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema }),
  asyncHandler(projectController.merge)
);

router.delete(
  '/:id',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema }),
  asyncHandler(projectController.remove)
);

// ─── Modules ──────────────────────────────────────

/**
 * GET /api/projects/:id/modules
 * Public — list modules for a project.
 */
router.get(
  '/:id/modules',
  validate({ params: projectIdSchema }),
  asyncHandler(projectController.listModules)
);

/**
 * POST /api/projects/:id/modules
 * Authenticated — create a module within a project.
 */
router.post(
  '/:id/modules',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: createModuleSchema }),
  asyncHandler(projectController.createModule)
);

/**
 * PUT /api/projects/:id/modules/:moduleId
 * Authenticated — update a module.
 */
router.put(
  '/:id/modules/:moduleId',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectModuleIdSchema, body: updateModuleSchema }),
  asyncHandler(projectController.updateModule)
);

/**
 * DELETE /api/projects/:id/modules/:moduleId
 * Authenticated — remove a module.
 */
router.delete(
  '/:id/modules/:moduleId',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectModuleIdSchema }),
  asyncHandler(projectController.removeModule)
);

// ─── Budgets ──────────────────────────────────────

/**
 * GET /api/projects/:id/budgets
 * Public — list budget line items for a project.
 */
router.get(
  '/:id/budgets',
  validate({ params: projectIdSchema }),
  asyncHandler(projectController.listBudgets)
);

/**
 * POST /api/projects/:id/budgets
 * Authenticated — create a budget line item.
 */
router.post(
  '/:id/budgets',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: createBudgetSchema }),
  asyncHandler(projectController.createBudget)
);

/**
 * PUT /api/projects/:id/budgets/:budgetId
 * Authenticated — update a budget line item.
 */
router.put(
  '/:id/budgets/:budgetId',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectBudgetIdSchema, body: updateBudgetSchema }),
  asyncHandler(projectController.updateBudget)
);

/**
 * DELETE /api/projects/:id/budgets/:budgetId
 * Authenticated — remove a budget line item.
 */
router.delete(
  '/:id/budgets/:budgetId',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectBudgetIdSchema }),
  asyncHandler(projectController.removeBudget)
);

// ─── Links ──────────────────────────────────────

/**
 * GET /api/projects/:id/links
 * Public — list links for a project.
 */
router.get(
  '/:id/links',
  validate({ params: projectIdSchema }),
  asyncHandler(projectController.listLinks)
);

/**
 * POST /api/projects/:id/links
 * Authenticated — add a link to a project.
 */
router.post(
  '/:id/links',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: createLinkSchema }),
  asyncHandler(projectController.createLink)
);

/**
 * DELETE /api/projects/:id/links/:linkId
 * Authenticated — remove a link.
 */
router.delete(
  '/:id/links/:linkId',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectLinkIdSchema }),
  asyncHandler(projectController.removeLink)
);

// ─── Updates ──────────────────────────────────────

/**
 * GET /api/projects/:id/updates
 * Public — list paginated status updates for a project.
 */
router.get(
  '/:id/updates',
  validate({ params: projectIdSchema, query: listUpdatesQuerySchema }),
  asyncHandler(projectController.listUpdates)
);

/**
 * POST /api/projects/:id/updates
 * Authenticated — add a status update.
 */
router.post(
  '/:id/updates',
  authenticate,
  authorize('runner', 'project_lead'),
  projectWriteGate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: createUpdateSchema }),
  asyncHandler(projectController.createUpdate)
);

router.delete('/:id/updates/:updateId', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, asyncHandler(projectController.deleteUpdate));

// ─── Audit Log (read-only, never deletable) ────────────

router.get('/:id/audit', validate({ params: projectIdSchema }), asyncHandler(async (req: Request, res: Response) => {
  const projectId = req.params.id as string;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 30), 100);
  const offset = (page - 1) * limit;

  // Search by: direct project match, existing sub-resources, AND deleted sub-resources (via _projectId in new_data JSON)
  const where = `WHERE al.record_id = $1
        OR al.record_id IN (SELECT pk_module FROM module WHERE fk_module_project = $1)
        OR al.record_id IN (SELECT pk_project_budget FROM project_budget WHERE fk_project_budget_project = $1)
        OR al.record_id IN (SELECT pk_project_link FROM project_link WHERE fk_project_link_project = $1)
        OR al.record_id IN (SELECT pk_project_lead FROM project_lead WHERE fk_project_lead_project = $1)
        OR al.record_id IN (SELECT pk_project_update FROM project_update WHERE fk_project_update_project = $1)
        OR al.new_data->>'_projectId' = $1::text`;

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM audit_log al ${where}`, [projectId]),
    pool.query(
      `SELECT al.*, ua.user_display_name, ua.user_email_address
       FROM audit_log al
       LEFT JOIN user_account ua ON ua.pk_user_account = al.user_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $2 OFFSET $3`,
      [projectId, limit, offset]
    ),
  ]);

  const total = countResult.rows[0].total;
  sendSuccess(res, { data: dataResult.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
}));

// ─── Module Links ──────────────────────────────────────

router.get('/:id/modules/:moduleId/links', asyncHandler(projectController.listModuleLinks));
router.post('/:id/modules/:moduleId/links', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, asyncHandler(projectController.createModuleLink));
router.delete('/:id/modules/:moduleId/links/:linkId', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, asyncHandler(projectController.removeModuleLink));

// ─── Leads / Team ──────────────────────────────────────

router.get('/:id/leads', validate({ params: projectIdSchema }), asyncHandler(projectController.listLeads));
router.post('/:id/leads', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, validate({ params: projectIdSchema }), asyncHandler(projectController.addLead));
router.put('/:id/leads/:leadId', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, asyncHandler(projectController.updateLead));
router.delete('/:id/leads/:leadId', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, asyncHandler(projectController.removeLead));

// ─── Application Links ──────────────────────────────────────
router.get('/:id/applications', validate({ params: projectIdSchema }), asyncHandler(projectController.listApplicationLinks));
router.post('/:id/applications', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, validate({ params: projectIdSchema, body: linkApplicationSchema }), asyncHandler(projectController.linkApplication));
router.delete('/:id/applications/:linkId', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, validate({ params: projectLinkEntityIdSchema }), asyncHandler(projectController.unlinkApplication));

// ─── Contract Links ──────────────────────────────────────
router.get('/:id/contracts', validate({ params: projectIdSchema }), asyncHandler(projectController.listContractLinks));
router.post('/:id/contracts', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, validate({ params: projectIdSchema, body: linkContractSchema }), asyncHandler(projectController.linkContract));
router.delete('/:id/contracts/:linkId', authenticate, authorize('runner', 'project_lead'), projectWriteGate, ifMatchProject, idempotency, csrf, validate({ params: projectLinkEntityIdSchema }), asyncHandler(projectController.unlinkContract));

// ═══ Collaboration: cloning, members, lock, clone-policy ═══════════════════
//
// All endpoints require authentication. Per-action authorization (owner/admin/role)
// is checked inside the controller via the project-permissions helper, since the
// gate depends on project state (open vs claimed, locked, clone-disabled).

// Clone — runner+ may clone any cloneable, top-level project
router.post(
  '/:id/clone',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: projectIdSchema, body: cloneProjectSchema }),
  asyncHandler(collabController.clone),
);

// Cluster / Versions (public reads — anyone can see the family tree)
router.get('/:id/cluster',  validate({ params: projectIdSchema }), asyncHandler(collabController.getCluster));
router.get('/:id/versions', validate({ params: projectIdSchema }), asyncHandler(collabController.listVersions));

// Version label (owner-only)
router.put(
  '/:id/version-label',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: renameVersionSchema }),
  asyncHandler(collabController.renameVersion),
);

// Lock / Unlock
router.post(
  '/:id/lock',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: lockSchema }),
  asyncHandler(collabController.lock),
);
router.post(
  '/:id/unlock',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: unlockSchema }),
  asyncHandler(collabController.unlock),
);

// Members
router.get('/:id/members', validate({ params: projectIdSchema }), asyncHandler(collabController.listMembers));
router.get('/:id/members/history', authenticate, validate({ params: projectIdSchema }), asyncHandler(collabController.listMemberHistory));
router.post(
  '/:id/members',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: memberAddSchema }),
  asyncHandler(collabController.addMember),
);
router.patch(
  '/:id/members/:membershipId',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectMembershipParamSchema, body: memberPatchSchema }),
  asyncHandler(collabController.patchMemberRole),
);
router.delete(
  '/:id/members/:membershipId',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectMembershipParamSchema }),
  asyncHandler(collabController.removeMember),
);

// Ownership transfer (owner → another member)
router.post(
  '/:id/transfer-ownership',
  authenticate,
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: transferOwnershipSchema }),
  asyncHandler(collabController.transferOwnership),
);

// Clone policy (admin only — service enforces)
router.patch(
  '/:id/clone-policy',
  authenticate,
  authorize('admin'),
  ifMatchProject,
  idempotency,
  csrf,
  validate({ params: projectIdSchema, body: clonePolicySchema }),
  asyncHandler(collabController.setClonePolicy),
);

// Permission introspection — UI uses this to render gates
router.get(
  '/:id/permissions',
  authenticate,
  validate({ params: projectIdSchema }),
  asyncHandler(collabController.getPermissions),
);

export default router;
