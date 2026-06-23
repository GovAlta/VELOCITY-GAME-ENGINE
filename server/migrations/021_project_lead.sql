-- Project lead / team members (many-to-many between projects and users or named leads)
CREATE TABLE IF NOT EXISTS project_lead (
  pk_project_lead UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_project_lead_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_project_lead_user UUID REFERENCES user_account(pk_user_account),
  lead_name VARCHAR(255) NOT NULL,
  lead_role VARCHAR(100) DEFAULT 'lead'
    CHECK (lead_role IN ('lead', 'delivery_director', 'delivery_manager', 'developer', 'analyst', 'tester', 'stakeholder')),
  lead_is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_project_lead_set_updated_at
  BEFORE UPDATE ON project_lead
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_project_lead_project ON project_lead (fk_project_lead_project);
CREATE INDEX IF NOT EXISTS idx_project_lead_user ON project_lead (fk_project_lead_user);
