import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';

/**
 * API key authentication middleware.
 *
 * Checks for an API key in either:
 *   - Authorization: Bearer velo_xxx
 *   - X-API-Key: velo_xxx
 *
 * If no API key is present, falls through to the next middleware (e.g. JWT auth).
 * If an API key is present but invalid/expired/revoked, returns 401.
 * If valid, loads the owning user and attaches to req.user.
 *
 * Caches successful lookups in-memory for AUTH_CACHE_TTL_MS to avoid
 * a DB round-trip on every request. Without this, a connect storm of
 * SSE clients (each connection is one authed request) saturates the
 * DB pool — observed in production with 2400+ velocity SSE clients.
 *
 * Trade-off: revocation/role changes take up to AUTH_CACHE_TTL_MS to
 * propagate. 60s is a reasonable balance for an internal API. Negative
 * results are also cached briefly so an attacker probing invalid keys
 * cannot DoS the DB.
 */

interface CachedAuth {
  ok: true;
  user: NonNullable<Request['user']>;
  apiKeyId: string;
  expiresAt: number;
  lastUsedTouchAt: number;
}

interface CachedReject {
  ok: false;
  reason: string;
  expiresAt: number;
}

const AUTH_CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 10_000;
const LAST_USED_TOUCH_INTERVAL_MS = 60_000;
// Hard cap to bound memory under hostile probing (a brute-force run
// against random invalid keys would otherwise grow this Map unbounded).
const MAX_CACHE_ENTRIES = 5_000;
// Stale-while-error window. If the DB query fails but we have a cached
// success that expired within this window, serve it. Bounds how long a
// revoked key could keep working during a sustained DB outage.
const STALE_FALLBACK_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

const authCache = new Map<string, CachedAuth | CachedReject>();

// Single-flight: collapse concurrent lookups for the same hash into one
// Promise. Without this, a burst of N concurrent SSE reconnects produces
// N parallel pool.query() calls for the same key, each one consuming a
// scarce pool client. With it, the burst issues exactly one DB query.
const inflightLookups = new Map<string, Promise<CachedAuth | CachedReject>>();

function evictExpired(now: number): void {
  if (authCache.size <= MAX_CACHE_ENTRIES) return;
  for (const [k, v] of authCache) {
    if (v.expiresAt <= now) authCache.delete(k);
    if (authCache.size <= MAX_CACHE_ENTRIES) break;
  }
  // If still over (all entries fresh), drop oldest insertion order — Map
  // iteration order is insertion order, so the first key is the oldest.
  while (authCache.size > MAX_CACHE_ENTRIES) {
    const firstKey = authCache.keys().next().value;
    if (firstKey === undefined) break;
    authCache.delete(firstKey);
  }
}

export function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  const key = extractApiKey(req);

  // No API key header — fall through to JWT auth
  if (!key) {
    next();
    return;
  }

  // Validate prefix format
  if (!key.startsWith('velo_')) {
    next(AppError.unauthorized('Invalid API key format'));
    return;
  }

  // Hash the key and look it up
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  const now = Date.now();

  // ─── Cache lookup ──────────────────────────────────────────
  const cached = authCache.get(hash);
  if (cached && cached.expiresAt > now) {
    if (cached.ok) {
      req.user = cached.user;
      (req as any)._authSource = 'api_key';
      (req as any)._apiKeyId = cached.apiKeyId;

      // Touch last_used_at at most once per minute per key (skips the
      // UPDATE for the other ~N-1 requests in the window).
      if (now - cached.lastUsedTouchAt > LAST_USED_TOUCH_INTERVAL_MS) {
        cached.lastUsedTouchAt = now;
        pool
          .query(
            `UPDATE api_key SET api_key_last_used_at = NOW() WHERE pk_api_key = $1`,
            [cached.apiKeyId],
          )
          .catch((err) => {
            logger.warn('Failed to update api_key_last_used_at', {
              keyId: cached.apiKeyId,
              error: err.message,
            });
          });
      }
      next();
      return;
    }
    next(AppError.unauthorized(cached.reason));
    return;
  }

  // ─── Cache miss → DB lookup, single-flighted ───────────────
  let lookup = inflightLookups.get(hash);
  if (!lookup) {
    lookup = doLookup(hash);
    inflightLookups.set(hash, lookup);
    // Always clear the in-flight slot once settled, whether resolved or
    // rejected, so a future retry can re-enter.
    lookup.finally(() => inflightLookups.delete(hash));
  }

  lookup
    .then((result) => {
      if (result.ok) {
        req.user = result.user;
        (req as any)._authSource = 'api_key';
        (req as any)._apiKeyId = result.apiKeyId;
        next();
        return;
      }
      next(AppError.unauthorized(result.reason));
    })
    .catch((err) => {
      // ─── Stale-while-error fallback ──────────────────────────
      // If the DB lookup just failed but we have a cached SUCCESS for this
      // hash within the stale window, serve it. This keeps already-known
      // agents flowing through DB blips. Bounded by STALE_FALLBACK_MAX_AGE_MS
      // so a revoked key can't survive a long outage.
      const stale = authCache.get(hash);
      if (stale && stale.ok) {
        const stalenessMs = Date.now() - (stale.expiresAt - AUTH_CACHE_TTL_MS);
        if (stalenessMs < STALE_FALLBACK_MAX_AGE_MS) {
          logger.warn('auth DB unavailable; serving stale cache entry', {
            keyId: stale.apiKeyId,
            stalenessMs,
            error: err.message,
          });
          req.user = stale.user;
          (req as any)._authSource = 'api_key';
          (req as any)._apiKeyId = stale.apiKeyId;
          // Push the cache forward a bit so simultaneous failers don't all
          // hit doLookup again on the next retry — they'll get this stale
          // entry as a fresh hit for another short window.
          stale.expiresAt = Date.now() + 5_000;
          next();
          return;
        }
      }
      logger.error('API key auth database error', { error: err.message });
      next(AppError.internal('Authentication service unavailable'));
    });
}

