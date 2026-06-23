-- Project-to-project dependency links (4 PM types + Other)
CREATE TABLE IF NOT EXISTS project_dependency (
  pk_project_dependency UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_dependency_from UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_dependency_to UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  dependency_type VARCHAR(20) NOT NULL DEFAULT 'other'
    CHECK (dependency_type IN ('finish_to_start', 'start_to_start', 'finish_to_finish', 'start_to_finish', 'other')),
  dependency_label VARCHAR(255),
  dependency_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  CONSTRAINT uq_dependency_pair UNIQUE (fk_dependency_from, fk_dependency_to),
  CONSTRAINT chk_no_self_dependency CHECK (fk_dependency_from != fk_dependency_to)
);

CREATE TRIGGER trg_project_dependency_set_updated_at
  BEFORE UPDATE ON project_dependency
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_dependency_from ON project_dependency (fk_dependency_from);
CREATE INDEX IF NOT EXISTS idx_dependency_to ON project_dependency (fk_dependency_to);

-- Canvas positions for projects and modules
ALTER TABLE project ADD COLUMN IF NOT EXISTS canvas_x DOUBLE PRECISION;
ALTER TABLE project ADD COLUMN IF NOT EXISTS canvas_y DOUBLE PRECISION;

ALTER TABLE module ADD COLUMN IF NOT EXISTS canvas_x DOUBLE PRECISION;
ALTER TABLE module ADD COLUMN IF NOT EXISTS canvas_y DOUBLE PRECISION;
