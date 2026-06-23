import { Response } from 'express';
import logger from '../utils/logger';
import { memoryPressure, PressureState } from '../utils/memory-pressure';
import { env } from '../config/environment';
import { crossInstanceBus } from './cross-instance-bus';

/**
 * SSE broadcast manager for the Velocity board game.
 *
 * Three back-pressure layers live in this module — all designed to be
 * self-healing under load so the process stops accepting work before it
 * OOMs rather than crashing.
 *
 *   1. **Project-scoped subscriptions.** Clients may pass
 *      ?projects=<id>,<id> on connect to receive only events for those
 *      projects. Broadcast auto-detects `data.projectId` and skips
 *      uninterested clients. Reduces fan-out by 1-2 orders of magnitude
 *      for typical fleet listeners that watch a single project.
 *
 *   2. **Per-client write back-pressure with priority shedding.** Every
 *      write checks the return value. Slow clients accumulate a
 *      `lagScore`; once over a shed threshold their LOW-priority events
 *      (clients, sharepoint_ai_*) are dropped while HIGH-priority ones
 *      (move/note/send_back/lock) still flow. Persistent slowness =>
 *      force-close so the client reconnects without poisoning the rest.
 *
 *   3. **Memory-pressure response.** Subscribed to memoryPressure
 *      transitions. On AMBER+ a 'pressure' event is broadcast so
 *      well-behaved clients can back off voluntarily. On RED the oldest
 *      fraction of clients is evicted so the broadcast set shrinks.
 *
 * Each client carries diagnostic metadata (IP, user-agent, auth source,
 * project filter, lag score) so connect/disconnect logs and the periodic
 * summary can answer "who is driving these connections / who is lagging?"
 */

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
  userId?: string;
  userEmail?: string;
  apiKeyId?: string;
  authSource?: 'api_key' | 'jwt' | 'anonymous';
  connectedAt: number;
  /** Set of projectIds the client is interested in. Empty = subscribe to all. */
  projects: Set<string>;
  /** Per-client back-pressure counters. Reset on socket 'drain'. */
  lagScore: number;
  slowSince: number | null;
}

/**
 * Low-priority event types — eligible to be dropped for laggy clients.
 * Anything not listed here is treated as HIGH-priority and always written
 * (subject only to the kill threshold).
 */
const LOW_PRIORITY_EVENTS = new Set<string>([
  'clients',
  'sharepoint_ai_sub_progress',
  'sharepoint_ai_job_started',
  'sharepoint_ai_skipped',
  'pressure',
]);

class VelocityStreamManager {
  private clients: Map<Response, ClientMeta> = new Map();

  constructor() {
    // Self-wire memory-pressure listener. Done in the constructor so it
    // also fires when this module is imported for side effects from
    // server.ts. Idempotent — memoryPressure dedupes listeners.
    memoryPressure.onStateChange(({ from, to, sample }) => {
      this.onMemoryPressureTransition(from, to, sample.pct);
    });
    // Wire the cross-instance bus: when a peer instance NOTIFYs the
    // velocity_events channel, we receive it here and fan out locally
    // (without re-publishing, to avoid a NOTIFY echo storm).
    crossInstanceBus.registerLocalHandler((event, data) => {
      this.localBroadcast(event, data);
    });
  }

  /**
   * Register an SSE client connection.
   */
  addClient(res: Response, meta: Omit<ClientMeta, 'connectedAt' | 'lagScore' | 'slowSince' | 'projects'> & { projects?: Set<string> } = {}): void {
    const full: ClientMeta = {
      ...meta,
      projects: meta.projects ?? new Set<string>(),
      connectedAt: Date.now(),
      lagScore: 0,
      slowSince: null,
    };
    this.clients.set(res, full);

    // Reset lag score whenever the kernel drains the socket — confirms the
    // client is keeping up. Without this, a transient slow window would
    // permanently shed the client's low-priority events.
    res.on('drain', () => {
      const m = this.clients.get(res);
      if (m) { m.lagScore = 0; m.slowSince = null; }
    });

    logger.info('Velocity SSE client connected', {
      clientCount: this.clients.size,
      ip: full.ip,
      userAgent: full.userAgent,
      authSource: full.authSource,
      userId: full.userId,
      userEmail: full.userEmail,
      apiKeyId: full.apiKeyId,
      projectsFilter: full.projects.size > 0 ? [...full.projects] : 'all',
    });
    // `clients` is a LOCAL state event — each instance has its own
    // population. Skip the cross-instance NOTIFY for it; peers track their
    // own counts.
    this.localBroadcast('clients', { count: this.clients.size });
  }