/**
 * Perform a fresh DB lookup for the given hash and cache the result.
 * Returns a cached entry — never throws on a clean "no row" or "user
 * disabled" result, only on actual DB transport errors (which become
 * the rejected branch of the returned Promise).
 */
function doLookup(hash: string): Promise<CachedAuth | CachedReject> {
  return pool
    .query(
      `SELECT ak.pk_api_key, ak.fk_api_key_user, ak.api_key_scopes,
              ua.pk_user_account, ua.user_email_address, ua.user_role_name,
              ua.user_display_name, ua.is_active,
              COALESCE(
                array_agg(ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
                ARRAY[ua.user_role_name]
              ) AS user_roles
         FROM api_key ak
         JOIN user_account ua ON ua.pk_user_account = ak.fk_api_key_user
         LEFT JOIN user_role ur ON ur.fk_ur_user = ua.pk_user_account
        WHERE ak.api_key_hash = $1
          AND ak.api_key_revoked_at IS NULL
          AND (ak.api_key_expires_at IS NULL OR ak.api_key_expires_at > NOW())
        GROUP BY ak.pk_api_key, ua.pk_user_account`,
      [hash],
    )
    .then(({ rows }) => {
      const now = Date.now();

      if (rows.length === 0) {
        const entry: CachedReject = {
          ok: false,
          reason: 'Invalid or expired API key',
          expiresAt: now + NEGATIVE_CACHE_TTL_MS,
        };
        authCache.set(hash, entry);
        evictExpired(now);
        return entry;
      }

      const row = rows[0];

      if (!row.is_active) {
        const entry: CachedReject = {
          ok: false,
          reason: 'User account is disabled',
          expiresAt: now + NEGATIVE_CACHE_TTL_MS,
        };
        authCache.set(hash, entry);
        evictExpired(now);
        return entry;
      }

      const user: NonNullable<Request['user']> = {
        id: row.pk_user_account,
        email: row.user_email_address,
        role: row.user_role_name,
        roles: row.user_roles || [row.user_role_name],
        displayName: row.user_display_name,
      };

      const entry: CachedAuth = {
        ok: true,
        user,
        apiKeyId: row.pk_api_key,
        expiresAt: now + AUTH_CACHE_TTL_MS,
        lastUsedTouchAt: now,
      };
      authCache.set(hash, entry);
      evictExpired(now);

      // Fire-and-forget last_used_at touch on the miss path.
      pool
        .query(
          `UPDATE api_key SET api_key_last_used_at = NOW() WHERE pk_api_key = $1`,
          [row.pk_api_key],
        )
        .catch((err) => {
          logger.warn('Failed to update api_key_last_used_at', {
            keyId: row.pk_api_key,
            error: err.message,
          });
        });

      return entry;
    });
}

/**
 * Test-only helper to clear the cache between specs. Not exposed via the
 * public surface and irrelevant in production.
 */
export function __resetApiKeyAuthCacheForTests(): void {
  authCache.clear();
}

/**
 * Extract the API key from the request headers.
 * Checks X-API-Key first, then Authorization: Bearer velo_xxx.
 * Returns null if no API key is present.
 */
function extractApiKey(req: Request): string | null {
  // Check X-API-Key header
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) {
    return xApiKey;
  }

  // Check Authorization: Bearer <key>
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer velo_')) {
    return authHeader.substring(7); // Strip "Bearer "
  }

  return null;
}
