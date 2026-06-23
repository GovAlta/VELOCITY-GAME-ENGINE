import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { ifMatchVelocityStep } from '../middleware/if-match';
import { idempotency } from '../middleware/idempotency';
import { velocityWriteGate } from '../middleware/velocity-write-gate';
import { asyncHandler } from '../utils/async-handler';
import * as velocityController from '../controllers/velocity.controller';
import {
  projectIdParam,
  moduleIdParam,
  moduleStepParam,
  makeMoveBody,
  addNoteBody,
  sendBackBody,
  toggleLockBody,
  paginationQuery,
} from '../validators/velocity.validator';

const router = Router();

// ---------------------------------------------------------------------------
// SSE Stream
// ---------------------------------------------------------------------------

/**
 * GET /api/velocity/stream
 * Public — SSE stream for real-time multiplayer board synchronization.
 */
router.get('/stream', asyncHandler(velocityController.stream));

/**
 * GET /api/velocity/guide
 * Public — download gameplay guide + API spec as .md file.
 */
router.get('/guide', asyncHandler(velocityController.downloadGuide));

/**
 * GET /api/velocity/claude-md
 * Public — download CLAUDE.md AI agent instructions.
 */
router.get('/claude-md', asyncHandler(velocityController.downloadClaudeMd));

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * GET /api/velocity
 * Public — velocity dashboard across all projects/modules.
 */
router.get(
  '/',
  asyncHandler(velocityController.dashboard)
);

// ---------------------------------------------------------------------------
// Project-level
// ---------------------------------------------------------------------------

/**
 * GET /api/velocity/projects/:projectId
 * Public — all velocity steps for a project, grouped by module.
 */
router.get(
  '/projects/:projectId',
  validate({ params: projectIdParam }),
  asyncHandler(velocityController.getProjectVelocity)
);

// ---------------------------------------------------------------------------
// Module-level
// ---------------------------------------------------------------------------

/**
 * GET /api/velocity/modules/:moduleId
 * Public — the 8 velocity steps for a module.
 */
router.get(
  '/modules/:moduleId',
  validate({ params: moduleIdParam }),
  asyncHandler(velocityController.getModuleSteps)
);

/**
 * PUT /api/velocity/modules/:moduleId/steps/:stepName
 * Authenticated — make a move (state transition) on a step.
 */
router.put(
  '/modules/:moduleId/steps/:stepName',
  authenticate,
  authorize('runner'),
  velocityWriteGate,
  ifMatchVelocityStep,
  idempotency,
  csrf,
  validate({ params: moduleStepParam, body: makeMoveBody }),
  asyncHandler(velocityController.makeMove)
);

/**
 * POST /api/velocity/modules/:moduleId/steps/:stepName/turns
 * Authenticated — add a note to a step.
 */
router.post(
  '/modules/:moduleId/steps/:stepName/turns',
  authenticate,
  authorize('runner'),
  velocityWriteGate,
  ifMatchVelocityStep,
  idempotency,
  csrf,
  validate({ params: moduleStepParam, body: addNoteBody }),
  asyncHandler(velocityController.addNote)
);

/**
 * GET /api/velocity/modules/:moduleId/steps/:stepName/turns
 * Public — paginated turns for a step.
 */
router.get(
  '/modules/:moduleId/steps/:stepName/turns',
  validate({ params: moduleStepParam, query: paginationQuery }),
  asyncHandler(velocityController.getStepTurns)
);

/**
 * GET /api/velocity/modules/:moduleId/turns
 * Public — paginated turns for all steps of a module.
 */
router.get(
  '/modules/:moduleId/turns',
  validate({ params: moduleIdParam, query: paginationQuery }),
  asyncHandler(velocityController.getModuleTurns)
);

/**
 * PUT /api/velocity/modules/:moduleId/steps/:stepName/lock
 * Authenticated — lock or unlock a step.
 */
router.put(
  '/modules/:moduleId/steps/:stepName/lock',
  authenticate,
  authorize('runner'),
  velocityWriteGate,
  ifMatchVelocityStep,
  idempotency,
  csrf,
  validate({ params: moduleStepParam, body: toggleLockBody }),
  asyncHandler(velocityController.toggleLock)
);

/**
 * POST /api/velocity/modules/:moduleId/send-back
 * Authenticated — send module back to an earlier step.
 */
router.post(
  '/modules/:moduleId/send-back',
  authenticate,
  authorize('runner'),
  velocityWriteGate,
  idempotency,
  csrf,
  validate({ params: moduleIdParam, body: sendBackBody }),
  asyncHandler(velocityController.sendBack)
);

export default router;
