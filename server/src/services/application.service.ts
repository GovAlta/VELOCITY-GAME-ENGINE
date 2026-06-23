import * as applicationModel from '../models/application.model';
import { pool } from '../config/database';
import { logAuditEvent } from '../utils/audit-logger';
import { AppError } from '../utils/app-error';
import type {
  ApplicationRecord,
  ApplicationListItem,
  ApplicationFilters,
} from '../models/application.model';

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
 * List applications with filtering, sorting, and pagination.
 */
export async function list(
  filters: ApplicationFilters,
  page: number,
  limit: number
): Promise<PaginatedResult<ApplicationListItem>> {
  const [data, total] = await Promise.all([
    applicationModel.findAll(filters, page, limit),
    applicationModel.countAll(filters),
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
 * Get a single application by ID.
 * Throws 404 if not found or soft-deleted.
 */
export async function getById(id: string): Promise<ApplicationListItem> {
  const application = await applicationModel.findById(id);

  if (!application) {
    throw AppError.notFound('Application not found');
  }

  return application;
}

/**
 * Resolve a ministry code to a UUID and validate ministry existence.
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
    data.fk_application_ministry = result.rows[0].pk_ministry;
    delete data._ministryCode;
  }
  if (data.fk_application_ministry) {
    const exists = await applicationModel.ministryExists(data.fk_application_ministry as string);
    if (!exists) {
      throw AppError.badRequest('Ministry not found');
    }
  }
}

/**
 * Create a new application.
 * Validates that the ministry exists (when provided) before inserting.
 */
export async function create(
  data: Partial<ApplicationRecord> & Record<string, unknown>,
  userId: string,
  ipAddress?: string
): Promise<ApplicationRecord> {
  await resolveMinistryCode(data as Record<string, unknown>);

  const application = await applicationModel.create(data, userId);

  await logAuditEvent({
    action: 'INSERT',
    tableName: 'application',
    recordId: application.pk_application,
    userId,
    ipAddress,
    newData: { application_name: application.application_name },
  });

  return application;
}

/**
 * Update an existing application.
 * Validates that the ministry exists (when changed) before updating.
 * Throws 404 if the application is not found or already deleted.
 */
export async function update(
  id: string,
  data: Partial<ApplicationRecord> & Record<string, unknown>,
  userId: string,
  ipAddress?: string
): Promise<ApplicationRecord> {
  await resolveMinistryCode(data as Record<string, unknown>);

  // Fetch old record for audit diff
  const oldApplication = await applicationModel.findById(id);
  if (!oldApplication) {
    throw AppError.notFound('Application not found');
  }

  const updated = await applicationModel.update(id, data, userId);

  if (!updated) {
    throw AppError.notFound('Application not found');
  }

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'application',
    recordId: id,
    userId,
    ipAddress,
    oldData: { application_name: oldApplication.application_name, application_install_status: oldApplication.application_install_status },
    newData: { application_name: updated.application_name, application_install_status: updated.application_install_status },
  });

  return updated;
}

/**
 * Soft-delete an application.
 * Throws 404 if the application is not found or already deleted.
 */
export async function remove(
  id: string,
  userId: string,
  ipAddress?: string
): Promise<void> {
  const deleted = await applicationModel.remove(id, userId);

  if (!deleted) {
    throw AppError.notFound('Application not found');
  }

  await logAuditEvent({
    action: 'DELETE',
    tableName: 'application',
    recordId: id,
    userId,
    ipAddress,
    oldData: { application_name: deleted.application_name },
  });
}
