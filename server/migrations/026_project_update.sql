-- Time-bound updates log for projects (SSO user linked)
CREATE TABLE IF NOT EXISTS project_update (
  pk_project_update UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_project_update_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_project_update_module UUID REFERENCES module(pk_module) ON DELETE SET NULL,
  fk_project_update_user UUID REFERENCES user_account(pk_user_account),
  update_type VARCHAR(50) NOT NULL DEFAULT 'progress'
    CHECK (update_type IN ('progress', 'blocker', 'plan', 'risk', 'decision', 'milestone', 'ai_summary', 'audit_result')),
  update_title VARCHAR(500),
  update_content TEXT NOT NULL,
  update_content_json JSONB,  -- Structured JSON for AI-generated summaries
  update_source VARCHAR(50) DEFAULT 'manual'
    CHECK (update_source IN ('manual', 'api', 'ai_audit', 'github_webhook', 'jira_sync', 'confluence_sync')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_project_update_set_updated_at
  BEFORE UPDATE ON project_update
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_project_update_project ON project_update (fk_project_update_project);
CREATE INDEX IF NOT EXISTS idx_project_update_module ON project_update (fk_project_update_module);
CREATE INDEX IF NOT EXISTS idx_project_update_type ON project_update (update_type);
CREATE INDEX IF NOT EXISTS idx_project_update_created ON project_update (created_at DESC);
