-- Migration: 054_preregister_users
-- Description: Allow pre-registering users before their first SSO login.
-- Make SSO fields nullable so we can create a user record with just an email + roles.

ALTER TABLE user_account ALTER COLUMN sso_provider_name DROP NOT NULL;
ALTER TABLE user_account ALTER COLUMN sso_provider_id DROP NOT NULL;

-- Add a default for sso_provider_name so existing INSERTs don't break
ALTER TABLE user_account ALTER COLUMN sso_provider_name SET DEFAULT 'pending';
ALTER TABLE user_account ALTER COLUMN sso_provider_id SET DEFAULT 'pending';
