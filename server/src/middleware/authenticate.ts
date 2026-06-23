import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/token';
import { COOKIE_NAMES } from '../utils/cookie-config';
import { AppError } from '../utils/app-error';
import type { JwtPayload } from '../types/auth';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

/**
 * Authentication middleware.
 * Extracts JWT from httpOnly cookie, verifies, and attaches user info to req.user.
 * Returns 401 with TOKEN_EXPIRED code on expired tokens (enables auto-refresh).
 * Returns 401 UNAUTHORIZED on missing or invalid tokens.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  // If already authenticated by API key middleware, skip JWT check
  if (req.user && (req as any)._authSource === 'api_key') {
    next();
    return;
  }

  const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];

  if (!token) {
    const hasRefresh = !!req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN];
    logger.warn('Auth: no access token', {
      path: req.path,
      method: req.method,
      hasRefreshCookie: hasRefresh,
      ip: req.ip,
    });
    next(AppError.unauthorized('Authentication required'));
    return;
  }

  try {
    const decoded: JwtPayload = verifyAccessToken(token);

    // Attach user info to request
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      roles: decoded.roles || [decoded.role],
      displayName: decoded.email, // Will be enriched by controller if needed
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      const hasRefresh = !!req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN];
      logger.info('Auth: access token expired (client should refresh)', {
        path: req.path,
        method: req.method,
        hasRefreshCookie: hasRefresh,
        expiredAt: (error as jwt.TokenExpiredError).expiredAt?.toISOString(),
      });
      next(new AppError('Token expired', 401, 'TOKEN_EXPIRED'));
      return;
    }

    logger.warn('Auth: invalid token', {
      path: req.path,
      method: req.method,
      error: (error as Error).message,
    });
    next(AppError.unauthorized('Invalid token'));
  }
}
