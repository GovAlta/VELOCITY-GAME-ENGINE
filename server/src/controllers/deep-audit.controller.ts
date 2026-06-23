import { Request, Response } from 'express';
import * as auditService from '../services/audit.service';
import * as deepAuditService from '../services/deep-audit.service';
import { sendSuccess } from '../utils/response';
import { deepAuditStreamManager } from '../sse/deep-audit-stream';
import logger from '../utils/logger';

/**
 * POST /projects/:id/deep-audit
 * Launch a deep audit — creates a placeholder row, returns immediately,
 * then runs the multi-phase analysis in the background.
 */
export async function runDeepAudit(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const { sourceUrl, branch, maxFiles, maxContentKB, provider, model } = req.body;
  const userId = req.user?.id;

  // Create placeholder audit record with 'running' status
  const placeholder = await auditService.createAudit(
    projectId,
    {
      source: 'deep-audit',
      sourceUrl,
      status: 'running',
      title: `Deep Audit — ${sourceUrl?.split('/').slice(-2).join('/') || 'repo'} (running)`,
      auditData: { status: 'running', queuedAt: new Date().toISOString() },
    },
    userId
  );

  sendSuccess(res, placeholder, 201);

  // Fire and forget — the service updates the DB row when done
  deepAuditService.runDeepAuditAsync(
    placeholder.pk_project_audit,
    projectId,
    sourceUrl,
    userId,
    { branch, maxFiles, maxContentKB, provider, model }
  ).catch(err => {
    logger.error('Deep audit background error', {
      auditId: placeholder.pk_project_audit,
      error: err.message,
    });
  });
}

/**
 * GET /projects/:id/deep-audit/:auditId/stream
 * SSE stream for real-time deep audit progress.
 */
export async function streamDeepAudit(req: Request, res: Response): Promise<void> {
  const auditId = req.params.auditId as string;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ auditId })}\n\n`);
  deepAuditStreamManager.addClient(auditId, res);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    deepAuditStreamManager.removeClient(auditId, res);
    clearInterval(heartbeat);
  });
}

/**
 * GET /projects/:id/deep-audit/:auditId/status
 * Poll-based status check (for clients that don't use SSE).
 */
export async function getDeepAuditStatus(req: Request, res: Response): Promise<void> {
  const auditId = req.params.auditId as string;
  // getAudit does SELECT * so all columns are present; the AuditRecord interface
  // is incomplete (missing audit_status) so we cast through unknown.
  const audit = (await auditService.getAudit(auditId)) as unknown as Record<string, unknown>;
  sendSuccess(res, {
    status: audit.audit_status,
    progress: audit.audit_data,
  });
}
