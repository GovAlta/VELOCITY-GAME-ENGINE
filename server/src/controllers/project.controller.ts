import { Request, Response } from 'express';
import * as projectService from '../services/project.service';
import { setAuthContext } from '../services/project.service';
import { sendSuccess, sendPaginated } from '../utils/response';
import { pool } from '../config/database';
import { logAuditEvent } from '../utils/audit-logger';

/**
 * Map frontend camelCase body to DB snake_case fields.
 * Coerce empty strings to null for nullable columns.
 */
function mapBodyToDb(body: Record<string, unknown>): Record<string, unknown> {
  const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
  const result: Record<string, unknown> = {};

  if ('projectCode' in body) result.project_code = emptyToNull(body.projectCode);
  if ('name' in body) result.project_name = body.name;
  if ('description' in body) result.project_description = emptyToNull(body.description);
  if ('status' in body) result.project_status = emptyToNull(body.status);
  if ('startDate' in body) result.project_start_date = emptyToNull(body.startDate && String(body.startDate) <= '9999-12-31' ? body.startDate : null);
  if ('endDate' in body) result.project_end_date = emptyToNull(body.endDate && String(body.endDate) <= '9999-12-31' ? body.endDate : null);
  if ('goLiveDateType' in body) result.project_go_live_date_type = emptyToNull(body.goLiveDateType);
  if ('percentComplete' in body) result.project_percent_complete = body.percentComplete ?? null;
  if ('priority' in body) result.project_priority = emptyToNull(body.priority);
  if ('scope' in body) result.project_scope = emptyToNull(body.scope);
  if ('category' in body) result.project_category = emptyToNull(body.category);
  if ('demandNumber' in body) result.project_demand_number = emptyToNull(body.demandNumber);
  if ('ministryPriority' in body) result.project_ministry_priority = body.ministryPriority ?? null;
  if ('risk' in body) result.project_risk = emptyToNull(body.risk);
  if ('additionalInfo' in body) result.project_additional_info = emptyToNull(body.additionalInfo);
  if ('branch' in body) result.project_branch = emptyToNull(body.branch);
  if ('isMissionCritical' in body) result.project_is_mission_critical = body.isMissionCritical ?? false;
  if ('isChallenge' in body) result.project_is_challenge = body.isChallenge ?? false;
  if ('challengePoints' in body) result.challenge_points = body.challengePoints ?? 0;
  if ('challengeMaxDays' in body) result.challenge_max_days = body.challengeMaxDays ?? 5;
  if ('challengeDifficulty' in body) result.challenge_difficulty = body.challengeDifficulty ?? null;
  if ('challengeMaxAcceptances' in body) {
    const v = body.challengeMaxAcceptances;
    result.challenge_max_acceptances = (v === '' || v === undefined) ? null : v;
  }
  if ('ministryCode' in body) result._ministryCode = body.ministryCode; // resolved to UUID in service

  return result;
}

/** Set auth context for audit attribution before any service call */
function setAuth(req: Request) {
  setAuthContext((req as any)._authSource || 'session', (req as any)._apiKeyId);
}

// ─── Projects ────────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response): Promise<void> {
  const { page, limit, sort, order, search, ministry, status, missionCritical } = req.query as Record<string, string>;
  const result = await projectService.list(
    { search, ministry, status, missionCritical, sort, order },
    Number(page) || 1,
    Number(limit) || 20,
  );
  sendPaginated(res, result.data, result.pagination);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const project = await projectService.getById(req.params.id as string);
  sendSuccess(res, project);
}

export async function create(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const userId = req.user!.id;
  const dbData = mapBodyToDb(req.body);
  const project = await projectService.create(dbData as any, userId, req.ip ?? undefined);
  sendSuccess(res, project, 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const userId = req.user!.id;
  const dbData = mapBodyToDb(req.body);
  const project = await projectService.update(req.params.id as string, dbData as any, userId, req.ip ?? undefined);
  sendSuccess(res, project);
}

export async function remove(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const userId = req.user!.id;
  await projectService.remove(req.params.id as string, userId, req.ip ?? undefined);
  res.status(204).end();
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export async function merge(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const result = await projectService.mergeProjects(req.params.id as string, req.body.mergeProjectId, req.user!.id, req.ip ?? undefined);
  sendSuccess(res, result);
}

// ─── Modules ─────────────────────────────────────────────────────────────────

export async function listModules(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await projectService.listModules(req.params.id as string));
}

export async function createModule(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const data = { ...req.body };
  if (data.startDate === '') data.startDate = null;
  if (data.endDate === '') data.endDate = null;
  sendSuccess(res, await projectService.createModule(req.params.id as string, data, req.user!.id), 201);
}

export async function updateModule(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const data = { ...req.body };
  if (data.startDate === '') data.startDate = null;
  if (data.endDate === '') data.endDate = null;
  sendSuccess(res, await projectService.updateModule(req.params.moduleId as string, req.params.id as string, data, req.user!.id));
}

export async function removeModule(req: Request, res: Response): Promise<void> {
  setAuth(req);
  await projectService.removeModule(req.params.moduleId as string, req.params.id as string, req.user!.id);
  res.status(204).end();
}

// ─── Budgets ─────────────────────────────────────────────────────────────────

export async function listBudgets(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await projectService.listBudgets(req.params.id as string));
}

export async function createBudget(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.createBudget(req.params.id as string, req.body, req.user!.id), 201);
}

export async function updateBudget(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.updateBudget(req.params.budgetId as string, req.params.id as string, req.body, req.user!.id));
}

export async function removeBudget(req: Request, res: Response): Promise<void> {
  setAuth(req);
  await projectService.removeBudget(req.params.budgetId as string, req.params.id as string, req.user!.id);
  res.status(204).end();
}

