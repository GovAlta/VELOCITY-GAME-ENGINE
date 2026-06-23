-- Migration: 056_github_domain
-- Description: Add GitHub domain field to user_account.
-- Allows users to specify their GitHub instance (github.com, enterprise, etc.)
-- Used by all Velo Git API actions alongside the encrypted PAT.

ALTER TABLE user_account ADD COLUMN IF NOT EXISTS user_github_domain VARCHAR(255) DEFAULT 'github.com';
