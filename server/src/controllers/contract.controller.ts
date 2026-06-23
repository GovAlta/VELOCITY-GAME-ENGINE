import { Request, Response } from 'express';
import * as contractService from '../services/contract.service';
import { sendSuccess, sendPaginated } from '../utils/response';

/**
 * Map frontend camelCase body to DB snake_case fields.
 * Coerce empty strings to null for nullable columns.
 */
function mapBodyToDb(body: Record<string, unknown>): Record<string, unknown> {
  const emptyToNull = (v: unknown) => (v === '' || v === undefined ? null : v);
  const result: Record<string, unknown> = {};

  if ('name' in body) result.contract_name = body.name;
  if ('description' in body) result.contract_description = emptyToNull(body.description);
  if ('externalId' in body) result.contract_external_id = emptyToNull(body.externalId);
  if ('commodityType' in body) result.contract_commodity_type = emptyToNull(body.commodityType);
  if ('vendor' in body) result.contract_vendor = emptyToNull(body.vendor);
  if ('effectiveDate' in body) result.contract_effective_date = emptyToNull(body.effectiveDate && String(body.effectiveDate) <= '9999-12-31' ? body.effectiveDate : null);
  if ('expirationDate' in body) result.contract_expiration_date = emptyToNull(body.expirationDate && String(body.expirationDate) <= '9999-12-31' ? body.expirationDate : null);
  if ('hierarchyType' in body) result.contract_hierarchy_type = emptyToNull(body.hierarchyType);
  if ('source' in body) result.contract_source = emptyToNull(body.source);
  if ('ministryCode' in body) result._ministryCode = body.ministryCode; // resolved to UUID in service

  return result;
}

// ─── Contracts ────────────────────────────────────────────────────────────────

export async function list(req: Request, res: Response): Promise<void> {
  const { page, limit, sort, order, search, ministry, vendor, commodityType, expiringBefore, expiringAfter } = req.query as Record<string, string>;
  const result = await contractService.list(
    { search, ministry, vendor, commodityType, expiringBefore, expiringAfter, sort, order },
    Number(page) || 1,
    Number(limit) || 20,
  );
  sendPaginated(res, result.data, result.pagination);
}

export async function getById(req: Request, res: Response): Promise<void> {
  const contract = await contractService.getById(req.params.id as string);
  sendSuccess(res, contract);
}

export async function create(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const dbData = mapBodyToDb(req.body);
  const contract = await contractService.create(dbData as any, userId, req.ip ?? undefined);
  sendSuccess(res, contract, 201);
}

export async function update(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const dbData = mapBodyToDb(req.body);
  const contract = await contractService.update(req.params.id as string, dbData as any, userId, req.ip ?? undefined);
  sendSuccess(res, contract);
}

export async function remove(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  await contractService.remove(req.params.id as string, userId, req.ip ?? undefined);
  res.status(204).end();
}