  /**
   * Remove an SSE client connection (on disconnect).
   */
  removeClient(res: Response): void {
    const meta = this.clients.get(res);
    this.clients.delete(res);
    logger.info('Velocity SSE client disconnected', {
      clientCount: this.clients.size,
      ip: meta?.ip,
      authSource: meta?.authSource,
      userId: meta?.userId,
      apiKeyId: meta?.apiKeyId,
      durationMs: meta ? Date.now() - meta.connectedAt : undefined,
      finalLagScore: meta?.lagScore,
    });
    this.localBroadcast('clients', { count: this.clients.size });
  }

  /**
   * Broadcast an event to interested + healthy clients on THIS instance
   * AND on every peer instance via Postgres NOTIFY. Service-layer callers
   * use this; it's the public entry point.
   *
   * Cross-instance: the bus replays the event on every peer; their local
   * `localBroadcast` fans out to their own clients. The originating
   * instance suppresses the echo via originId in the wire message.
   */
  broadcast(event: string, data: unknown): void {
    // publish() invokes the registered local handler (= our localBroadcast)
    // synchronously, so the local fan-out happens immediately just like
    // before. Cross-instance fan-out is fire-and-forget.
    crossInstanceBus.publish(event, data);
  }

  /**
   * Local-only fan-out. Called by both the public broadcast() (via the
   * bus's local handler) AND by the bus when a NOTIFY arrives from a peer.
   *
   * Filtering: each client's `projects` filter is consulted against
   * `data.projectId` (and `data.parentId` as a fallback for clone/version
   * events). Empty filter = subscribe-to-all.
   *
   * Back-pressure: `res.write()`'s return value is honored. Slow clients
   * accumulate a lag score; over the shed threshold low-priority events
   * are dropped for them; over the kill threshold (or after a sustained
   * slow window) the connection is force-closed.
   *
   * Failed writes silently remove the dead client from the map.
   */
  private localBroadcast(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const candidates = pickProjectIdCandidates(data);
    const now = Date.now();
    const isLowPriority = LOW_PRIORITY_EVENTS.has(event);

    const toKill: Response[] = [];

    for (const [client, meta] of this.clients) {
      // ── Project filter ─────────────────────────────────────
      // A client with an empty filter receives everything. Otherwise the
      // event must mention at least one project in the client's filter.
      // We look at both data.projectId (the event's home project) AND
      // data.parentId (cluster parent for clone/version/challenge events),
      // because a WATCH_CLUSTERS listener subscribes to the parent and
      // still needs to hear about clone activity.
      if (candidates.length > 0 && meta.projects.size > 0) {
        let matches = false;
        for (const c of candidates) {
          if (meta.projects.has(c)) { matches = true; break; }
        }
        if (!matches) continue;
      }

      // ── Priority shedding for laggy clients ────────────────
      if (isLowPriority && meta.lagScore >= env.SSE_LAG_SHED_THRESHOLD) {
        continue;
      }

      // ── Hard kill if persistently slow ─────────────────────
      if (
        meta.lagScore >= env.SSE_LAG_KILL_THRESHOLD ||
        (meta.slowSince !== null && now - meta.slowSince > env.SSE_SLOW_MAX_MS)
      ) {
        toKill.push(client);
        continue;
      }

      try {
        const flushed = client.write(message);
        if (!flushed) {
          meta.lagScore++;
          if (meta.slowSince === null) meta.slowSince = now;
        }
      } catch {
        toKill.push(client);
      }
    }

    if (toKill.length > 0) {
      for (const c of toKill) {
        const meta = this.clients.get(c);
        logger.warn('Velocity SSE client force-closed (lagging)', {
          ip: meta?.ip,
          apiKeyId: meta?.apiKeyId,
          userId: meta?.userId,
          lagScore: meta?.lagScore,
          slowMs: meta?.slowSince ? now - meta.slowSince : null,
        });
        try { c.end(); } catch { /* socket already gone */ }
        this.clients.delete(c);
      }
    }
  }

