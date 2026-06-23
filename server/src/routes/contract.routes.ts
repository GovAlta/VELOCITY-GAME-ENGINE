import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import * as contractController from '../controllers/contract.controller';
import {
  listContractsSchema,
  contractIdSchema,
  createContractSchema,
  updateContractSchema,
} from '../validators/contract.validator';

const router = Router();

// All contract routes require project_lead or admin role
router.use(authenticate, authorize('project_lead'));

// ─── Contracts ──────────────────────────────────────

/**
 * GET /api/contracts
 * Public — list contracts with pagination, filtering, sorting.
 */
router.get(
  '/',
  validate({ query: listContractsSchema }),
  asyncHandler(contractController.list)
);

/**
 * GET /api/contracts/:id
 * Public — get contract detail by ID.
 */
router.get(
  '/:id',
  validate({ params: contractIdSchema }),
  asyncHandler(contractController.getById)
);

/**
 * POST /api/contracts
 * Authenticated — create a new contract.
 */
router.post(
  '/',
  authenticate,
  csrf,
  validate({ body: createContractSchema }),
  asyncHandler(contractController.create)
);

/**
 * PUT /api/contracts/:id
 * Authenticated — update an existing contract.
 */
router.put(
  '/:id',
  authenticate,
  csrf,
  validate({ params: contractIdSchema, body: updateContractSchema }),
  asyncHandler(contractController.update)
);

/**
 * DELETE /api/contracts/:id
 * Authenticated — soft-delete a contract.
 */
router.delete(
  '/:id',
  authenticate,
  csrf,
  validate({ params: contractIdSchema }),
  asyncHandler(contractController.remove)
);

export default router;
