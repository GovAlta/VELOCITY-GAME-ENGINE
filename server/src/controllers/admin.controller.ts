import { Request, Response } from 'express';
import * as adminService from '../services/admin.service';
import { sendSuccess, sendPaginated } from '../utils/response';
import { velocityStreamManager } from '../sse/velocity-stream';

/**
 * GET /api/admin/dashboard/stats
 * Returns dashboard statistics and time-series chart data.
 */
export async function getDashboardStats(req: Request, res: Response): Promise<void> {
  const days = parseInt(req.query.days as string, 10) || 30;
  const stats = await adminService.getDashboardStats(days);
  sendSuccess(res, stats);
}

/**
 * POST /api/admin/resources
 * Creates a new resource item.
 */
export async function createResource(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const resource = await adminService.createResource(req.body, userId, ipAddress);
  sendSuccess(res, resource, 201);
}

/**
 * PUT /api/admin/resources/:id
 * Updates an existing resource item.
 */
export async function updateResource(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const id = req.params.id as string;
  const resource = await adminService.updateResource(id, req.body, userId, ipAddress);
  sendSuccess(res, resource);
}

/**
 * POST /api/admin/resources/:id/updates
 * Adds an update entry to a resource.
 */
export async function addResourceUpdate(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const resourceId = req.params.id as string;
  const update = await adminService.addResourceUpdate(resourceId, req.body, userId, ipAddress);
  sendSuccess(res, update, 201);
}

/**
 * POST /api/admin/service-locations
 * Creates a new service location.
 */
export async function createServiceLocation(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const location = await adminService.createServiceLocation(req.body, userId, ipAddress);
  sendSuccess(res, location, 201);
}

/**
 * PUT /api/admin/service-locations/:id
 * Updates an existing service location.
 */
export async function updateServiceLocation(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const id = req.params.id as string;
  const location = await adminService.updateServiceLocation(id, req.body, userId, ipAddress);
  sendSuccess(res, location);
}

/**
 * GET /api/admin/forms
 * Lists all form definitions (including unpublished).
 */
export async function listForms(_req: Request, res: Response): Promise<void> {
  const forms = await adminService.listAllForms();
  sendSuccess(res, forms);
}

/**
 * POST /api/admin/forms
 * Creates a new form definition.
 */
export async function createForm(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const form = await adminService.createForm(req.body, userId, ipAddress);
  sendSuccess(res, form, 201);
}

/**
 * PUT /api/admin/forms/:id
 * Updates an existing form definition.
 */
export async function updateForm(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const id = req.params.id as string;
  const form = await adminService.updateForm(id, req.body, userId, ipAddress);
  sendSuccess(res, form);
}

/**
 * GET /api/admin/services
 * Lists all services including unpublished.
 */
export async function listServices(_req: Request, res: Response): Promise<void> {
  const services = await adminService.listAllServices();
  sendSuccess(res, services);
}

/**
 * GET /api/admin/service-categories
 * Lists all service categories.
 */
export async function listServiceCategories(_req: Request, res: Response): Promise<void> {
  const categories = await adminService.listServiceCategories();
  sendSuccess(res, categories);
}

/**
 * POST /api/admin/services
 * Creates a new service catalogue entry.
 */
export async function createService(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const service = await adminService.createServiceCatalogue(req.body, userId, ipAddress);
  sendSuccess(res, service, 201);
}

/**
 * PUT /api/admin/services/:id
 * Updates an existing service catalogue entry.
 */
export async function updateService(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const id = req.params.id as string;
  const service = await adminService.updateServiceCatalogue(id, req.body, userId, ipAddress);
  sendSuccess(res, service);
}

/**
 * GET /api/admin/notifications
 * Lists all broadcast notification messages.
 */
export async function listBroadcasts(_req: Request, res: Response): Promise<void> {
  const broadcasts = await adminService.listAllBroadcasts();
  sendSuccess(res, broadcasts);
}

/**
 * GET /api/admin/submissions
 * Lists all submissions with filters and pagination.
 */
export async function listAllSubmissions(req: Request, res: Response): Promise<void> {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 20;
  const filters = {
    formId: req.query.formId as string | undefined,
    status: req.query.status as string | undefined,
    startDate: req.query.startDate as string | undefined,
    endDate: req.query.endDate as string | undefined,
  };

  const result = await adminService.listAllSubmissions(filters, page, limit);
  sendPaginated(res, result.data, result.pagination);
}

/**
 * PUT /api/admin/submissions/:id/status
 * Updates a submission's status.
 */
export async function updateSubmissionStatus(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const id = req.params.id as string;
  const submission = await adminService.updateSubmissionStatus(
    id,
    req.body.status,
    userId,
    ipAddress
  );
  sendSuccess(res, submission);
}

/**
 * POST /api/admin/notifications/broadcast
 * Broadcasts a notification to subscribers.
 */
export async function broadcastNotification(req: Request, res: Response): Promise<void> {
  const userId = req.user!.id;
  const ipAddress = (req.ip as string) || null;
  const result = await adminService.broadcastNotification(
    req.body.title,
    req.body.body,
    req.body.type,
    req.body.regionFilter || null,
    userId,
    ipAddress
  );
  sendSuccess(res, result, 201);
}

/**
 * GET /api/admin/sse-sessions
 * Snapshot of every currently-connected Velocity SSE client, grouped by
 * api_key, user, and IP. Sorted descending by count so a runaway caller
 * is at the top of every group. In-memory only — reflects this Node
 * process's view (relevant if App Service is multi-instance).
 */
export async function getSseSessions(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, velocityStreamManager.snapshot());
}
