import { Response } from 'express';
import logger from '../utils/logger';

/**
 * Per-audit SSE stream manager for SharePoint content audits.
 * Follows the same pattern as deep-audit-stream.ts.
 */
class SharePointAuditStreamManager {
  private streams: Map<string, Set<Response>> = new Map();

  addClient(auditId: string, res: Response): void {
    if (!this.streams.has(auditId)) {
      this.streams.set(auditId, new Set());
    }
    this.streams.get(auditId)!.add(res);
    logger.info('SharePoint audit SSE client connected', { auditId });
  }

  removeClient(auditId: string, res: Response): void {
    const clients = this.streams.get(auditId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        this.streams.delete(auditId);
      }
    }
  }

  broadcast(auditId: string, event: string, data: unknown): void {
    const clients = this.streams.get(auditId);
    if (!clients) return;
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
      }
    }
  }

  close(auditId: string): void {
    const clients = this.streams.get(auditId);
    if (!clients) return;
    const message = `event: done\ndata: ${JSON.stringify({ auditId })}\n\n`;
    for (const client of clients) {
      try {
        client.write(message);
        client.end();
      } catch { /* ignore */ }
    }
    this.streams.delete(auditId);
  }
}

export const sharepointAuditStreamManager = new SharePointAuditStreamManager();
