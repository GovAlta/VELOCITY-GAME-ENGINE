import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import * as gitController from '../controllers/git.controller';
import {
  extractBodySchema,
  repoParamsSchema,
  commitBodySchema,
  prBodySchema,
  branchBodySchema,
} from '../validators/git.validator';

const router = Router();

// ─── Extraction ──────────────────────────────────────

/**
 * POST /git/repos
 * Authenticated — create a new GitHub repository.
 */
router.post(
  '/repos',
  authenticate,
  authorize('runner'),
  csrf,
  asyncHandler(gitController.createRepo)
);

/**
 * POST /git/extract
 * Authenticated — run a full Git extraction for a repository.
 */
router.post(
  '/extract',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ body: extractBodySchema }),
  asyncHandler(gitController.extract)
);

// ─── Repository Analytics ──────────────────────────────────────

/**
 * GET /git/repos/:owner/:repo/analytics
 * Public — get analytics summary for a repository.
 */
router.get(
  '/repos/:owner/:repo/analytics',
  authenticate,
  validate({ params: repoParamsSchema }),
  asyncHandler(gitController.getAnalytics)
);

// ─── File Operations ──────────────────────────────────────

/**
 * GET /git/repos/:owner/:repo/files
 * Authenticated — list files in a repository directory.
 */
router.get(
  '/repos/:owner/:repo/files',
  authenticate,
  validate({ params: repoParamsSchema }),
  asyncHandler(gitController.listFiles)
);

/**
 * GET /git/repos/:owner/:repo/files/*
 * Authenticated — get content of a specific file.
 */
router.get(
  '/repos/:owner/:repo/files/*',
  authenticate,
  validate({ params: repoParamsSchema }),
  asyncHandler(gitController.getFile)
);

// ─── Write Operations ──────────────────────────────────────

/**
 * POST /git/repos/:owner/:repo/commits/batch
 * Authenticated + CSRF — push multiple files in a single commit (Git Trees API).
 * PREFERRED for multi-file pushes (project scaffolds, bulk changes).
 */
router.post(
  '/repos/:owner/:repo/commits/batch',
  authenticate,
  authorize('runner'),
  csrf,
  asyncHandler(gitController.batchCommit)
);

/**
 * POST /git/repos/:owner/:repo/commits
 * Authenticated + CSRF — create or update a single file.
 */
router.post(
  '/repos/:owner/:repo/commits',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: repoParamsSchema, body: commitBodySchema }),
  asyncHandler(gitController.commitFile)
);

/**
 * POST /git/repos/:owner/:repo/pulls
 * Authenticated + CSRF — create a pull request.
 */
router.post(
  '/repos/:owner/:repo/pulls',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: repoParamsSchema, body: prBodySchema }),
  asyncHandler(gitController.createPR)
);

/**
 * POST /git/repos/:owner/:repo/branches
 * Authenticated + CSRF — create a new branch.
 */
router.post(
  '/repos/:owner/:repo/branches',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: repoParamsSchema, body: branchBodySchema }),
  asyncHandler(gitController.createBranch)
);

export default router;
