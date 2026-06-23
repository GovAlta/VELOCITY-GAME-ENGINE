import { Response } from 'express';

/**
 * Per-audit SSE manager.
 * Unlike the velocity stream (broadcast), this is keyed by auditId so each
 * running deep audit gets its own set of SSE subscribers.
 */
class DeepAuditStreamManager {
  private audits: Map<string, Set<Response>> = new Map();

  addClient(auditId: string, res: Response): void {
    if (!this.audits.has(auditId)) this.audits.set(auditId, new Set());
    this.audits.get(auditId)!.add(res);
  }

  removeClient(auditId: string, res: Response): void {
    const clients = this.audits.get(auditId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) this.audits.delete(auditId);
    }
  }

  sendProgress(auditId: string, event: string, data: unknown): void {
    const clients = this.audits.get(auditId);
    if (!clients) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try {
        client.write(msg);
      } catch {
        clients.delete(client);
      }
    }
  }

  cleanup(auditId: string): void {
    const clients = this.audits.get(auditId);
    if (clients) {
      for (const c of clients) {
        try { c.end(); } catch { /* ignore */ }
      }
    }
    this.audits.delete(auditId);
  }
}

export const deepAuditStreamManager = new DeepAuditStreamManager();
