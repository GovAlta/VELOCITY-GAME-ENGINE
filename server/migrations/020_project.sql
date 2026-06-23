-- Core project table (3NF normalized)
CREATE TABLE IF NOT EXISTS project (
  pk_project UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_project_ministry UUID NOT NULL REFERENCES ministry(pk_ministry),
  project_name VARCHAR(500) NOT NULL,
  project_description TEXT,
  project_status VARCHAR(50) NOT NULL DEFAULT 'discovery'
    CHECK (project_status IN (
      'discovery', 'requirements', 'development', 'testing',
      'client_review', 'client_acceptance', 'completion',
      'on_hold', 'cancelled'
    )),
  project_start_date DATE,
  project_end_date DATE,
  project_go_live_date_type VARCHAR(50)
    CHECK (project_go_live_date_type IN ('legislative', 'mandated', 'announced', 'objective') OR project_go_live_date_type IS NULL),
  project_percent_complete INTEGER DEFAULT 0
    CHECK (project_percent_complete >= 0 AND project_percent_complete <= 100),
  project_priority VARCHAR(50),
  project_scope TEXT,
  project_category VARCHAR(100),
  project_demand_number VARCHAR(100),
  project_ministry_priority INTEGER,
  project_risk TEXT,
  project_additional_info TEXT,
  project_branch VARCHAR(255),
  project_source VARCHAR(255),
  project_source_sheet VARCHAR(255),
  project_is_duplicate BOOLEAN NOT NULL DEFAULT false,
  fk_project_duplicate_of UUID REFERENCES project(pk_project),
  -- Audit fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  updated_by UUID REFERENCES user_account(pk_user_account),
  deleted_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_project_set_updated_at
  BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_project_ministry ON project (fk_project_ministry);
CREATE INDEX IF NOT EXISTS idx_project_status ON project (project_status);
CREATE INDEX IF NOT EXISTS idx_project_end_date ON project (project_end_date);
CREATE INDEX IF NOT EXISTS idx_project_is_deleted ON project (is_deleted) WHERE is_deleted = false;
