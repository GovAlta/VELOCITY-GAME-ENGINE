import { Request, Response } from 'express';
import * as auditService from '../services/audit.service';
import { sendSuccess, sendPaginated } from '../utils/response';
import { AppError } from '../utils/app-error';
import type { LlmProvider } from '../services/llm-analysis.service';

/**
 * GET /projects/:id/audits
 * List audits for a project with pagination.
 */
export async function listAudits(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const source = req.query.source as string | undefined;

  const result = await auditService.listAudits(projectId, page, limit, source);

  sendPaginated(res, result.data, result.pagination);
}

/**
 * GET /projects/:id/audits/:auditId
 * Get a single audit with full data.
 */
export async function getAudit(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const auditId = req.params.auditId as string;

  const audit = await auditService.getAudit(auditId);

  // Verify audit belongs to the project
  if (audit.fk_audit_project !== projectId) {
    throw AppError.notFound('Audit not found for this project');
  }

  sendSuccess(res, audit);
}

/**
 * POST /projects/:id/audits
 * Run a new audit for a project.
 */
export async function runAudit(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const { source, sourceUrl, moduleId, branch, maxCommits, since } = req.body;
  const userId = req.user?.id as string | undefined;

  if (source === 'git') {
    // Create a placeholder audit immediately with 'running' status
    const placeholder = await auditService.createAudit(
      projectId,
      {
        source: 'git',
        sourceUrl,
        moduleId,
        status: 'running',
        title: `Git Audit — ${sourceUrl?.split('/').slice(-2).join('/') || 'repo'} (running)`,
        auditData: { status: 'running', queuedAt: new Date().toISOString() },
      },
      userId
    );

    // Return immediately — extraction runs in background
    sendSuccess(res, placeholder, 201);

    // Run extraction asynchronously (fire and forget)
    auditService.runGitAuditAsync(placeholder.pk_project_audit, projectId, sourceUrl as string, userId, {
      branch, maxCommits, since, moduleId,
    }).catch((err: Error) => {
      // Log error but don't crash — the audit record will show 'failed' status
      const logger = require('../utils/logger').default;
      logger.error('Background git audit failed', { auditId: placeholder.pk_project_audit, error: err.message });
    });

    return;
  }

  // Manual or other sources — just create a basic audit record
  const audit = await auditService.createAudit(
    projectId,
    {
      source,
      sourceUrl,
      moduleId,
      auditData: { source, sourceUrl, createdAt: new Date().toISOString() },
    },
    userId
  );

  sendSuccess(res, audit, 201);
}

/**
 * POST /projects/:id/audits/:auditId/analyze
 * Run LLM analysis on an existing audit.
 */
export async function runLlmAnalysis(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const auditId = req.params.auditId as string;
  const { provider, prompt, model } = req.body;

  // Verify audit exists and belongs to the project
  const existing = await auditService.getAudit(auditId);
  if (existing.fk_audit_project !== projectId) {
    throw AppError.notFound('Audit not found for this project');
  }

  const audit = await auditService.runLlmAnalysis(auditId, provider as LlmProvider, prompt, model);

  sendSuccess(res, audit);
}

/**
 * DELETE /projects/:id/audits/:auditId
 * Delete own audit only.
 */
export async function deleteAudit(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const auditId = req.params.auditId as string;
  const userId = req.user?.id;

  const audit = await auditService.getAudit(auditId);

  if (audit.fk_audit_project !== projectId) {
    throw AppError.notFound('Audit not found for this project');
  }

  // Only allow deleting own audits
  if (audit.created_by !== userId) {
    throw AppError.forbidden('You can only delete audits you created');
  }

  await auditService.deleteAudit(auditId);
  res.status(204).end();
}

/**
 * GET /ai/providers
 * List available LLM providers and models.
 */
export async function getProviders(_req: Request, res: Response): Promise<void> {
  const { getAvailableProviders } = await import('../services/llm-analysis.service');
  sendSuccess(res, getAvailableProviders());
}
