import { Request, Response } from 'express';
import * as auditService from '../services/audit.service';
import * as auditExportService from '../services/audit-export.service';
import { AppError } from '../utils/app-error';

/**
 * Load and validate the audit belongs to the project.
 */
async function loadAudit(projectId: string, auditId: string) {
  const audit = await auditService.getAudit(auditId);
  if (audit.fk_audit_project !== projectId) {
    throw AppError.notFound('Audit not found for this project');
  }
  return audit;
}

/**
 * Sanitize a string for use in Content-Disposition filenames.
 */
function safeFilename(title: string | undefined, ext: string): string {
  const base = (title || 'audit-report')
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '-')
    .substring(0, 80);
  return `${base}.${ext}`;
}

/**
 * GET /projects/:id/audits/:auditId/export/json
 */
export async function exportJson(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const auditId = req.params.auditId as string;
  const audit = await loadAudit(projectId, auditId);
  const json = auditExportService.exportAsJson(audit);
  const filename = safeFilename((audit as any).audit_title, 'json');

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(json);
}

/**
 * GET /projects/:id/audits/:auditId/export/md
 */
export async function exportMarkdown(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const auditId = req.params.auditId as string;
  const audit = await loadAudit(projectId, auditId);
  const md = auditExportService.exportAsMarkdown(audit);
  const filename = safeFilename((audit as any).audit_title, 'md');

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(md);
}

/**
 * GET /projects/:id/audits/:auditId/export/docx
 */
export async function exportDocx(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const auditId = req.params.auditId as string;
  const audit = await loadAudit(projectId, auditId);
  const buffer = await auditExportService.exportAsDocx(audit);
  const filename = safeFilename((audit as any).audit_title, 'docx');

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}
