-- Migration: 055_unique_indexes_exclude_deleted
-- Description: Make unique constraints on user_account only apply to non-deleted rows.
-- This prevents soft-deleted duplicates from blocking new SSO provider linkage.

-- Drop the old absolute unique constraints
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS uq_user_account_google_id;
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS uq_user_account_microsoft_id;
ALTER TABLE user_account DROP CONSTRAINT IF EXISTS uq_user_account_email;

-- Recreate as partial unique indexes (only enforce on non-deleted rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_email
  ON user_account (LOWER(user_email_address)) WHERE is_deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_google_id
  ON user_account (google_id) WHERE google_id IS NOT NULL AND is_deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_microsoft_id
  ON user_account (microsoft_id) WHERE microsoft_id IS NOT NULL AND is_deleted = false;
