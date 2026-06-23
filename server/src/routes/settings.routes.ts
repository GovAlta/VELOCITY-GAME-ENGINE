import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import * as gitController from '../controllers/git.controller';
import { savePatBodySchema } from '../validators/git.validator';

const router = Router();

// ─── PAT Management ──────────────────────────────────────

/**
 * PUT /settings/pat
 * Authenticated + CSRF — save a GitHub personal access token (encrypted).
 */
router.put(
  '/pat',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ body: savePatBodySchema }),
  asyncHandler(gitController.savePat)
);

/**
 * DELETE /settings/pat
 * Authenticated + CSRF — remove the stored GitHub PAT.
 */
router.delete(
  '/pat',
  authenticate,
  authorize('runner'),
  csrf,
  asyncHandler(gitController.deletePat)
);

/**
 * GET /settings/pat/status
 * Authenticated — check if a PAT is configured for the current user.
 */
router.get(
  '/pat/status',
  authenticate,
  asyncHandler(gitController.getPatStatus)
);

/**
 * PUT /settings/github-domain
 * Authenticated — save the GitHub domain independently.
 */
router.put(
  '/github-domain',
  authenticate,
  authorize('runner'),
  csrf,
  asyncHandler(gitController.saveDomain)
);

export default router;
