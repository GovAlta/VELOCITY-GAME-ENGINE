import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import * as adminController from '../controllers/admin.controller';
import {
  dashboardStatsQuerySchema,
  createResourceSchema,
  updateResourceSchema,
  createResourceUpdateSchema,
  createServiceLocationSchema,
  updateServiceLocationSchema,
  createFormSchema,
  updateFormSchema,
  adminSubmissionsQuerySchema,
  updateSubmissionStatusSchema,
  createServiceCatalogueSchema,
  updateServiceCatalogueSchema,
  broadcastNotificationSchema,
} from '../validators/admin.validator';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate, authorize('admin'));

// Dashboard
router.get(
  '/dashboard/stats',
  validate(dashboardStatsQuerySchema),
  asyncHandler(adminController.getDashboardStats)
);

// Resource management
router.post(
  '/resources',
  csrf,
  validate(createResourceSchema),
  asyncHandler(adminController.createResource)
);

router.put(
  '/resources/:id',
  csrf,
  validate(updateResourceSchema),
  asyncHandler(adminController.updateResource)
);

router.post(
  '/resources/:id/updates',
  csrf,
  validate(createResourceUpdateSchema),
  asyncHandler(adminController.addResourceUpdate)
);

// Service location management
router.post(
  '/service-locations',
  csrf,
  validate(createServiceLocationSchema),
  asyncHandler(adminController.createServiceLocation)
);

router.put(
  '/service-locations/:id',
  csrf,
  validate(updateServiceLocationSchema),
  asyncHandler(adminController.updateServiceLocation)
);

// Service catalogue management
router.get(
  '/services',
  asyncHandler(adminController.listServices)
);

router.get(
  '/service-categories',
  asyncHandler(adminController.listServiceCategories)
);

router.post(
  '/services',
  csrf,
  validate(createServiceCatalogueSchema),
  asyncHandler(adminController.createService)
);

router.put(
  '/services/:id',
  csrf,
  validate(updateServiceCatalogueSchema),
  asyncHandler(adminController.updateService)
);

// Form management
router.get(
  '/forms',
  asyncHandler(adminController.listForms)
);

router.post(
  '/forms',
  csrf,
  validate(createFormSchema),
  asyncHandler(adminController.createForm)
);

router.put(
  '/forms/:id',
  csrf,
  validate(updateFormSchema),
  asyncHandler(adminController.updateForm)
);

// Submission management
router.get(
  '/submissions',
  validate(adminSubmissionsQuerySchema),
  asyncHandler(adminController.listAllSubmissions)
);

router.put(
  '/submissions/:id/status',
  csrf,
  validate(updateSubmissionStatusSchema),
  asyncHandler(adminController.updateSubmissionStatus)
);

// Notification management
router.get(
  '/notifications',
  asyncHandler(adminController.listBroadcasts)
);

router.post(
  '/notifications/broadcast',
  csrf,
  validate(broadcastNotificationSchema),
  asyncHandler(adminController.broadcastNotification)
);

/**
 * GET /api/admin/sse-sessions
 * Live snapshot of Velocity SSE sessions, grouped by api_key / user / IP.
 * Read-only. Admin-only (the router.use above enforces it).
 */
router.get(
  '/sse-sessions',
  asyncHandler(adminController.getSseSessions)
);

export default router;
