-- Modules / milestones within a project
CREATE TABLE IF NOT EXISTS module (
  pk_module UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_module_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  module_name VARCHAR(500) NOT NULL,
  module_description TEXT,
  module_status VARCHAR(50) NOT NULL DEFAULT 'requirements_gathering'
    CHECK (module_status IN (
      'requirements_gathering', 'building', 'client_review',
      'client_sign_off', 'delivered', 'closed', 'cancelled'
    )),
  module_start_date DATE,
  module_end_date DATE,
  module_percent_complete INTEGER DEFAULT 0
    CHECK (module_percent_complete >= 0 AND module_percent_complete <= 100),
  module_sort_order INTEGER NOT NULL DEFAULT 0,
  -- AI-appended fields
  module_plan TEXT,
  module_progress TEXT,
  module_blockers TEXT,
  -- Audit fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  updated_by UUID REFERENCES user_account(pk_user_account),
  deleted_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_module_set_updated_at
  BEFORE UPDATE ON module
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_module_project ON module (fk_module_project);
CREATE INDEX IF NOT EXISTS idx_module_status ON module (module_status);
CREATE INDEX IF NOT EXISTS idx_module_is_deleted ON module (is_deleted) WHERE is_deleted = false;
