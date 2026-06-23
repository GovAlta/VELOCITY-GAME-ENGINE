import { Router } from 'express';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import { ministryCodeSchema } from '../validators/project.validator';
import * as ministryController from '../controllers/ministry.controller';

const router = Router();

/**
 * GET /api/ministries
 * Public — list all ministries with project counts.
 */
router.get(
  '/',
  asyncHandler(ministryController.list)
);

/**
 * GET /api/ministries/:code
 * Public — get a ministry by code with all its projects.
 */
router.get(
  '/:code',
  validate({ params: ministryCodeSchema }),
  asyncHandler(ministryController.getByCode)
);

export default router;
