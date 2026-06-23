import { Request, Response } from 'express';
import * as applicationService from '../services/application.service';
import { sendSuccess, sendPaginated } from '../utils/response';

/**
 * Map frontend camelCase body to DB snake_case fields.
 * Coerce empty strings to null for nullable columns.
 */
function mapBodyToDb(body: Record<string, unknown>): Record<string, unknown> {
  const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
  const result: Record<string, unknown> = {};

  if ('name' in body) result.application_name = body.name;
  if ('aliases' in body) result.application_aliases = emptyToNull(body.aliases);
  if ('description' in body) result.application_description = emptyToNull(body.description);
  if ('businessProcess' in body) result.application_business_process = emptyToNull(body.businessProcess);
  if ('applicationType' in body) result.application_type = emptyToNull(body.applicationType);
  if ('architectureType' in body) result.application_architecture_type = emptyToNull(body.architectureType);
  if ('installType' in body) result.application_install_type = emptyToNull(body.installType);
  if ('installStatus' in body) result.application_install_status = emptyToNull(body.installStatus);
  if ('lifecycleStageStatus' in body) result.application_lifecycle_stage_status = emptyToNull(body.lifecycleStageStatus);
  if ('lifecycleStage' in body) result.application_lifecycle_stage = emptyToNull(body.lifecycleStage);
  if ('technologyStack' in body) result.application_technology_stack = emptyToNull(body.technologyStack);
  if ('userBase' in body) result.application_user_base = emptyToNull(body.userBase);
  if ('platform' in body) result.application_platform = emptyToNull(body.platform);
  if ('lastChangeDate' in body) result.application_last_change_date = emptyToNull(body.lastChangeDate && String(body.lastChangeDate) <= '9999-12-31' ? body.lastChangeDate : null);
  if ('businessOwner' in body) result.application_business_owner = emptyToNull(body.businessOwner);
  if ('itOwner' in body) result.application_it_owner = emptyToNull(body.itOwner);
  if ('lastUpdatedBy' in body) result.application_last_updated_by = emptyToNull(body.lastUpdatedBy);
  if ('businessCriticality' in body) result.application_business_criticality = emptyToNull(body.businessCriticality);
  if ('emergencyTier' in body) result.application_emergency_tier = emptyToNull(body.emergencyTier);
  if ('dataClassification' in body) result.application_data_classification = emptyToNull(body.dataClassification);
  if ('isCertified' in body) result.application_is_certified = body.isCertified ?? false;
  if ('department' in body) result.application_department = emptyToNull(body.department);
  if ('source' in body) result.application_source = emptyToNull(body.source);
  if ('ministryCode' in body) result._ministryCode = body.ministryCode; // resolved to UUID in service

  return result;
}

// ─── Applications ─────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response): Promise<void> {
  const { page, limit, sort, order, search, ministry, installType, dataClassification, applicationType, businessCriticality } = req.query as Record<string, string>;
  const result = await applicationService.list(
    { search, ministry, installType, dataClassification, applicationType, businessCriticality, sort, order },
    Number(page) || 1,
    Number(limit) || 20,
  );
  sendPaginated(res, result.data, result.pagination);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const application = await applicationService.getById(req.params.id as string);
  sendSuccess(res, application);
}

export async function create(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const dbData = mapBodyToDb(req.body);
  const application = await applicationService.create(dbData as any, userId, req.ip ?? undefined);
  sendSuccess(res, application, 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const dbData = mapBodyToDb(req.body);
  const application = await applicationService.update(req.params.id as string, dbData as any, userId, req.ip ?? undefined);
  sendSuccess(res, application);
}

export async function remove(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  await applicationService.remove(req.params.id as string, userId, req.ip ?? undefined);
  res.status(204).end();
}
