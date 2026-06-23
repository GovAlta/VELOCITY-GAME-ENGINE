import * as contractModel from '../models/contract.model';
import { pool } from '../config/database';
import { logAuditEvent } from '../utils/audit-logger';
import { AppError } from '../utils/app-error';
import type {
  ContractRecord,
  ContractListItem,
  ContractFilters,
} from '../models/contract.model';

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
 * List contracts with filtering, sorting, and pagination.
 */
export async function list(
  filters: ContractFilters,
  page: number,
  limit: number
): Promise<PaginatedResult<ContractListItem>> {
  const [data, total] = await Promise.all([
    contractModel.findAll(filters, page, limit),
    contractModel.countAll(filters),
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
 * Get a single contract by ID.
 * Throws 404 if not found or soft-deleted.
 */
export async function getById(id: string): Promise<ContractListItem> {
  const contract = await contractModel.findById(id);

  if (!contract) {
    throw AppError.notFound('Contract not found');
  }

  return contract;
}

/**
 * Resolve a ministry code to its UUID.
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
    data.fk_contract_ministry = result.rows[0].pk_ministry;
    delete data._ministryCode;
  }
  if (data.fk_contract_ministry) {
    const exists = await contractModel.ministryExists(data.fk_contract_ministry as string);
    if (!exists) {
      throw AppError.badRequest('Ministry not found');
    }
  }
}

/**
 * Create a new contract.
 * Validates that the ministry exists (when provided) before inserting.
 */
export async function create(
  data: Partial<ContractRecord> & Record<string, unknown>,
  userId: string,
  ipAddress?: string
): Promise<ContractRecord> {
  await resolveMinistryCode(data as Record<string, unknown>);

  const contract = await contractModel.create(data, userId);

  await logAuditEvent({
    action: 'INSERT',
    tableName: 'contract',
    recordId: contract.pk_contract,
    userId,
    ipAddress,
    newData: { contract_name: contract.contract_name },
  });

  return contract;
}

/**
 * Update an existing contract.
 * Validates that the ministry exists (when changed) before updating.
 * Throws 404 if the contract is not found or already deleted.
 */
export async function update(
  id: string,
  data: Partial<ContractRecord> & Record<string, unknown>,
  userId: string,
  ipAddress?: string
): Promise<ContractRecord> {
  await resolveMinistryCode(data as Record<string, unknown>);

  // Fetch old record for audit diff
  const oldContract = await contractModel.findById(id);
  if (!oldContract) {
    throw AppError.notFound('Contract not found');
  }

  const updated = await contractModel.update(id, data, userId);

  if (!updated) {
    throw AppError.notFound('Contract not found');
  }

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'contract',
    recordId: id,
    userId,
    ipAddress,
    oldData: { contract_name: oldContract.contract_name, contract_vendor: oldContract.contract_vendor },
    newData: { contract_name: updated.contract_name, contract_vendor: updated.contract_vendor },
  });

  return updated;
}

/**
 * Soft-delete a contract.
 * Throws 404 if the contract is not found or already deleted.
 */
export async function remove(
  id: string,
  userId: string,
  ipAddress?: string
): Promise<void> {
  const deleted = await contractModel.remove(id, userId);

  if (!deleted) {
    throw AppError.notFound('Contract not found');
  }

  await logAuditEvent({
    action: 'DELETE',
    tableName: 'contract',
    recordId: id,
    userId,
    ipAddress,
    oldData: { contract_name: deleted.contract_name },
  });
}
