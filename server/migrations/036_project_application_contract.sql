-- Migration: 036_project_application_contract
-- Description: Junction tables linking projects/modules to applications and contracts

-- Project <-> Application link
CREATE TABLE IF NOT EXISTS project_application (
  pk_project_application UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_pa_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_pa_application UUID NOT NULL REFERENCES application(pk_application) ON DELETE CASCADE,
  fk_pa_module UUID REFERENCES module(pk_module) ON DELETE SET NULL,
  pa_relationship_type VARCHAR(50) NOT NULL DEFAULT 'other'
    CHECK (pa_relationship_type IN ('replacing', 'dependency', 'integration', 'api', 'supports', 'other')),
  pa_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  CONSTRAINT uq_project_application UNIQUE (fk_pa_project, fk_pa_application)
);

CREATE TRIGGER trg_project_application_set_updated_at
  BEFORE UPDATE ON project_application
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_pa_project ON project_application (fk_pa_project);
CREATE INDEX IF NOT EXISTS idx_pa_application ON project_application (fk_pa_application);
CREATE INDEX IF NOT EXISTS idx_pa_module ON project_application (fk_pa_module) WHERE fk_pa_module IS NOT NULL;

-- Project <-> Contract link
CREATE TABLE IF NOT EXISTS project_contract (
  pk_project_contract UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_pc_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_pc_contract UUID NOT NULL REFERENCES contract(pk_contract) ON DELETE CASCADE,
  fk_pc_module UUID REFERENCES module(pk_module) ON DELETE SET NULL,
  pc_relationship_type VARCHAR(50) NOT NULL DEFAULT 'other'
    CHECK (pc_relationship_type IN ('replacing', 'dependency', 'integration', 'api', 'supports', 'other')),
  pc_description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  CONSTRAINT uq_project_contract UNIQUE (fk_pc_project, fk_pc_contract)
);

CREATE TRIGGER trg_project_contract_set_updated_at
  BEFORE UPDATE ON project_contract
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_pc_project ON project_contract (fk_pc_project);
CREATE INDEX IF NOT EXISTS idx_pc_contract ON project_contract (fk_pc_contract);
CREATE INDEX IF NOT EXISTS idx_pc_module ON project_contract (fk_pc_module) WHERE fk_pc_module IS NOT NULL;
