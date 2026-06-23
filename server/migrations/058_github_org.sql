-- Migration: 058_github_org
-- Description: Add GitHub organization field to user_account.
-- When set, repo creation auto-injects this org so API consumers don't need to specify it.

ALTER TABLE user_account ADD COLUMN IF NOT EXISTS user_github_org VARCHAR(255);
