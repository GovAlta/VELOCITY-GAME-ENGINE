import * as adminModel from '../models/admin.model';
import * as auditModel from '../models/audit.model';
import * as notificationService from './notification.service';
import { AppError } from '../utils/app-error';
import type { ResourceItemRecord, ResourceUpdateRecord, ServiceLocationRecord } from '../types/resource';
import type { FormDefinitionRecord, FormSubmissionRecord, FormSubmissionWithForm, SubmissionStatus } from '../types/form';

// ─── Dashboard Stats ───────────────────────────────────────

export interface DashboardStats {
  totalResourceCount: number;
  publishedResourceCount: number;
  serviceLocationCount: number;
  openAssistanceRequests: number;
  pendingSubmissions: number;
  resourcesOverTime: adminModel.TimeSeriesPoint[];
  submissionsOverTime: adminModel.TimeSeriesPoint[];
  recentSubmissions: FormSubmissionWithForm[];
}

export async function getDashboardStats(days: number = 30): Promise<DashboardStats> {
  const [
    totalResourceCount,
    publishedResourceCount,
    serviceLocationCount,
    openAssistanceRequests,
    pendingSubmissions,
    resourcesOverTime,
    submissionsOverTime,
    recentSubmissions,
  ] = await Promise.all([
    adminModel.getResourceCount(),
    adminModel.getPublishedResourceCount(),
    adminModel.getServiceLocationCount(),
    adminModel.getOpenAssistanceCount(),
    adminModel.getPendingSubmissionCount(),
    adminModel.getResourcesOverTime(days),
    adminModel.getSubmissionsOverTime(days),
    adminModel.getRecentSubmissions(5),
  ]);

  return {
    totalResourceCount,
    publishedResourceCount,
    serviceLocationCount,
    openAssistanceRequests,
    pendingSubmissions,
    resourcesOverTime,
    submissionsOverTime,
    recentSubmissions,
  };
}

// ─── Resource Management ───────────────────────────────────

