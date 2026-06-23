import * as projectModel from '../models/project.model';
import * as sharepointService from './sharepoint.service';
import { pool } from '../config/database';
import { logAuditEvent } from '../utils/audit-logger';
import { AppError } from '../utils/app-error';
import { velocityStreamManager } from '../sse/velocity-stream';
import logger from '../utils/logger';

/**
 * Auto-provision SharePoint folders for a project. Fire-and-forget — failures
 * are logged but never block project creation (SharePoint may be unconfigured
 * in dev, or temporarily unreachable; either case shouldn't fail the user's
 * "create project" action).
 */
function autoProvisionSharepoint(projectId: string, projectName: string): void {
  sharepointService.ensureProjectHierarchy(projectId)
    .then(summary => {
      logger.info('SharePoint folders auto-provisioned for new project', {
        projectId,
        projectName,
        foldersCreated: summary.foldersCreated,
        foldersExisted: summary.foldersExisted,
      });
      velocityStreamManager.broadcast('sharepoint_folders_created', {
        projectId,
        projectName,
        foldersCreated: summary.foldersCreated,
        foldersExisted: summary.foldersExisted,
        autoProvisioned: true,
      });
    })
    .catch(err => {
      logger.warn('SharePoint auto-provision skipped', {
        projectId,
        projectName,
        error: (err as Error).message,
      });
    });
}
import type {
  ProjectRecord,
  ProjectDetail,
  ProjectListItem,
  ProjectFilters,
} from '../models/project.model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * List projects with filtering, sorting, and pagination.
 */
export async function list(
  filters: ProjectFilters,
  page: number,
  limit: number
): Promise<PaginatedResult<ProjectListItem>> {
  const [data, total] = await Promise.all([
    projectModel.findAll(filters, page, limit),
    projectModel.countAll(filters),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  };
}

/**
 * Get a single project by ID with all related data.
 * Throws 404 if not found or soft-deleted.
 */
export async function getById(id: string): Promise<ProjectDetail> {
  const project = await projectModel.findById(id);

  if (!project) {
    throw AppError.notFound('Project not found');
  }

  return project;
}

/**
 * Create a new project.
 * Validates that the ministry exists (when provided) before inserting.
 */
async function resolveMinistryCode(data: Record<string, unknown>): Promise<void> {
  if (data._ministryCode) {
    const result = await pool.query(
      `SELECT pk_ministry FROM ministry WHERE ministry_code = $1`,
      [data._ministryCode]
    );
    if (result.rows.length === 0) {
      throw AppError.badRequest(`Ministry code '${data._ministryCode}' not found`);
    }
    data.fk_project_ministry = result.rows[0].pk_ministry;
    delete data._ministryCode;
  }
  if (data.fk_project_ministry) {
    const exists = await projectModel.ministryExists(data.fk_project_ministry as string);
    if (!exists) {
      throw AppError.badRequest('Ministry not found');
    }
  }
}

export async function create(
  data: Partial<ProjectRecord> & Record<string, unknown>,
  userId: string,
  ipAddress?: string
): Promise<ProjectRecord> {
  await resolveMinistryCode(data as Record<string, unknown>);

  const project = await projectModel.create(data, userId);

  await logAuditEvent({
    action: 'INSERT',
    tableName: 'project',
    recordId: project.pk_project,
    userId,
    ipAddress,
    newData: { project_name: project.project_name },
  });

  velocityStreamManager.broadcast('project_created', {
    projectId: project.pk_project,
    projectName: project.project_name,
  });

  // Auto-provision SharePoint folders (fire-and-forget, never blocks project create)
  autoProvisionSharepoint(project.pk_project, project.project_name);

  return project;
}

/**
 * Update an existing project.
 * Validates that the ministry exists (when changed) before updating.
 * Throws 404 if the project is not found or already deleted.
 */
export async function update(
  id: string,
  data: Partial<ProjectRecord> & Record<string, unknown>,
  userId: string,
  ipAddress?: string
): Promise<ProjectRecord> {
  await resolveMinistryCode(data as Record<string, unknown>);

  // Fetch old record for audit diff
  const oldProject = await projectModel.findById(id);
  if (!oldProject) {
    throw AppError.notFound('Project not found');
  }

  const updated = await projectModel.update(id, data, userId);

  if (!updated) {
    throw AppError.notFound('Project not found');
  }

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: id,
    userId,
    ipAddress,
    oldData: { project_name: oldProject.project_name, project_status: oldProject.project_status },
    newData: { project_name: updated.project_name, project_status: updated.project_status },
  });

  // If the project was renamed, kick the SharePoint reconciler so the
  // existing folder is renamed in-place rather than orphaned. Fire-and-forget
  // (matches autoProvisionSharepoint) — SharePoint can be unconfigured /
  // unreachable without breaking the project rename itself.
  if (oldProject.project_name !== updated.project_name) {
    autoProvisionSharepoint(id, updated.project_name);
  }

  velocityStreamManager.broadcast('project_updated', {
    projectId: id,
    projectName: updated.project_name,
    status: updated.project_status,
  });

  return updated;
}

