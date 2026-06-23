import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { pool } from '../config/database';
import { AppError } from '../utils/app-error';

/**
 * Idempotency-Key middleware.
 *
 * When a request includes `Idempotency-Key: <uuid>` we:
 *   1. Hash the request body and method+path
 *   2. Look up the (key) row in velocity_idempotency
 *      - If hit and hash matches → replay the cached response (200 + same body
 *        the original returned, even if the underlying state has moved on)
 *      - If hit and hash differs → 422 IDEMPOTENCY_KEY_REUSED (different intent)
 *      - If miss → wrap res.json so we capture the eventual success response
 *        and store it for future retries (24h TTL via DB column default)
 *
 * Header is optional — when absent the middleware is a no-op. Designed for
 * agents that retry on transient network failure without risking double-execution.
 *
 * Only intercepts non-idempotent verbs (POST, PUT, PATCH, DELETE). GETs are
 * already idempotent.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_IDEMPOTENT = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hashRequest(method: string, path: string, body: unknown): string {
  const payload = `${method.toUpperCase()} ${path}\n${JSON.stringify(body ?? null)}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

interface IdempotencyRow {
  request_hash: string;
  response_status: number;
  response_body: any;
  created_at: string;
}

export function idempotency(req: Request, res: Response, next: NextFunction): void {
  if (!NON_IDEMPOTENT.has(req.method)) { next(); return; }
  const key = req.header('Idempotency-Key');
  if (!key) { next(); return; }

  if (!UUID_RE.test(key)) {
    next(new AppError('Idempotency-Key must be a UUID v4', 400, 'IDEMPOTENCY_KEY_INVALID'));
    return;
  }

  const hash = hashRequest(req.method, req.originalUrl || req.url, req.body);

  pool
    .query<IdempotencyRow>(
      `SELECT request_hash, response_status, response_body, created_at
         FROM velocity_idempotency
        WHERE idempotency_key = $1 AND expires_at > NOW()`,
      [key],
    )
    .then(({ rows }) => {
      if (rows.length > 0) {
        const cached = rows[0];
        if (cached.request_hash !== hash) {
          return next(new AppError(
            'Idempotency-Key already used with a different request body',
            422,
            'IDEMPOTENCY_KEY_REUSED',
          ));
        }
        // Cache hit — replay the original response.
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(cached.response_status).json(cached.response_body);
        return;
      }

      // Cache miss — wrap res.json to capture the response on its way out.
      const originalJson = res.json.bind(res);
      let captured = false;
      (res as Response).json = (body: unknown) => {
        // Only cache successful (2xx) responses; failures shouldn't be replayed.
        if (!captured && res.statusCode >= 200 && res.statusCode < 300) {
          captured = true;
          const userId  = req.user?.id ?? null;
          const apiKeyId = (req as any)._apiKeyId ?? null;
          // Fire-and-forget — don't block the response on storage failures.
          pool.query(
            `INSERT INTO velocity_idempotency
               (idempotency_key, fk_user, fk_api_key, request_method,
                request_path, request_hash, response_status, response_body)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [
              key,
              userId,
              apiKeyId,
              req.method,
              (req.originalUrl || req.url).slice(0, 500),
              hash,
              res.statusCode,
              JSON.stringify(body),
            ],
          ).catch(() => { /* logged at pool level */ });
        }
        return originalJson(body);
      };

      next();
    })
    .catch(next);
}

/**
 * Cleanup helper — runs as part of the AI queue's drain interval to delete
 * expired idempotency rows. Cheap; uses the expires_at index.
 */
export async function cleanupExpiredIdempotency(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM velocity_idempotency WHERE expires_at < NOW()`,
  );
  return rowCount ?? 0;
}
