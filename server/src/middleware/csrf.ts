import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { COOKIE_NAMES } from '../utils/cookie-config';
import { AppError } from '../utils/app-error';

/**
 * CSRF protection middleware using double-submit cookie pattern.
 *
 * Validates that the `x-csrf-token` header matches the value of the CSRF cookie.
 * The CSRF cookie is httpOnly (not readable by JavaScript). The client receives
 * the token value from the GET /api/auth/csrf JSON response body and stores it
 * in memory only. The client sends the in-memory token in the x-csrf-token header,
 * and this middleware compares it to the httpOnly cookie value.
 *
 * Applied to all state-changing requests (POST, PUT, PATCH, DELETE).
 */
export function csrf(req: Request, _res: Response, next: NextFunction): void {
  // Only validate on state-changing methods
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    next();
    return;
  }

  // Skip CSRF for API-key-authenticated requests (they don't use cookies)
  if ((req as any)._authSource === 'api_key') {
    next();
    return;
  }

  const headerToken = req.headers['x-csrf-token'] as string | undefined;
  const cookieToken = req.cookies?.[COOKIE_NAMES.CSRF_TOKEN] as string | undefined;

  if (!headerToken || !cookieToken) {
    next(new AppError('CSRF token missing', 403, 'CSRF_MISSING'));
    return;
  }

  // Constant-time comparison to prevent timing side-channel attacks
  const headerBuf = Buffer.from(headerToken);
  const cookieBuf = Buffer.from(cookieToken);
  if (headerBuf.length !== cookieBuf.length || !crypto.timingSafeEqual(headerBuf, cookieBuf)) {
    next(new AppError('CSRF token mismatch', 403, 'CSRF_MISMATCH'));
    return;
  }

  next();
}
