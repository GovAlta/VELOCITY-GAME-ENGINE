import pg, { PoolClient } from 'pg';
import crypto from 'crypto';
import { env } from '../config/environment';
import logger from '../utils/logger';

/**
 * Cross-instance broadcast bus via PostgreSQL LISTEN/NOTIFY.
 *
 * Why this exists: the velocity SSE broadcast set is per-Node-process. On a
 * scaled-out App Service plan, a `move` made on instance A would be invisible
 * to SSE clients pinned to instance B/C. This bus glues the broadcasts back
 * together: every instance LISTENs on the same channel, and every broadcast
 * also fires a NOTIFY so peer instances re-fan-out locally.
 *
 * Mechanism:
 *   - On startup, one dedicated PG client is checked out of the pool and
 *     parked on `LISTEN velocity_events`. We never release it back — that
 *     would lose the subscription.
 *   - `publish(event, data)` calls the local broadcast handler AND emits
 *     `pg_notify('velocity_events', payload)`.
 *   - The payload carries this instance's `originId` (a per-boot UUID) so
 *     when we receive our own NOTIFY back over LISTEN, we skip the re-broadcast.
 *
 * Failure mode: if Postgres goes away mid-flight, the dedicated client errors
 * and we reconnect with capped exponential backoff. Local broadcasts continue
 * unaffected (publish() still calls the local handler first). Cross-instance
 * delivery resumes when the LISTEN reconnects.
 *
 * Payload size: NOTIFY payloads are capped at 8000 bytes server-side. We
 * stay well under that for normal events. If we ever encode an oversized
 * payload, we drop the NOTIFY (with a warn log) rather than crash; local
 * delivery still happens.
 */

const CHANNEL = 'velocity_events';
const MAX_NOTIFY_BYTES = 7500; // headroom under the 8000-byte hard limit
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type LocalHandler = (event: string, data: unknown) => void;

interface WireMessage {
  originId: string;
  event: string;
  data: unknown;
}

class CrossInstanceBus {
  /** Per-boot UUID so we can suppress our own NOTIFY echoes. */
  readonly originId: string = crypto.randomUUID();

  private localHandler: LocalHandler | null = null;
  private listenClient: PoolClient | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;
  private shuttingDown = false;
  /** Lazy pool import — wiring is in start() so tests can substitute. */
  private pool: pg.Pool | null = null;

  /**
   * Register the function that fans out an event to local SSE clients.
   * velocity-stream wires this exactly once at module init.
   */
  registerLocalHandler(fn: LocalHandler): void {
    this.localHandler = fn;
  }

  /**
   * Begin LISTENing on the channel. Idempotent. Errors are logged + we
   * retry — start() never throws so it doesn't bring down boot.
   */
  async start(pool: pg.Pool): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.pool = pool;
    await this.connectListener();
  }

  /**
   * Local fan-out + cross-instance NOTIFY. The local handler runs first so
   * broadcasts work even if Postgres LISTEN is currently disconnected.
   */
  publish(event: string, data: unknown): void {
    if (this.localHandler) {
      try { this.localHandler(event, data); }
      catch (err) { logger.error('cross-instance-bus local handler error', { error: (err as Error).message }); }
    }

    if (!this.pool) return; // start() never called — local-only mode (tests, no DB)

    const msg: WireMessage = { originId: this.originId, event, data };
    let payload: string;
    try {
      payload = JSON.stringify(msg);
    } catch (err) {
      logger.warn('cross-instance-bus skipping NOTIFY (unserializable payload)', { event, error: (err as Error).message });
      return;
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_NOTIFY_BYTES) {
      logger.warn('cross-instance-bus skipping NOTIFY (payload too large)', { event, bytes: Buffer.byteLength(payload, 'utf8') });
      return;
    }

    // Fire-and-forget. NOTIFY is fast (no rows returned) and we'd rather
    // not block the request handler that called broadcast().
    // pg_notify(text, text) is parameterized so payloads can contain any
    // characters safely.
    this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch((err: Error) => {
      logger.warn('cross-instance-bus NOTIFY failed', { event, error: err.message });
    });
  }

  /**
   * Tear down — used by graceful shutdown + tests.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.listenClient) {
      try { this.listenClient.release(true); } catch { /* gone */ }
      this.listenClient = null;
    }
    this.started = false;
  }

  private async connectListener(): Promise<void> {
    if (!this.pool || this.shuttingDown) return;
    try {
      const client = await this.pool.connect();
      // PoolClient.release(true) actually destroys the connection — pg pool
      // pattern for a parked LISTENer. The connection is never returned to
      // the pool's reusable set; it lives until stop() destroys it.
      this.listenClient = client;
      this.reconnectAttempt = 0;

      client.on('notification', (n: pg.Notification) => {
        if (n.channel !== CHANNEL || !n.payload) return;
        let msg: WireMessage;
        try { msg = JSON.parse(n.payload); }
        catch { return; }
        // Skip our own echoes.
        if (msg.originId === this.originId) return;
        if (this.localHandler) {
          try { this.localHandler(msg.event, msg.data); }
          catch (err) { logger.error('cross-instance-bus remote handler error', { event: msg.event, error: (err as Error).message }); }
        }
      });

      // When the underlying connection fails, pg emits 'error' on the
      // client. We log + reconnect; the pool itself stays healthy because
      // this client was checked out, not pooled.
      client.on('error', (err: Error) => {
        logger.warn('cross-instance-bus LISTEN client error', { error: err.message });
        try { client.release(true); } catch { /* already gone */ }
        if (this.listenClient === client) this.listenClient = null;
        this.scheduleReconnect();
      });

      await client.query(`LISTEN ${CHANNEL}`);
      logger.info('cross-instance-bus LISTEN active', { channel: CHANNEL, originId: this.originId });
    } catch (err) {
      logger.warn('cross-instance-bus LISTEN connect failed; will retry', { error: (err as Error).message });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectListener();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Test-only state reset. */
  __resetForTests(): void {
    this.stop();
    this.localHandler = null;
    this.reconnectAttempt = 0;
    this.shuttingDown = false;
    this.pool = null;
    this.started = false;
  }
}

// Use a different originId on every cold start so a quick restart can't
// be mistaken for the previous process when we see its in-flight NOTIFYs.
// `originId` is exported as a property of the singleton above.
export const crossInstanceBus = new CrossInstanceBus();

// SSE_DISABLE_CROSS_INSTANCE=true in .env to fall back to single-instance
// behavior (useful for local dev where you don't want a parked PG connection).
export function isCrossInstanceDisabled(): boolean {
  return env.SSE_DISABLE_CROSS_INSTANCE === true;
}
