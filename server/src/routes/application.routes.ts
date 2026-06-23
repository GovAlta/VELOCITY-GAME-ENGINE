import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import * as applicationController from '../controllers/application.controller';
import {
  listApplicationsSchema,
  applicationIdSchema,
  createApplicationSchema,
  updateApplicationSchema,
} from '../validators/application.validator';

const router = Router();

// All application/CMDB routes require project_lead or admin role
router.use(authenticate, authorize('project_lead'));

// ─── Applications ──────────────────────────────────────

/**
 * GET /api/applications
 * Public — list applications with pagination, filtering, sorting.
 */
router.get(
  '/',
  validate({ query: listApplicationsSchema }),
  asyncHandler(applicationController.list)
);

/**
 * GET /api/applications/:id
 * Public — get application detail by ID.
 */
router.get(
  '/:id',
  validate({ params: applicationIdSchema }),
  asyncHandler(applicationController.getById)
);

/**
 * POST /api/applications
 * Authenticated — create a new application.
 */
router.post(
  '/',
  authenticate,
  csrf,
  validate({ body: createApplicationSchema }),
  asyncHandler(applicationController.create)
);

/**
 * PUT /api/applications/:id
 * Authenticated — update an existing application.
 */
router.put(
  '/:id',
  authenticate,
  csrf,
  validate({ params: applicationIdSchema, body: updateApplicationSchema }),
  asyncHandler(applicationController.update)
);

/**
 * DELETE /api/applications/:id
 * Authenticated — soft-delete an application.
 */
router.delete(
  '/:id',
  authenticate,
  csrf,
  validate({ params: applicationIdSchema }),
  asyncHandler(applicationController.remove)
);

export default router;
