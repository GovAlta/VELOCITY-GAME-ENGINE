import { pool } from '../config/database';
import type { UserRecord, SSOProfile } from '../types/auth';

/**
 * Find a user by email address.
 */
export async function findByEmail(email: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>(
    'SELECT * FROM user_account WHERE LOWER(user_email_address) = LOWER($1) AND is_deleted = false',
    [email]
  );
  return result.rows[0] || null;
}

/**
 * Find a user by primary key.
 */
export async function findById(id: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRecord>(
    'SELECT * FROM user_account WHERE pk_user_account = $1 AND is_deleted = false',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Find a user by SSO provider ID.
 */
export async function findByProviderId(
  provider: 'google' | 'microsoft',
  providerId: string
): Promise<UserRecord | null> {
  const column = provider === 'google' ? 'google_id' : 'microsoft_id';
  const result = await pool.query<UserRecord>(
    `SELECT * FROM user_account WHERE ${column} = $1 AND is_deleted = false`,
    [providerId]
  );
  return result.rows[0] || null;
}

/**
 * Create a new user from an SSO profile.
 */
export async function createUser(profile: SSOProfile): Promise<UserRecord> {
  const googleId = profile.provider === 'google' ? profile.providerId : null;
  const microsoftId = profile.provider === 'microsoft' ? profile.providerId : null;

  const result = await pool.query<UserRecord>(
    `INSERT INTO user_account (
      user_email_address, user_display_name, sso_provider_name, sso_provider_id,
      google_id, microsoft_id, avatar_url, last_login_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING *`,
    [
      profile.email,
      profile.displayName,
      profile.provider,
      profile.providerId,
      googleId,
      microsoftId,
      profile.avatarUrl || null,
    ]
  );
  return result.rows[0];
}

/**
 * Update an existing user's SSO profile and last login.
 */
export async function updateUser(
  userId: string,
  profile: Partial<SSOProfile>
): Promise<UserRecord | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (profile.displayName) {
    setClauses.push(`user_display_name = $${paramIndex++}`);
    values.push(profile.displayName);
  }

  if (profile.avatarUrl !== undefined) {
    setClauses.push(`avatar_url = $${paramIndex++}`);
    values.push(profile.avatarUrl);
  }

  if (profile.provider === 'google' && profile.providerId) {
    setClauses.push(`google_id = $${paramIndex++}`);
    values.push(profile.providerId);
  }

  if (profile.provider === 'microsoft' && profile.providerId) {
    setClauses.push(`microsoft_id = $${paramIndex++}`);
    values.push(profile.providerId);
  }

  // Update SSO provider info (important for pre-registered users with 'pending')
  if (profile.provider) {
    setClauses.push(`sso_provider_name = $${paramIndex++}`);
    values.push(profile.provider);
  }
  if (profile.providerId) {
    setClauses.push(`sso_provider_id = $${paramIndex++}`);
    values.push(profile.providerId);
  }

  setClauses.push(`last_login_at = NOW()`);
  values.push(userId);

  const result = await pool.query<UserRecord>(
    `UPDATE user_account SET ${setClauses.join(', ')} WHERE pk_user_account = $${paramIndex} AND is_deleted = false RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Update the last_login_at timestamp for a user.
 */
export async function updateLastLogin(userId: string): Promise<void> {
  await pool.query(
    'UPDATE user_account SET last_login_at = NOW() WHERE pk_user_account = $1',
    [userId]
  );
}
