import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/app-error';
import { pool } from '../config/database';
import type { RoleName } from '../types/auth';

const router = Router();
const VALID_ROLES: RoleName[] = ['user', 'project_lead', 'runner', 'admin'];

// Lookup endpoint accessible to any authenticated user — used by the
// project-membership UI so owners can find teammates by email/name without
// needing admin access. Returns minimal info; nothing role-sensitive.
router.get(
  '/lookup',
  authenticate,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      sendSuccess(res, []);
      return;
    }
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 10), 25);
    const result = await pool.query(
      `SELECT pk_user_account, user_email_address, user_display_name, avatar_url
         FROM user_account
        WHERE is_deleted = false AND is_active = true
          AND (LOWER(user_email_address) LIKE LOWER($1)
            OR LOWER(user_display_name)  LIKE LOWER($1))
        ORDER BY user_display_name
        LIMIT $2`,
      [`%${q}%`, limit],
    );
    sendSuccess(res, result.rows);
  }),
);

// All other routes require admin
router.use(authenticate, authorize('admin'));

/**
 * POST /api/v1/users
 * Pre-register a user by email with assigned roles.
 * The user record is created with pending SSO — when they first log in via SSO,
 * the existing record is matched by email and SSO fields are linked.
 * Body: { email: string, displayName?: string, roles: string[] }
 */
router.post('/', csrf, asyncHandler(async (req, res) => {
  const { email, displayName, roles: requestedRoles } = req.body;

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw AppError.badRequest('Valid email address is required');
  }

  const rolesToGrant: RoleName[] = Array.isArray(requestedRoles)
    ? requestedRoles.filter((r: string) => VALID_ROLES.includes(r as RoleName)) as RoleName[]
    : ['user'];

  if (rolesToGrant.length === 0) rolesToGrant.push('user');

  // Check if user already exists
  const existing = await pool.query(
    'SELECT pk_user_account FROM user_account WHERE user_email_address = $1 AND is_deleted = false',
    [email.toLowerCase().trim()]
  );

  if (existing.rows.length > 0) {
    throw AppError.badRequest(`User with email ${email} already exists. Use the role endpoints to modify their roles.`);
  }

  // Determine primary role (highest privilege)
  const primaryRole = rolesToGrant.includes('admin') ? 'admin'
    : rolesToGrant.includes('project_lead') ? 'project_lead'
    : rolesToGrant.includes('runner') ? 'runner'
    : 'user';

  // Create user with pending SSO
  const userRes = await pool.query(
    `INSERT INTO user_account (
      user_email_address, user_display_name, sso_provider_name, sso_provider_id,
      user_role_name, is_active
    ) VALUES ($1, $2, 'pending', 'pending', $3, true)
    RETURNING pk_user_account`,
    [email.toLowerCase().trim(), displayName || email.split('@')[0], primaryRole]
  );
  const userId = userRes.rows[0].pk_user_account;

  // Assign roles
  for (const role of rolesToGrant) {
    await pool.query(
      'INSERT INTO user_role (fk_ur_user, role_name, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [userId, role, req.user!.id]
    );
  }

  // Load the created user with roles
  const created = await pool.query(
    `SELECT ua.pk_user_account, ua.user_email_address, ua.user_display_name,
            ua.user_role_name, ua.is_active, ua.created_at
     FROM user_account ua WHERE ua.pk_user_account = $1`,
    [userId]
  );

  sendSuccess(res, {
    ...created.rows[0],
    roles: rolesToGrant,
    status: 'pre-registered',
  }, 201);
}));

/**
 * GET /api/v1/users
 * List all users with their roles.
 */
router.get('/', asyncHandler(async (_req, res) => {
  const result = await pool.query(
    `SELECT ua.pk_user_account, ua.user_email_address, ua.user_display_name,
            ua.user_role_name, ua.sso_provider_name, ua.avatar_url,
            ua.is_active, ua.last_login_at, ua.created_at,
            COALESCE(
              json_agg(ur.role_name ORDER BY ur.role_name) FILTER (WHERE ur.role_name IS NOT NULL),
              '[]'::json
            ) AS roles
     FROM user_account ua
     LEFT JOIN user_role ur ON ur.fk_ur_user = ua.pk_user_account
     WHERE ua.is_deleted = false
     GROUP BY ua.pk_user_account
     ORDER BY ua.created_at DESC`
  );
  sendSuccess(res, result.rows);
}));