/**
 * Soft-delete a project.
 * Throws 404 if the project is not found or already deleted.
 */
export async function remove(
  id: string,
  userId: string,
  ipAddress?: string
): Promise<void> {
  const deleted = await projectModel.remove(id, userId);

  if (!deleted) {
    throw AppError.notFound('Project not found');
  }

  // Cascade soft-delete: modules
  await pool.query(
    `UPDATE module SET is_deleted = true, deleted_at = NOW(), updated_by = $1
     WHERE fk_module_project = $2 AND is_deleted = false`,
    [userId, id]
  );

  // Cascade soft-delete: SharePoint folder records
  await pool.query(
    `UPDATE sharepoint_folder SET is_deleted = true, updated_at = NOW()
     WHERE fk_sf_project = $1 AND is_deleted = false`,
    [id]
  );

  // Cascade soft-delete: audits → archived
  await pool.query(
    `UPDATE project_audit SET audit_status = 'archived', updated_at = NOW()
     WHERE fk_audit_project = $1 AND audit_status NOT IN ('archived', 'error')`,
    [id]
  );

  await logAuditEvent({
    action: 'DELETE',
    tableName: 'project',
    recordId: id,
    userId,
    ipAddress,
    oldData: {
      project_name: deleted.project_name,
      cascade: 'modules, sharepoint_folders, audits soft-deleted',
    },
  });

  velocityStreamManager.broadcast('project_deleted', {
    projectId: id,
    projectName: deleted.project_name,
  });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export async function mergeProjects(survivorId: string, victimId: string, userId: string, ipAddress?: string) {
  const survivor = await projectModel.findById(survivorId);
  const victim = await projectModel.findById(victimId);
  if (!survivor) throw AppError.notFound('Survivor project not found');
  if (!victim) throw AppError.notFound('Merge target project not found');
  if (survivorId === victimId) throw AppError.badRequest('Cannot merge a project with itself');

  // Transfer leads (skip duplicates)
  await pool.query(
    `UPDATE project_lead SET fk_project_lead_project = $1
     WHERE fk_project_lead_project = $2
       AND fk_project_lead_person NOT IN (
         SELECT fk_project_lead_person FROM project_lead WHERE fk_project_lead_project = $1 AND fk_project_lead_person IS NOT NULL
       )`,
    [survivorId, victimId]
  );
  await pool.query(`DELETE FROM project_lead WHERE fk_project_lead_project = $1`, [victimId]);

  // Transfer budgets
  await pool.query(`UPDATE project_budget SET fk_project_budget_project = $1 WHERE fk_project_budget_project = $2`, [survivorId, victimId]);

  // Transfer links (all)
  await pool.query(`UPDATE project_link SET fk_project_link_project = $1 WHERE fk_project_link_project = $2`, [survivorId, victimId]);

  // Transfer modules
  await pool.query(`UPDATE module SET fk_module_project = $1 WHERE fk_module_project = $2`, [survivorId, victimId]);

  // Transfer updates
  await pool.query(`UPDATE project_update SET fk_project_update_project = $1 WHERE fk_project_update_project = $2`, [survivorId, victimId]);

  // Soft-delete victim
  await projectModel.remove(victimId, userId);

  // Remove duplicate pair entries
  await pool.query(`DELETE FROM project_duplicate WHERE fk_duplicate_project_1 = $1 OR fk_duplicate_project_2 = $1`, [victimId]);

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: survivorId,
    userId,
    ipAddress,
    oldData: { merged_from: victim.project_name, merged_from_id: victimId },
    newData: { merged_into: survivor.project_name },
  });

  return { survivor: survivor.project_name, victimDeleted: victim.project_name };
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export async function listModules(projectId: string) {
  const result = await pool.query(
    `SELECT * FROM module WHERE fk_module_project = $1 AND is_deleted = false ORDER BY module_sort_order, created_at`,
    [projectId]
  );
  return result.rows;
}

