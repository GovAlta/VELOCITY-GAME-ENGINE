-- User-level API keys for programmatic access (delegated full access)
CREATE TABLE IF NOT EXISTS api_key (
  pk_api_key UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_api_key_user UUID NOT NULL REFERENCES user_account(pk_user_account) ON DELETE CASCADE,
  api_key_name VARCHAR(255) NOT NULL,
  api_key_prefix VARCHAR(8) NOT NULL,      -- First 8 chars for identification (velo_xxx)
  api_key_hash VARCHAR(128) NOT NULL,      -- SHA-256 hash of the full key
  api_key_scopes JSONB NOT NULL DEFAULT '["read", "write"]'::jsonb,
  api_key_expires_at TIMESTAMPTZ,
  api_key_last_used_at TIMESTAMPTZ,
  api_key_revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_api_key_set_updated_at
  BEFORE UPDATE ON api_key
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_key (api_key_hash) WHERE api_key_revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key (fk_api_key_user);
CREATE INDEX IF NOT EXISTS idx_api_key_prefix ON api_key (api_key_prefix);
