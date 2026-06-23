import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import crypto from 'crypto';
import { AppError } from '../utils/app-error';
import { env } from '../config/environment';
import logger from '../utils/logger';

/**
 * Derive a rate-limit key. Prefer the api-key identity bucket when an API
 * key header is present so that legitimate agent fleets sharing a NAT
 * (corporate proxy, one VM hosting many listeners) no longer compete for
 * the same IP-keyed budget. Anonymous + browser traffic falls back to IP.
 *
 * Important: this is the BUCKET KEY, not authentication. We hash the raw
 * header value and prefix it so an api-key-presenting caller has its own
 * counter regardless of whether the key is valid. apiKeyAuth runs after
 * the limiter and is what actually decides if the request proceeds.
 *
 * Azure App Service's front-end (ARR) injects X-Forwarded-For values that
 * include the client source port (`IP:port` or `[v6]:port`) — non-standard
 * but well documented. express-rate-limit v7's default keyGenerator runs
 * its IP validator on that string and throws ERR_ERL_INVALID_IP_ADDRESS,
 * which silently bypasses the limiter for every such request. We never
 * actually need the port to identify a client, so strip it.
 */
function clientKey(req: Request): string {
  const apiKey = extractApiKey(req);
  if (apiKey && env.RATE_LIMIT_API_KEY_MAX > 0) {
    // Truncated SHA-256 is plenty unique for bucketing without storing the
    // raw key anywhere. 16 hex chars (64 bits) → ~1 in 18 quintillion
    // collision risk.
    return 'ak:' + crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  }

  const ip = req.ip || req.socket?.remoteAddress || '';
  const v6 = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return 'ip:' + v6[1];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(ip)) return 'ip:' + ip.split(':')[0];
  return 'ip:' + ip;
}

function extractApiKey(req: Request): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.length > 0) return xApiKey;
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer velo_')) {
    return authHeader.substring(7);
  }
  return null;
}

/**
 * Create a rate limiter middleware.
 *
 * Two ceilings: the base `maxRequests` applies to IP-bucketed traffic
 * (anonymous + browser). API-key-bucketed traffic uses `apiKeyMax` if
 * provided — typically higher so authenticated agents aren't squeezed
 * by the anonymous ceiling.
 *
 * NOTE: Uses express-rate-limit's default MemoryStore, which is per-process.
 * On a multi-instance Azure App Service the effective per-bucket ceiling is
 * (max × instances). For a true global cap, swap in rate-limit-redis or
 * rate-limit-postgresql.
 */
export function createRateLimiter(
  maxRequests: number,
  windowMs: number,
  opts: { apiKeyMax?: number } = {},
) {
  const apiKeyMax = opts.apiKeyMax ?? 0;
  return rateLimit({
    windowMs,
    max: (req: Request) => {
      // Function form so the ceiling depends on which bucket the request
      // fell into. apiKey === 'ak:...' gets the elevated ceiling.
      if (apiKeyMax > 0 && clientKey(req).startsWith('ak:')) return apiKeyMax;
      return maxRequests;
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientKey,
    // We supply a custom keyGenerator that already strips ports + buckets by
    // api-key; disable the library's `ip` validator so it doesn't reject the
    // X-Forwarded-For values that Azure's ARR appends a client port to. All
    // other validations stay on.
    validate: { ip: false },
    handler: (req, res, next) => {
      const retryAfterSeconds = Math.ceil(windowMs / 1000);
      const bucket = clientKey(req);
      logger.warn('Rate limit exceeded', {
        bucket: bucket.slice(0, 24), // truncate hashed api-key for log hygiene
        path: req.path,
        userId: (req as any).user?.id,
        userAgent: req.headers['user-agent'],
        retryAfter: retryAfterSeconds,
      });
      res.setHeader('Retry-After', String(retryAfterSeconds));
      const error = AppError.tooManyRequests('Too many requests, please try again later');
      error.details.push({ message: `Retry after ${retryAfterSeconds} seconds`, field: 'retryAfter' });
      next(error);
    },
  });
}

/**
 * General API rate limiter.
 * Two ceilings: IP bucket vs. API-key bucket. Set RATE_LIMIT_API_KEY_MAX=0
 * to disable the api-key bucket entirely (everyone falls back to IP).
 */
export const apiRateLimiter = createRateLimiter(
  env.RATE_LIMIT_API_MAX,
  env.RATE_LIMIT_API_WINDOW_MS,
  { apiKeyMax: env.RATE_LIMIT_API_KEY_MAX },
);

/**
 * Auth endpoint rate limiter (login, SSO callbacks).
 * Default: 30 requests per 15 minutes per IP.
 * Env: RATE_LIMIT_AUTH_MAX, RATE_LIMIT_AUTH_WINDOW_MS
 *
 * NOTE: Only apply to actual login/SSO endpoints, NOT to /csrf or /me
 * which are called frequently during normal app usage.
 */
export const authRateLimiter = createRateLimiter(
  env.RATE_LIMIT_AUTH_MAX,
  env.RATE_LIMIT_AUTH_WINDOW_MS,
);

/**
 * AI endpoint rate limiter.
 * Default: 60 requests per hour per IP.
 * Env: RATE_LIMIT_AI_MAX, RATE_LIMIT_AI_WINDOW_MS
 */
export const aiRateLimiter = createRateLimiter(
  env.RATE_LIMIT_AI_MAX,
  env.RATE_LIMIT_AI_WINDOW_MS,
);

/**
 * SharePoint file mutation rate limiter (uploads, ZIP imports, AI processing).
 * Default: 1000 requests per hour per IP.
 * Env: RATE_LIMIT_SP_MUTATION_MAX, RATE_LIMIT_SP_MUTATION_WINDOW_MS
 */
export const sharepointMutationLimiter = createRateLimiter(
  env.RATE_LIMIT_SP_MUTATION_MAX,
  env.RATE_LIMIT_SP_MUTATION_WINDOW_MS,
);