// Helper: fire-and-forget audit
// Current auth context — set by controller before calling service
let _currentAuthSource: string = 'session';
let _currentApiKeyId: string | undefined;

export function setAuthContext(source: string, apiKeyId?: string) {
  _currentAuthSource = source;
  _currentApiKeyId = apiKeyId;
}

function audit(action: string, tableName: string, recordId: string, userId: string, newData?: Record<string, unknown>, oldData?: Record<string, unknown>, projectId?: string) {
  const enriched = {
    ...(newData || {}),
    _authSource: _currentAuthSource,
    _apiKeyId: _currentApiKeyId,
    ...(projectId ? { _projectId: projectId } : {}),
  };
  logAuditEvent({ action: action as any, tableName, recordId, userId, newData: enriched, oldData }).catch((err) => {
    console.error('[AUDIT FAILURE]', err.message, { action, tableName, recordId });
  });
}

export async function createModule(projectId: string, data: Record<string, unknown>, userId: string) {
  const result = await pool.query(
    `INSERT INTO module (fk_module_project, module_name, module_description, module_status, module_start_date, module_end_date, module_percent_complete, module_sort_order, module_plan, module_progress, module_blockers, module_complexity, module_is_mission_critical, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
     RETURNING *`,
    [projectId, data.name, data.description || null, data.status || 'requirements_gathering', data.startDate || null, data.endDate || null, data.percentComplete ?? 0, data.sortOrder ?? 0, data.plan || null, data.progress || null, data.blockers || null, data.complexity ?? 1.0, data.isMissionCritical ?? false, userId]
  );
  audit('INSERT', 'module', result.rows[0].pk_module, userId, { name: data.name }, undefined, projectId);

  velocityStreamManager.broadcast('module_created', {
    projectId,
    moduleId: result.rows[0].pk_module,
    moduleName: result.rows[0].module_name,
  });

  // Auto-extend SharePoint hierarchy with the new module's folders. Idempotent —
  // existing folders are skipped. Fire-and-forget so module creation doesn't block.
  autoProvisionSharepoint(projectId, result.rows[0].module_name);

  return result.rows[0];
}

