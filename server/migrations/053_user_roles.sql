-- Migration: 053_user_roles
-- Description: Multi-role system for users. Replaces single user_role_name column
-- with a junction table supporting multiple concurrent roles per user.
--
-- Roles:
--   public       - not logged in (implicit, never stored)
--   user         - logged in, basic read access
--   project_lead - can modify projects, run audits, manage modules
--   runner       - can use the velocity game interface
--   admin        - full access, user management, system configuration

-- 1. Create the role junction table
CREATE TABLE IF NOT EXISTS user_role (
  pk_user_role UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_ur_user UUID NOT NULL REFERENCES user_account(pk_user_account) ON DELETE CASCADE,
  role_name VARCHAR(30) NOT NULL CHECK (role_name IN ('user', 'project_lead', 'runner', 'admin')),
  granted_by UUID REFERENCES user_account(pk_user_account),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fk_ur_user, role_name)
);

CREATE INDEX idx_ur_user ON user_role (fk_ur_user);
CREATE INDEX idx_ur_role ON user_role (role_name);

-- 2. Migrate existing roles from user_role_name to the junction table
INSERT INTO user_role (fk_ur_user, role_name)
SELECT pk_user_account, user_role_name
FROM user_account
WHERE is_deleted = false
ON CONFLICT (fk_ur_user, role_name) DO NOTHING;

-- 3. Grant all admins the full set of roles
INSERT INTO user_role (fk_ur_user, role_name)
SELECT pk_user_account, r.role_name
FROM user_account
CROSS JOIN (VALUES ('user'), ('project_lead'), ('runner'), ('admin')) AS r(role_name)
WHERE user_role_name = 'admin' AND is_deleted = false
ON CONFLICT (fk_ur_user, role_name) DO NOTHING;

-- 4. Update the CHECK constraint on user_account to accept new roles
-- (keep user_role_name as the "primary" role for backwards compat with JWT)
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS ck_user_account_role;
ALTER TABLE user_account ADD CONSTRAINT ck_user_account_role
  CHECK (user_role_name IN ('user', 'project_lead', 'runner', 'admin'));