  /**
   * Get the total number of connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Count active connections grouped by identity. Used by the controller to
   * enforce per-identity SSE concurrency caps. Linear scan; with N in the
   * low thousands this is microseconds and runs once per new connection.
   */
  countByApiKey(apiKeyId: string): number {
    let n = 0;
    for (const meta of this.clients.values()) {
      if (meta.apiKeyId === apiKeyId) n++;
    }
    return n;
  }
  countByUser(userId: string): number {
    let n = 0;
    for (const meta of this.clients.values()) {
      if (meta.userId === userId) n++;
    }
    return n;
  }
  countByIp(ip: string): number {
    let n = 0;
    for (const meta of this.clients.values()) {
      if (meta.ip === ip) n++;
    }
    return n;
  }

  /**
   * Admin-API snapshot of every active session. Returns plain JSON-safe
   * data (no Response objects), grouped by identity so it's easy to spot
   * abuse from one caller. Used by GET /api/admin/sse-sessions.
   */
  snapshot(): {
    total: number;
    byAuth: Record<string, number>;
    byApiKey: Array<{ apiKeyId: string; userEmail?: string; userId?: string; count: number; oldestConnectedAt: number }>;
    byUser: Array<{ userId: string; userEmail?: string; count: number; oldestConnectedAt: number }>;
    byIp: Array<{ ip: string; count: number; oldestConnectedAt: number }>;
    pressure: { state: PressureState; pct: number; heapUsedMb: number };
    sessions: Array<{
      ip?: string;
      userAgent?: string;
      userId?: string;
      userEmail?: string;
      apiKeyId?: string;
      authSource?: string;
      connectedAt: number;
      durationMs: number;
      projectsFilter: string[] | 'all';
      lagScore: number;
    }>;
  } {
    const now = Date.now();
    const byAuth: Record<string, number> = { api_key: 0, jwt: 0, anonymous: 0 };
    const apiKeyMap = new Map<string, { apiKeyId: string; userEmail?: string; userId?: string; count: number; oldestConnectedAt: number }>();
    const userMap = new Map<string, { userId: string; userEmail?: string; count: number; oldestConnectedAt: number }>();
    const ipMap = new Map<string, { ip: string; count: number; oldestConnectedAt: number }>();
    const sessions: Array<{
      ip?: string;
      userAgent?: string;
      userId?: string;
      userEmail?: string;
      apiKeyId?: string;
      authSource?: string;
      connectedAt: number;
      durationMs: number;
      projectsFilter: string[] | 'all';
      lagScore: number;
    }> = [];

    for (const meta of this.clients.values()) {
      const src = meta.authSource || 'anonymous';
      byAuth[src] = (byAuth[src] || 0) + 1;

      if (meta.apiKeyId) {
        const existing = apiKeyMap.get(meta.apiKeyId);
        if (existing) {
          existing.count++;
          if (meta.connectedAt < existing.oldestConnectedAt) existing.oldestConnectedAt = meta.connectedAt;
        } else {
          apiKeyMap.set(meta.apiKeyId, {
            apiKeyId: meta.apiKeyId,
            userEmail: meta.userEmail,
            userId: meta.userId,
            count: 1,
            oldestConnectedAt: meta.connectedAt,
          });
        }
      }

      if (meta.userId) {
        const existing = userMap.get(meta.userId);
        if (existing) {
          existing.count++;
          if (meta.connectedAt < existing.oldestConnectedAt) existing.oldestConnectedAt = meta.connectedAt;
        } else {
          userMap.set(meta.userId, {
            userId: meta.userId,
            userEmail: meta.userEmail,
            count: 1,
            oldestConnectedAt: meta.connectedAt,
          });
        }
      }

      if (meta.ip) {
        const existing = ipMap.get(meta.ip);
        if (existing) {
          existing.count++;
          if (meta.connectedAt < existing.oldestConnectedAt) existing.oldestConnectedAt = meta.connectedAt;
        } else {
          ipMap.set(meta.ip, {
            ip: meta.ip,
            count: 1,
            oldestConnectedAt: meta.connectedAt,
          });
        }
      }

      sessions.push({
        ip: meta.ip,
        userAgent: meta.userAgent,
        userId: meta.userId,
        userEmail: meta.userEmail,
        apiKeyId: meta.apiKeyId,
        authSource: meta.authSource,
        connectedAt: meta.connectedAt,
        durationMs: now - meta.connectedAt,
        projectsFilter: meta.projects.size > 0 ? [...meta.projects] : 'all',
        lagScore: meta.lagScore,
      });
    }

    const byApiKey = [...apiKeyMap.values()].sort((a, b) => b.count - a.count);
    const byUser = [...userMap.values()].sort((a, b) => b.count - a.count);
    const byIp = [...ipMap.values()].sort((a, b) => b.count - a.count);

    const sample = memoryPressure.getLastSample();

    return {
      total: this.clients.size,
      byAuth,
      byApiKey,
      byUser,
      byIp,
      pressure: {
        state: memoryPressure.getState(),
        pct: Number(sample.pct.toFixed(1)),
        heapUsedMb: Math.round(sample.heapUsed / 1024 / 1024),
      },
      sessions,
    };
  }

