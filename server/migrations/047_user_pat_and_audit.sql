-- Migration: 047_user_pat_and_audit
-- Description: Encrypted PAT storage for users, universal project audit table

-- User PAT storage (encrypted)
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS user_github_pat_encrypted TEXT;
ALTER TABLE user_account ADD COLUMN IF NOT EXISTS user_github_pat_iv TEXT;

-- Universal project audit table (source-agnostic)
CREATE TABLE IF NOT EXISTS project_audit (
  pk_project_audit UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_audit_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_audit_module UUID REFERENCES module(pk_module) ON DELETE SET NULL,

  -- Source identification
  audit_source VARCHAR(50) NOT NULL
    CHECK (audit_source IN ('git', 'jira', 'confluence', 'sharepoint', 'web', 'manual', 'ai_analysis')),
  audit_source_url TEXT,
  audit_source_ref VARCHAR(255),

  -- Audit metadata
  audit_title VARCHAR(500) NOT NULL,
  audit_summary TEXT,
  audit_status VARCHAR(50) DEFAULT 'completed'
    CHECK (audit_status IN ('pending', 'running', 'completed', 'failed', 'stale')),

  -- Structured audit data (the payload — varies by source)
  audit_data JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- LLM analysis of the audit data
  audit_ai_provider VARCHAR(50),
  audit_ai_model VARCHAR(100),
  audit_ai_analysis JSONB,
  audit_ai_score SMALLINT CHECK (audit_ai_score IS NULL OR audit_ai_score BETWEEN 0 AND 100),

  -- Audit fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_project_audit_set_updated_at
  BEFORE UPDATE ON project_audit
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_pa_project ON project_audit (fk_audit_project);
CREATE INDEX IF NOT EXISTS idx_pa_source ON project_audit (audit_source);
CREATE INDEX IF NOT EXISTS idx_pa_status ON project_audit (audit_status);
CREATE INDEX IF NOT EXISTS idx_pa_created ON project_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pa_module ON project_audit (fk_audit_module) WHERE fk_audit_module IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pa_is_deleted ON project_audit (is_deleted) WHERE is_deleted = false;