export async function updateModule(moduleId: string, projectId: string, data: Record<string, unknown>, userId: string) {
  // Fetch the pre-update name so we can detect a rename and trigger the
  // SharePoint reconciler — without this, renaming a module orphans its
  // SharePoint folder on the next reconcile pass (same bug class as project
  // rename, observed with "Test User..." / "Sample User..." duplicates).
  const oldModuleRes = await pool.query<{ module_name: string }>(
    `SELECT module_name FROM module WHERE pk_module = $1 AND fk_module_project = $2 AND is_deleted = false`,
    [moduleId, projectId],
  );
  const oldModuleName = oldModuleRes.rows[0]?.module_name;

  const result = await pool.query(
    `UPDATE module SET
       module_name = COALESCE($2, module_name),
       module_description = COALESCE($3, module_description),
       module_status = COALESCE($4, module_status),
       module_start_date = COALESCE($5, module_start_date),
       module_end_date = COALESCE($6, module_end_date),
       module_percent_complete = COALESCE($7, module_percent_complete),
       module_sort_order = COALESCE($8, module_sort_order),
       module_plan = COALESCE($9, module_plan),
       module_progress = COALESCE($10, module_progress),
       module_blockers = COALESCE($11, module_blockers),
       module_complexity = COALESCE($12, module_complexity),
       module_is_mission_critical = COALESCE($13, module_is_mission_critical),
       updated_by = $14
     WHERE pk_module = $1 AND fk_module_project = $15 AND is_deleted = false
     RETURNING *`,
    [moduleId, data.name, data.description, data.status, data.startDate, data.endDate, data.percentComplete, data.sortOrder, data.plan, data.progress, data.blockers, data.complexity, data.isMissionCritical, userId, projectId]
  );
  if (!result.rows[0]) throw AppError.notFound('Module not found');
  audit('UPDATE', 'module', moduleId, userId, { name: data.name, status: data.status }, undefined, projectId);

  // Module renamed → reconcile SharePoint folder hierarchy for the project.
  // ensureProjectHierarchy iterates all modules and reconciles each by id,
  // so this single call handles the renamed module without N+1 logic.
  if (oldModuleName && oldModuleName !== result.rows[0].module_name) {
    autoProvisionSharepoint(projectId, result.rows[0].module_name);
  }

  velocityStreamManager.broadcast('module_updated', {
    projectId,
    moduleId,
    moduleName: result.rows[0].module_name,
    status: result.rows[0].module_status,
  });

  return result.rows[0];
}