export async function createResource(
  data: adminModel.CreateResourceData,
  userId: string,
  ipAddress: string | null
): Promise<ResourceItemRecord> {
  data.created_by = userId;
  const resource = await adminModel.createResource(data);

  // Audit log
  await auditModel.createAuditEntry(
    'resource_item',
    resource.pk_resource_item,
    'INSERT',
    null,
    resource as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return resource;
}

export async function updateResource(
  id: string,
  data: adminModel.UpdateResourceData,
  userId: string,
  ipAddress: string | null
): Promise<ResourceItemRecord> {
  const existing = await adminModel.findResourceById(id);
  if (!existing) {
    throw AppError.notFound('Resource not found');
  }

  data.updated_by = userId;

  const updated = await adminModel.updateResource(id, data);
  if (!updated) {
    throw AppError.notFound('Resource not found');
  }

  // Audit log
  await auditModel.createAuditEntry(
    'resource_item',
    id,
    'UPDATE',
    existing as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return updated;
}

export async function addResourceUpdate(
  resourceId: string,
  data: adminModel.CreateResourceUpdateData,
  userId: string,
  ipAddress: string | null
): Promise<ResourceUpdateRecord> {
  // Verify resource exists
  const resource = await adminModel.findResourceById(resourceId);
  if (!resource) {
    throw AppError.notFound('Resource not found');
  }

  data.created_by = userId;
  const update = await adminModel.createResourceUpdate(resourceId, data);

  // Audit log
  await auditModel.createAuditEntry(
    'resource_update',
    update.pk_resource_update,
    'INSERT',
    null,
    update as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return update;
}

// ─── Service Location Management ───────────────────────────

export async function createServiceLocation(
  data: adminModel.CreateServiceLocationData,
  userId: string,
  ipAddress: string | null
): Promise<ServiceLocationRecord> {
  data.created_by = userId;
  const location = await adminModel.createServiceLocation(data);

  // Audit log
  await auditModel.createAuditEntry(
    'service_location',
    location.pk_service_location,
    'INSERT',
    null,
    location as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return location;
}

export async function updateServiceLocation(
  id: string,
  data: adminModel.UpdateServiceLocationData,
  userId: string,
  ipAddress: string | null
): Promise<ServiceLocationRecord> {
  const existing = await adminModel.findServiceLocationById(id);
  if (!existing) {
    throw AppError.notFound('Service location not found');
  }

  data.updated_by = userId;

  const updated = await adminModel.updateServiceLocation(id, data);
  if (!updated) {
    throw AppError.notFound('Service location not found');
  }

  // Audit log
  await auditModel.createAuditEntry(
    'service_location',
    id,
    'UPDATE',
    existing as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return updated;
}

// ─── Form Management ───────────────────────────────────────

export async function listAllForms(): Promise<FormDefinitionRecord[]> {
  return adminModel.findAllForms();
}

// ─── Service Catalogue Management ─────────────────────────

export async function listAllServices(): Promise<any[]> {
  return adminModel.findAllServices();
}

export async function listServiceCategories(): Promise<any[]> {
  return adminModel.findAllServiceCategories();
}

export async function createServiceCatalogue(
  data: adminModel.CreateServiceCatalogueData,
  userId: string,
  ipAddress: string | null
): Promise<any> {
  data.created_by = userId;
  const service = await adminModel.createServiceCatalogue(data);

  await auditModel.createAuditEntry(
    'service_catalogue',
    service.pk_service_catalogue,
    'INSERT',
    null,
    { title: data.service_title, category: data.fk_service_catalogue_service_category },
    userId,
    ipAddress
  );

  return service;
}

export async function updateServiceCatalogue(
  id: string,
  data: adminModel.UpdateServiceCatalogueData,
  userId: string,
  ipAddress: string | null
): Promise<any> {
  const existing = await adminModel.findServiceById(id);
  if (!existing) {
    throw AppError.notFound('Service not found');
  }

  const updated = await adminModel.updateServiceCatalogue(id, data);
  if (!updated) {
    throw AppError.notFound('Service not found');
  }

  await auditModel.createAuditEntry(
    'service_catalogue',
    id,
    'UPDATE',
    { title: existing.service_title },
    data as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return updated;
}

export async function listAllBroadcasts(): Promise<any[]> {
  return adminModel.findAllBroadcasts();
}

export async function createForm(
  data: adminModel.CreateFormDefinitionData,
  userId: string,
  ipAddress: string | null
): Promise<FormDefinitionRecord> {
  data.created_by = userId;
  const form = await adminModel.createFormDefinition(data);

  // Audit log
  await auditModel.createAuditEntry(
    'form_definition',
    form.pk_form_definition,
    'INSERT',
    null,
    form as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return form;
}

export async function updateForm(
  id: string,
  data: adminModel.UpdateFormDefinitionData,
  userId: string,
  ipAddress: string | null
): Promise<FormDefinitionRecord> {
  const existing = await adminModel.findFormById(id);
  if (!existing) {
    throw AppError.notFound('Form definition not found');
  }

  data.updated_by = userId;
  const updated = await adminModel.updateFormDefinition(id, data);
  if (!updated) {
    throw AppError.notFound('Form definition not found');
  }

  // Audit log
  await auditModel.createAuditEntry(
    'form_definition',
    id,
    'UPDATE',
    existing as unknown as Record<string, unknown>,
    updated as unknown as Record<string, unknown>,
    userId,
    ipAddress
  );

  return updated;
}

// ─── Submission Processing ─────────────────────────────────

/**
 * Valid status transitions:
 *   submitted -> in-review
 *   in-review -> approved | rejected
 *   approved -> completed
 *   rejected -> in-review (allow re-review)
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
  submitted: ['in-review'],
  'in-review': ['approved', 'rejected'],
  approved: ['completed'],
  rejected: ['in-review'],
};

export async function listAllSubmissions(
  filters: adminModel.AdminSubmissionFilters,
  page: number,
  limit: number
): Promise<{
  data: FormSubmissionWithForm[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const [data, total] = await Promise.all([
    adminModel.findAllSubmissions(filters, page, limit),
    adminModel.countAllSubmissions(filters),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    data,
    pagination: { page, limit, total, totalPages },
  };
}

export async function updateSubmissionStatus(
  id: string,
  newStatus: SubmissionStatus,
  userId: string,
  ipAddress: string | null
): Promise<FormSubmissionRecord> {
  const existing = await adminModel.findSubmissionById(id);
  if (!existing) {
    throw AppError.notFound('Submission not found');
  }

  // Validate status transition
  const currentStatus = existing.submission_status;
  const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowedTransitions.includes(newStatus)) {
    throw new AppError(
      `Invalid status transition: ${currentStatus} -> ${newStatus}. Allowed: ${allowedTransitions.join(', ') || 'none'}`,
      422,
      'INVALID_STATUS_TRANSITION'
    );
  }

  const updated = await adminModel.updateSubmissionStatus(id, newStatus, userId);
  if (!updated) {
    throw AppError.notFound('Submission not found');
  }

  // Audit log
  await auditModel.createAuditEntry(
    'form_submission',
    id,
    'UPDATE',
    { submission_status: currentStatus },
    { submission_status: newStatus },
    userId,
    ipAddress
  );

  return updated;
}

// ─── Broadcast ─────────────────────────────────────────────

export async function broadcastNotification(
  title: string,
  body: string,
  type: string,
  regionFilter: string | null,
  userId: string,
  ipAddress: string | null
): Promise<{ messageId: string; deliveryCount: number }> {
  const result = await notificationService.broadcast(
    title,
    body,
    type as any,
    regionFilter,
    null,
    userId
  );

  // Audit log
  await auditModel.createAuditEntry(
    'notification_message',
    result.messageId,
    'INSERT',
    null,
    { title, body, type, regionFilter, deliveryCount: result.deliveryCount },
    userId,
    ipAddress
  );

  return result;
}
