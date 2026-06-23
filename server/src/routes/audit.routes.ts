import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import * as auditController from '../controllers/audit.controller';
import * as auditExportController from '../controllers/audit-export.controller';
import {
  auditListQuerySchema,
  auditIdSchema,
  runAuditBodySchema,
  runLlmBodySchema,
  runDeepAuditBodySchema,
  deepAuditIdSchema,
} from '../validators/git.validator';
import * as deepAuditController from '../controllers/deep-audit.controller';
import { projectIdSchema } from '../validators/project.validator';

const router = Router();

// ─── Project Audits ──────────────────────────────────────

/**
 * GET /projects/:id/audits
 * Public — list audits for a project with pagination.
 */
router.get(
  '/:id/audits',
  authenticate,
  validate({ params: projectIdSchema, query: auditListQuerySchema }),
  asyncHandler(auditController.listAudits)
);

/**
 * GET /projects/:id/audits/:auditId/export/json
 * Public — export audit as JSON file download.
 */
router.get(
  '/:id/audits/:auditId/export/json',
  authenticate,
  validate({ params: auditIdSchema }),
  asyncHandler(auditExportController.exportJson)
);

/**
 * GET /projects/:id/audits/:auditId/export/md
 * Public — export audit as Markdown file download.
 */
router.get(
  '/:id/audits/:auditId/export/md',
  authenticate,
  validate({ params: auditIdSchema }),
  asyncHandler(auditExportController.exportMarkdown)
);

/**
 * GET /projects/:id/audits/:auditId/export/docx
 * Public — export audit as DOCX file download.
 */
router.get(
  '/:id/audits/:auditId/export/docx',
  authenticate,
  validate({ params: auditIdSchema }),
  asyncHandler(auditExportController.exportDocx)
);

/**
 * GET /projects/:id/audits/:auditId
 * Public — get a single audit with full data.
 */
router.get(
  '/:id/audits/:auditId',
  authenticate,
  validate({ params: auditIdSchema }),
  asyncHandler(auditController.getAudit)
);

/**
 * POST /projects/:id/audits
 * Authenticated + CSRF — run a new audit for a project.
 */
router.post(
  '/:id/audits',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: projectIdSchema, body: runAuditBodySchema }),
  asyncHandler(auditController.runAudit)
);

/**
 * POST /projects/:id/audits/:auditId/analyze
 * Authenticated + project_lead — run LLM analysis on an existing audit.
 */
router.post(
  '/:id/audits/:auditId/analyze',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: auditIdSchema, body: runLlmBodySchema }),
  asyncHandler(auditController.runLlmAnalysis)
);

/**
 * DELETE /projects/:id/audits/:auditId
 * Authenticated + project_lead — delete audit (soft delete).
 */
router.delete(
  '/:id/audits/:auditId',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: auditIdSchema }),
  asyncHandler(auditController.deleteAudit)
);

// ─── Deep Audit ─────────────────────────────────────────

/**
 * POST /projects/:id/deep-audit
 * Authenticated + project_lead — launch a deep production-readiness audit.
 */
router.post(
  '/:id/deep-audit',
  authenticate,
  authorize('runner'),
  csrf,
  validate({ params: projectIdSchema, body: runDeepAuditBodySchema }),
  asyncHandler(deepAuditController.runDeepAudit)
);

/**
 * GET /projects/:id/deep-audit/:auditId/stream
 * SSE stream — real-time progress updates for a running deep audit.
 */
router.get(
  '/:id/deep-audit/:auditId/stream',
  authenticate,
  asyncHandler(deepAuditController.streamDeepAudit)
);

/**
 * GET /projects/:id/deep-audit/:auditId/status
 * Poll-based status check for a deep audit.
 */
router.get(
  '/:id/deep-audit/:auditId/status',
  authenticate,
  validate({ params: deepAuditIdSchema }),
  asyncHandler(deepAuditController.getDeepAuditStatus)
);

export default router;