// ─── Links ───────────────────────────────────────────────────────────────────

export async function listLinks(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await projectService.listLinks(req.params.id as string));
}

export async function createLink(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.createLink(req.params.id as string, req.body, req.user!.id), 201);
}

export async function removeLink(req: Request, res: Response): Promise<void> {
  setAuth(req);
  await projectService.removeLink(req.params.linkId as string, req.params.id as string, req.user!.id);
  res.status(204).end();
}

// ─── Updates ─────────────────────────────────────────────────────────────────

export async function listUpdates(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await projectService.listUpdates(req.params.id as string, req.query.type as string | undefined));
}

export async function createUpdate(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.createUpdate(req.params.id as string, req.body, req.user!.id), 201);
}

export async function deleteUpdate(req: Request, res: Response): Promise<void> {
  setAuth(req);
  await projectService.deleteUpdate(req.params.updateId as string, req.params.id as string, req.user!.id);
  res.status(204).end();
}

// ─── Leads / Team ────────────────────────────────────────────────────────────

export async function listLeads(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await projectService.listLeads(req.params.id as string));
}

export async function addLead(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.addLead(req.params.id as string, req.body, req.user!.id), 201);
}

export async function updateLead(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.updateLead(req.params.leadId as string, req.body));
}

export async function removeLead(req: Request, res: Response): Promise<void> {
  setAuth(req);
  await projectService.removeLead(req.params.leadId as string, req.params.id as string, req.user!.id);
  res.status(204).end();
}

// ─── Module Links ────────────────────────────────────────────────────────────

export async function listModuleLinks(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await projectService.listModuleLinks(req.params.moduleId as string));
}

export async function createModuleLink(req: Request, res: Response): Promise<void> {
  setAuth(req);
  sendSuccess(res, await projectService.createModuleLink(req.params.moduleId as string, req.body, req.user!.id), 201);
}

export async function removeModuleLink(req: Request, res: Response): Promise<void> {
  setAuth(req);
  await projectService.removeModuleLink(req.params.linkId as string, req.params.moduleId as string, req.user!.id);
  res.status(204).end();
}

// ─── Application Links ──────────────────────────────────────────────────────

export async function listApplicationLinks(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const result = await pool.query(
    `SELECT pa.*, a.application_name, a.application_type, a.application_install_type, m2.module_name
     FROM project_application pa
     JOIN application a ON pa.fk_pa_application = a.pk_application
     LEFT JOIN module m2 ON pa.fk_pa_module = m2.pk_module
     WHERE pa.fk_pa_project = $1
     ORDER BY a.application_name`,
    [projectId]
  );
  sendSuccess(res, result.rows);
}

export async function linkApplication(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const userId = req.user?.id as string | undefined;
  const { applicationId, moduleId, relationshipType, description } = req.body;
  const result = await pool.query(
    `INSERT INTO project_application (fk_pa_project, fk_pa_application, fk_pa_module, pa_relationship_type, pa_description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [projectId, applicationId, moduleId || null, relationshipType || 'other', description || null]
  );
  logAuditEvent({ action: 'INSERT', tableName: 'project_application', recordId: result.rows[0].pk_project_application, userId, newData: { projectId, applicationId, relationshipType } }).catch(() => {});
  sendSuccess(res, result.rows[0], 201);
}

export async function unlinkApplication(req: Request, res: Response): Promise<void> {
  const { id: projectId, linkId } = req.params;
  const userId = req.user?.id as string | undefined;
  const result = await pool.query(
    `DELETE FROM project_application WHERE pk_project_application = $1 AND fk_pa_project = $2 RETURNING *`,
    [linkId, projectId]
  );
  if (result.rows[0]) {
    logAuditEvent({ action: 'DELETE', tableName: 'project_application', recordId: linkId as string, userId, oldData: { projectId, applicationId: result.rows[0].fk_pa_application } }).catch(() => {});
  }
  res.status(204).end();
}

// ─── Contract Links ─────────────────────────────────────────────────────────

export async function listContractLinks(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const result = await pool.query(
    `SELECT pc.*, c.contract_name, c.contract_commodity_type, c.contract_vendor, c.contract_external_id, m2.module_name
     FROM project_contract pc
     JOIN contract c ON pc.fk_pc_contract = c.pk_contract
     LEFT JOIN module m2 ON pc.fk_pc_module = m2.pk_module
     WHERE pc.fk_pc_project = $1
     ORDER BY c.contract_name`,
    [projectId]
  );
  sendSuccess(res, result.rows);
}

export async function linkContract(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const userId = req.user?.id as string | undefined;
  const { contractId, moduleId, relationshipType, description } = req.body;
  const result = await pool.query(
    `INSERT INTO project_contract (fk_pc_project, fk_pc_contract, fk_pc_module, pc_relationship_type, pc_description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [projectId, contractId, moduleId || null, relationshipType || 'other', description || null]
  );
  logAuditEvent({ action: 'INSERT', tableName: 'project_contract', recordId: result.rows[0].pk_project_contract, userId, newData: { projectId, contractId, relationshipType } }).catch(() => {});
  sendSuccess(res, result.rows[0], 201);
}

export async function unlinkContract(req: Request, res: Response): Promise<void> {
  const { id: projectId, linkId } = req.params;
  const userId = req.user?.id as string | undefined;
  const result = await pool.query(
    `DELETE FROM project_contract WHERE pk_project_contract = $1 AND fk_pc_project = $2 RETURNING *`,
    [linkId, projectId]
  );
  if (result.rows[0]) {
    logAuditEvent({ action: 'DELETE', tableName: 'project_contract', recordId: linkId as string, userId, oldData: { projectId, contractId: result.rows[0].fk_pc_contract } }).catch(() => {});
  }
  res.status(204).end();
}
