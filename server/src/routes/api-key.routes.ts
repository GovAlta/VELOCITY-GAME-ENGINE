import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { csrf } from '../middleware/csrf';
import { asyncHandler } from '../utils/async-handler';
import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import { logAuditEvent } from '../utils/audit-logger';
import logger from '../utils/logger';

const router = Router();

/**
 * GET /api/v1/api-keys
 * List the authenticated user's API keys (masked — prefix + last 4 only).
 */
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;

    const { rows } = await pool.query(
      `SELECT pk_api_key, api_key_name, api_key_prefix, api_key_scopes,
              api_key_expires_at, api_key_last_used_at, api_key_revoked_at,
              created_at, updated_at
         FROM api_key
        WHERE fk_api_key_user = $1
        ORDER BY created_at DESC`,
      [userId],
    );

    res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.pk_api_key,
        name: row.api_key_name,
        prefix: row.api_key_prefix,
        scopes: row.api_key_scopes,
        expiresAt: row.api_key_expires_at,
        lastUsedAt: row.api_key_last_used_at,
        revokedAt: row.api_key_revoked_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  }),
);

/**
 * POST /api/v1/api-keys
 * Create a new API key. The full key is returned ONCE in the response body.
 * After creation, only the prefix is stored and visible.
 */
router.post(
  '/',
  authenticate,
  csrf,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const { name, scopes, expiresAt } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw AppError.badRequest('API key name is required');
    }

    if (name.trim().length > 255) {
      throw AppError.badRequest('API key name must be 255 characters or fewer');
    }

    // Validate scopes if provided
    const validScopes = ['read', 'write'];
    const keyScopes: string[] = scopes ?? ['read', 'write'];
    if (!Array.isArray(keyScopes) || keyScopes.some((s: string) => !validScopes.includes(s))) {
      throw AppError.badRequest('Scopes must be an array containing "read" and/or "write"');
    }

    // Validate expiresAt if provided
    let expiresAtDate: Date | null = null;
    if (expiresAt) {
      expiresAtDate = new Date(expiresAt);
      if (isNaN(expiresAtDate.getTime()) || expiresAtDate <= new Date()) {
        throw AppError.badRequest('expiresAt must be a valid future date');
      }
    }

    // Enforce a maximum of 10 active keys per user
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM api_key
        WHERE fk_api_key_user = $1 AND api_key_revoked_at IS NULL`,
      [userId],
    );
    if (parseInt(countRows[0].cnt, 10) >= 10) {
      throw AppError.badRequest('Maximum of 10 active API keys per user');
    }

    // Generate the key: velo_ + 40 random hex chars (48 chars total)
    const randomHex = crypto.randomBytes(20).toString('hex'); // 40 hex chars
    const fullKey = `velo_${randomHex}`;
    const prefix = fullKey.substring(0, 8); // "velo_xxx"
    const hash = crypto.createHash('sha256').update(fullKey).digest('hex');

    const { rows } = await pool.query(
      `INSERT INTO api_key (fk_api_key_user, api_key_name, api_key_prefix, api_key_hash, api_key_scopes, api_key_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING pk_api_key, created_at`,
      [userId, name.trim(), prefix, hash, JSON.stringify(keyScopes), expiresAtDate],
    );

    logger.info('API key created', { userId, keyId: rows[0].pk_api_key, prefix });

    logAuditEvent({ action: 'INSERT', tableName: 'api_key', recordId: rows[0].pk_api_key, userId, newData: { name: name.trim(), prefix, scopes: keyScopes } }).catch(() => {});

    res.status(201).json({
      success: true,
      data: {
        id: rows[0].pk_api_key,
        name: name.trim(),
        key: fullKey, // Only time the full key is returned
        prefix,
        scopes: keyScopes,
        expiresAt: expiresAtDate,
        createdAt: rows[0].created_at,
      },
      message: 'API key created. Copy the key now — it will not be shown again.',
    });
  }),
);

/**
 * DELETE /api/v1/api-keys/:id
 * Revoke (soft-delete) an API key by setting api_key_revoked_at.
 */
router.delete(
  '/:id',
  authenticate,
  csrf,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const userId = req.user!.id;
    const keyId = req.params.id as string;

    // UUID format check
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(keyId)) {
      throw AppError.badRequest('Invalid API key ID format');
    }

    const { rowCount } = await pool.query(
      `UPDATE api_key
          SET api_key_revoked_at = NOW()
        WHERE pk_api_key = $1
          AND fk_api_key_user = $2
          AND api_key_revoked_at IS NULL`,
      [keyId, userId],
    );

    if (rowCount === 0) {
      throw AppError.notFound('API key not found or already revoked');
    }

    logger.info('API key revoked', { userId, keyId });

    logAuditEvent({ action: 'DELETE', tableName: 'api_key', recordId: keyId, userId, oldData: { revoked: true } }).catch(() => {});

    res.json({
      success: true,
      message: 'API key revoked',
    });
  }),
);

export default router;
