/**
 * JWT payload stored in access tokens.
 */
export type RoleName = 'user' | 'project_lead' | 'runner' | 'admin';

export interface JwtPayload {
  sub: string; // user ID (pk_user_account)
  email: string;
  role: RoleName;     // primary role (highest privilege for backwards compat)
  roles: RoleName[];  // all assigned roles
  iat?: number;
  exp?: number;
}

/**
 * SSO profile normalized from Google or Microsoft callbacks.
 */
export interface SSOProfile {
  provider: 'google' | 'microsoft';
  providerId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

/**
 * User record from the database.
 */
export interface UserRecord {
  pk_user_account: string;
  user_email_address: string;
  user_display_name: string;
  sso_provider_name: string;
  sso_provider_id: string;
  google_id: string | null;
  microsoft_id: string | null;
  user_role_name: RoleName;
  avatar_url: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
  is_deleted: boolean;
}

/**
 * Refresh token record from the database.
 */
export interface RefreshTokenRecord {
  pk_refresh_token: string;
  fk_refresh_token_user_account: string;
  token_hash_value: string;
  token_expires_at: string;
  token_revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Authenticated user info attached to Express request.
 */
export interface AuthUser {
  id: string;
  email: string;
  role: RoleName;       // primary (highest) role
  roles: RoleName[];    // all assigned roles
  displayName: string;
}
