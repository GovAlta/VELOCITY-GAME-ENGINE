-- Migration: 034_application
-- Description: CMDB application inventory table

CREATE TABLE IF NOT EXISTS application (
  pk_application UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_application_ministry UUID REFERENCES ministry(pk_ministry),
  application_name VARCHAR(500) NOT NULL,
  application_aliases TEXT,
  application_description TEXT,
  application_business_process TEXT,
  application_type VARCHAR(100),
  application_architecture_type VARCHAR(100),
  application_install_type VARCHAR(100),
  application_install_status VARCHAR(100),
  application_lifecycle_stage_status VARCHAR(100),
  application_lifecycle_stage VARCHAR(100),
  application_technology_stack TEXT,
  application_user_base VARCHAR(50),
  application_platform VARCHAR(200),
  application_last_change_date DATE,
  application_business_owner VARCHAR(255),
  application_it_owner VARCHAR(255),
  application_last_updated_by VARCHAR(255),
  application_business_criticality VARCHAR(50),
  application_emergency_tier VARCHAR(50),
  application_data_classification VARCHAR(100),
  application_is_certified BOOLEAN DEFAULT false,
  application_department VARCHAR(255),
  application_source VARCHAR(255),
  -- Audit fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  updated_by UUID REFERENCES user_account(pk_user_account),
  deleted_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_application_set_updated_at
  BEFORE UPDATE ON application
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_application_ministry ON application (fk_application_ministry);
CREATE INDEX IF NOT EXISTS idx_application_name ON application (application_name);
CREATE INDEX IF NOT EXISTS idx_application_install_type ON application (application_install_type);
CREATE INDEX IF NOT EXISTS idx_application_data_classification ON application (application_data_classification);
CREATE INDEX IF NOT EXISTS idx_application_business_criticality ON application (application_business_criticality);
CREATE INDEX IF NOT EXISTS idx_application_is_deleted ON application (is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_application_name_search ON application USING gin (application_name gin_trgm_ops);