  /**
   * Diagnostic snapshot — counts by auth source and the top connection
   * sources by IP. Logged periodically so we can see who's driving any
   * surge in clientCount without needing to ship per-connect logs every
   * time. Top-5 IPs is enough to spot a hot caller; we deliberately don't
   * log full user-agent strings here (they're in connect/disconnect logs).
   */
  logSummary(): void {
    const byAuth: Record<string, number> = { api_key: 0, jwt: 0, anonymous: 0 };
    const byIp = new Map<string, number>();
    let lagging = 0;
    for (const meta of this.clients.values()) {
      const src = meta.authSource || 'anonymous';
      byAuth[src] = (byAuth[src] || 0) + 1;
      if (meta.ip) byIp.set(meta.ip, (byIp.get(meta.ip) || 0) + 1);
      if (meta.lagScore > 0) lagging++;
    }
    const topIps = [...byIp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ip, n]) => `${ip}=${n}`)
      .join(' ');
    const sample = memoryPressure.getLastSample();
    logger.info('Velocity SSE summary', {
      total: this.clients.size,
      byAuth,
      uniqueIps: byIp.size,
      topIps: topIps || '(none)',
      lagging,
      memPressure: memoryPressure.getState(),
      heapPct: Number(sample.pct.toFixed(1)),
    });
  }

  /**
   * Disconnect all clients (for graceful shutdown).
   */
  disconnectAll(): void {
    for (const client of this.clients.keys()) {
      try {
        client.end();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.clients.clear();
  }

  /**
   * Memory-pressure transition hook. Public so server.ts can wire it, but
   * the constructor self-subscribes; this method is also used by tests.
   */
  onMemoryPressureTransition(from: PressureState, to: PressureState, pct: number): void {
    // Pressure is per-instance state — one node can be RED while peers are
    // GREEN. Broadcast it locally only; peers will surface their own
    // pressure to their own clients.
    this.localBroadcast('pressure', { from, to, pct: Number(pct.toFixed(1)) });

    // On entering RED, evict the oldest fraction of clients. Their reconnects
    // re-enter through the per-identity caps and memory-pressure gate, so
    // the survivors stay survivors and total broadcast cost drops.
    if (to === 'red' && this.clients.size > 0) {
      const targetEvict = Math.ceil(this.clients.size * env.MEM_PRESSURE_EVICT_FRACTION);
      const evicted: Response[] = [];
      // Map iteration is insertion order, so the first N keys are the oldest.
      let i = 0;
      for (const c of this.clients.keys()) {
        if (i >= targetEvict) break;
        evicted.push(c);
        i++;
      }
      for (const c of evicted) {
        try { c.end(); } catch { /* gone */ }
        this.clients.delete(c);
      }
      logger.warn('Velocity SSE eviction (memory pressure red)', {
        evicted: evicted.length,
        remaining: this.clients.size,
        pct: Number(pct.toFixed(1)),
      });
    }
  }
}

/**
 * Best-effort projectId extraction for broadcast routing.
 * Most events carry `projectId`. Clone/version/challenge events also carry
 * `parentId` (the cluster parent) — WATCH_CLUSTERS listeners subscribe to
 * the parent and want clone activity too, so we return both as candidates
 * for the filter check.
 *
 * Empty result => "broadcast to all" (the safe default, preserving the
 * pre-filter behavior for events whose payloads we don't recognize).
 */
function pickProjectIdCandidates(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const out: string[] = [];
  if (typeof d.projectId === 'string') out.push(d.projectId);
  if (typeof d.parentId === 'string' && d.parentId !== d.projectId) out.push(d.parentId);
  return out;
}

/**
 * Singleton instance of the velocity SSE broadcast manager.
 */
export const velocityStreamManager = new VelocityStreamManager();

// Periodic diagnostic summary so we can correlate clientCount swings with
// caller identity even when nobody's tailing real-time logs.
const summaryHandle = setInterval(() => velocityStreamManager.logSummary(), 60_000);
summaryHandle.unref();