/**
 * GET /api/v1/users/:userId
 * Get a single user with roles.
 */
router.get('/:userId', asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const result = await pool.query(
    `SELECT ua.pk_user_account, ua.user_email_address, ua.user_display_name,
            ua.user_role_name, ua.sso_provider_name, ua.avatar_url,
            ua.is_active, ua.last_login_at, ua.created_at
     FROM user_account ua
     WHERE ua.pk_user_account = $1 AND ua.is_deleted = false`,
    [userId]
  );
  if (result.rows.length === 0) throw AppError.notFound('User not found');

  const rolesRes = await pool.query(
    'SELECT role_name FROM user_role WHERE fk_ur_user = $1 ORDER BY role_name',
    [userId]
  );

  sendSuccess(res, {
    ...result.rows[0],
    roles: rolesRes.rows.map(r => r.role_name),
  });
}));

/**
 * POST /api/v1/users/:userId/roles
 * Add a role to a user.
 * Body: { role: "project_lead" }
 */
router.post('/:userId/roles', csrf, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { role } = req.body;

  if (!role || !VALID_ROLES.includes(role)) {
    throw AppError.badRequest(`Invalid role. Valid: ${VALID_ROLES.join(', ')}`);
  }

  // Verify user exists
  const userCheck = await pool.query(
    'SELECT pk_user_account FROM user_account WHERE pk_user_account = $1 AND is_deleted = false',
    [userId]
  );
  if (userCheck.rows.length === 0) throw AppError.notFound('User not found');

  await pool.query(
    'INSERT INTO user_role (fk_ur_user, role_name, granted_by) VALUES ($1, $2, $3) ON CONFLICT (fk_ur_user, role_name) DO NOTHING',
    [userId, role, req.user!.id]
  );

  // Reload roles
  const rolesRes = await pool.query(
    'SELECT role_name FROM user_role WHERE fk_ur_user = $1 ORDER BY role_name',
    [userId]
  );

  sendSuccess(res, { roles: rolesRes.rows.map(r => r.role_name) });
}));

/**
 * DELETE /api/v1/users/:userId/roles/:role
 * Remove a role from a user.
 */
router.delete('/:userId/roles/:role', csrf, asyncHandler(async (req, res) => {
  const { userId, role } = req.params;

  if (!VALID_ROLES.includes(role as RoleName)) {
    throw AppError.badRequest(`Invalid role. Valid: ${VALID_ROLES.join(', ')}`);
  }

  // Prevent removing last role
  const countRes = await pool.query(
    'SELECT COUNT(*) AS cnt FROM user_role WHERE fk_ur_user = $1',
    [userId]
  );
  if (parseInt(countRes.rows[0].cnt, 10) <= 1) {
    throw AppError.badRequest('Cannot remove last role. User must have at least one role.');
  }

  // Prevent admin from removing own admin role
  if (userId === req.user!.id && role === 'admin') {
    throw AppError.badRequest('Cannot remove your own admin role.');
  }

  await pool.query(
    'DELETE FROM user_role WHERE fk_ur_user = $1 AND role_name = $2',
    [userId, role]
  );

  const rolesRes = await pool.query(
    'SELECT role_name FROM user_role WHERE fk_ur_user = $1 ORDER BY role_name',
    [userId]
  );

  sendSuccess(res, { roles: rolesRes.rows.map(r => r.role_name) });
}));

/**
 * PATCH /api/v1/users/:userId/active
 * Enable or disable a user account.
 * Body: { active: boolean }
 */
router.patch('/:userId/active', csrf, asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { active } = req.body;

  if (typeof active !== 'boolean') {
    throw AppError.badRequest('active must be a boolean');
  }

  // Prevent admin from deactivating themselves
  if (userId === req.user!.id && !active) {
    throw AppError.badRequest('Cannot deactivate your own account.');
  }

  await pool.query(
    'UPDATE user_account SET is_active = $1 WHERE pk_user_account = $2',
    [active, userId]
  );

  sendSuccess(res, { active });
}));

export default router;