export async function removeModule(moduleId: string, projectId: string, userId: string) {
  const result = await pool.query(
    `UPDATE module SET is_deleted = true, deleted_at = NOW(), updated_by = $2 WHERE pk_module = $1 AND fk_module_project = $3 AND is_deleted = false RETURNING *`,
    [moduleId, userId, projectId]
  );
  if (!result.rows[0]) throw AppError.notFound('Module not found');
  audit('DELETE', 'module', moduleId, userId, undefined, { name: result.rows[0].module_name }, projectId);

  velocityStreamManager.broadcast('module_deleted', {
    projectId,
    moduleId,
    moduleName: result.rows[0].module_name,
  });
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export async function listBudgets(projectId: string) {
  const result = await pool.query(
    `SELECT * FROM project_budget WHERE fk_project_budget_project = $1 ORDER BY budget_fiscal_year`,
    [projectId]
  );
  return result.rows;
}

export async function createBudget(projectId: string, data: Record<string, unknown>, userId: string) {
  const result = await pool.query(
    `INSERT INTO project_budget (fk_project_budget_project, budget_fiscal_year, budget_funding_source, budget_money_type, budget_amount, budget_spent, budget_notes, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
    [projectId, data.fiscalYear, data.fundingSource, data.moneyType, data.amount ?? 0, data.spent ?? 0, data.notes || null, userId]
  );
  audit('INSERT', 'project_budget', result.rows[0].pk_project_budget, userId, { fy: data.fiscalYear, amount: data.amount }, undefined, projectId);
  return result.rows[0];
}

export async function updateBudget(budgetId: string, projectId: string, data: Record<string, unknown>, userId: string) {
  const result = await pool.query(
    `UPDATE project_budget SET
       budget_fiscal_year = COALESCE($2, budget_fiscal_year),
       budget_funding_source = COALESCE($3, budget_funding_source),
       budget_money_type = COALESCE($4, budget_money_type),
       budget_amount = COALESCE($5, budget_amount),
       budget_spent = COALESCE($6, budget_spent),
       budget_notes = COALESCE($7, budget_notes),
       updated_by = $8
     WHERE pk_project_budget = $1 RETURNING *`,
    [budgetId, data.fiscalYear, data.fundingSource, data.moneyType, data.amount, data.spent, data.notes, userId]
  );
  if (!result.rows[0]) throw AppError.notFound('Budget not found');
  audit('UPDATE', 'project_budget', budgetId, userId, { fy: data.fiscalYear, amount: data.amount }, undefined, projectId);
  return result.rows[0];
}

export async function removeBudget(budgetId: string, projectId: string, userId?: string) {
  const result = await pool.query(`DELETE FROM project_budget WHERE pk_project_budget = $1 AND fk_project_budget_project = $2 RETURNING *`, [budgetId, projectId]);
  if (!result.rows[0]) throw AppError.notFound('Budget not found');
  if (userId) audit('DELETE', 'project_budget', budgetId, userId, undefined, { fy: result.rows[0].budget_fiscal_year }, projectId);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export async function listLinks(projectId: string) {
  const result = await pool.query(
    `SELECT * FROM project_link WHERE fk_project_link_project = $1 ORDER BY link_type, created_at`,
    [projectId]
  );
  return result.rows;
}

export async function createLink(projectId: string, data: Record<string, unknown>, userId: string) {
  const result = await pool.query(
    `INSERT INTO project_link (fk_project_link_project, link_type, link_url, link_label, link_description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [projectId, data.type, data.url, data.label || null, data.description || null, userId]
  );
  audit('INSERT', 'project_link', result.rows[0].pk_project_link, userId, { type: data.type, url: data.url }, undefined, projectId);
  return result.rows[0];
}

export async function removeLink(linkId: string, projectId: string, userId?: string) {
  const result = await pool.query(`DELETE FROM project_link WHERE pk_project_link = $1 AND fk_project_link_project = $2 RETURNING *`, [linkId, projectId]);
  if (!result.rows[0]) throw AppError.notFound('Link not found');
  if (userId) audit('DELETE', 'project_link', linkId, userId, undefined, { url: result.rows[0].link_url }, projectId);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export async function listUpdates(projectId: string, type?: string) {
  const params: unknown[] = [projectId];
  let where = 'fk_project_update_project = $1';
  if (type) {
    where += ` AND update_type = $2`;
    params.push(type);
  }
  const result = await pool.query(
    `SELECT u.*, ua.user_display_name, ua.user_email_address
     FROM project_update u
     LEFT JOIN user_account ua ON ua.pk_user_account = u.fk_project_update_user
     WHERE ${where}
     ORDER BY u.created_at DESC`,
    params
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Leads / Team
// ---------------------------------------------------------------------------

export async function listLeads(projectId: string) {
  const result = await pool.query(
    `SELECT pl.*, p.person_display_name, p.person_email, p.person_organization, p.person_is_fte
     FROM project_lead pl
     LEFT JOIN person p ON p.pk_person = pl.fk_project_lead_person
     WHERE pl.fk_project_lead_project = $1
     ORDER BY pl.lead_is_primary DESC, pl.lead_role ASC, pl.lead_name ASC`,
    [projectId]
  );
  return result.rows;
}

export async function addLead(projectId: string, data: Record<string, unknown>, userId: string) {
  // If personId provided, look up display name
  let name = data.name as string;
  let personId = data.personId as string | null;
  if (personId) {
    const personResult = await pool.query('SELECT person_display_name FROM person WHERE pk_person = $1', [personId]);
    if (personResult.rows[0]) name = name || personResult.rows[0].person_display_name;
  }
  if (!name) throw AppError.badRequest('Name is required');

  const result = await pool.query(
    `INSERT INTO project_lead (fk_project_lead_project, fk_project_lead_person, lead_name, lead_role, lead_is_primary, lead_is_fte, lead_organization)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [projectId, personId || null, name, data.role || 'team_member', data.isPrimary ?? false, data.isFte ?? true, data.organization || null]
  );
  audit('INSERT', 'project_lead', result.rows[0].pk_project_lead, userId, { name, role: data.role }, undefined, projectId);
  return result.rows[0];
}

export async function updateLead(leadId: string, data: Record<string, unknown>) {
  const result = await pool.query(
    `UPDATE project_lead SET
       lead_name = COALESCE($2, lead_name),
       lead_role = COALESCE($3, lead_role),
       lead_is_primary = COALESCE($4, lead_is_primary),
       lead_is_fte = COALESCE($5, lead_is_fte),
       lead_organization = COALESCE($6, lead_organization),
       fk_project_lead_person = COALESCE($7, fk_project_lead_person)
     WHERE pk_project_lead = $1 RETURNING *`,
    [leadId, data.name, data.role, data.isPrimary, data.isFte, data.organization, data.personId]
  );
  if (!result.rows[0]) throw AppError.notFound('Lead not found');
  return result.rows[0];
}

export async function removeLead(leadId: string, projectId: string, userId?: string) {
  const result = await pool.query('DELETE FROM project_lead WHERE pk_project_lead = $1 AND fk_project_lead_project = $2 RETURNING *', [leadId, projectId]);
  if (!result.rows[0]) throw AppError.notFound('Lead not found');
  if (userId) audit('DELETE', 'project_lead', leadId, userId, undefined, { name: result.rows[0].lead_name }, projectId);
}

// ---------------------------------------------------------------------------
// Module Links
// ---------------------------------------------------------------------------

export async function listModuleLinks(moduleId: string) {
  const result = await pool.query(
    `SELECT * FROM module_link WHERE fk_module_link_module = $1 ORDER BY link_type, created_at`,
    [moduleId]
  );
  return result.rows;
}

export async function createModuleLink(moduleId: string, data: Record<string, unknown>, userId: string) {
  const result = await pool.query(
    `INSERT INTO module_link (fk_module_link_module, link_type, link_url, link_label, link_description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [moduleId, data.type, data.url, data.label || null, data.description || null, userId]
  );
  audit('INSERT', 'module_link', result.rows[0].pk_module_link, userId, { type: data.type, url: data.url });
  return result.rows[0];
}

export async function removeModuleLink(linkId: string, moduleId: string, userId?: string) {
  const result = await pool.query(`DELETE FROM module_link WHERE pk_module_link = $1 AND fk_module_link_module = $2 RETURNING *`, [linkId, moduleId]);
  if (!result.rows[0]) throw AppError.notFound('Module link not found');
  if (userId) audit('DELETE', 'module_link', linkId, userId, undefined, { url: result.rows[0].link_url });
}

export async function deleteUpdate(updateId: string, projectId: string, userId: string) {
  const result = await pool.query('DELETE FROM project_update WHERE pk_project_update = $1 AND fk_project_update_project = $2 RETURNING *', [updateId, projectId]);
  if (!result.rows[0]) throw AppError.notFound('Update not found');

  audit('DELETE', 'project_update', updateId, userId, undefined, { type: result.rows[0].update_type, title: result.rows[0].update_title, content: result.rows[0].update_content?.substring(0, 200) }, projectId);
}

export async function createUpdate(projectId: string, data: Record<string, unknown>, userId: string) {
  const result = await pool.query(
    `INSERT INTO project_update (fk_project_update_project, fk_project_update_module, fk_project_update_user, update_type, update_title, update_content, update_content_json, update_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [projectId, data.moduleId || null, userId, data.type || 'progress', data.title || null, data.content, data.contentJson ? JSON.stringify(data.contentJson) : null, data.source || 'manual']
  );
  audit('INSERT', 'project_update', result.rows[0].pk_project_update, userId, { type: data.type, title: data.title }, undefined, projectId);
  return result.rows[0];
}
