-- Migration: 035_contract
-- Description: Contract and contingent labour table

CREATE TABLE IF NOT EXISTS contract (
  pk_contract UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_contract_ministry UUID REFERENCES ministry(pk_ministry),
  contract_external_id VARCHAR(100),
  contract_commodity_type VARCHAR(100),
  contract_name VARCHAR(500) NOT NULL,
  contract_description TEXT,
  contract_vendor VARCHAR(500),
  contract_effective_date DATE,
  contract_expiration_date DATE,
  contract_hierarchy_type VARCHAR(200),
  contract_source VARCHAR(255),
  -- Audit fields
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  updated_by UUID REFERENCES user_account(pk_user_account),
  deleted_at TIMESTAMPTZ,
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_contract_set_updated_at
  BEFORE UPDATE ON contract
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_contract_ministry ON contract (fk_contract_ministry);
CREATE INDEX IF NOT EXISTS idx_contract_external_id ON contract (contract_external_id);
CREATE INDEX IF NOT EXISTS idx_contract_vendor ON contract (contract_vendor);
CREATE INDEX IF NOT EXISTS idx_contract_expiration_date ON contract (contract_expiration_date);
CREATE INDEX IF NOT EXISTS idx_contract_is_deleted ON contract (is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_contract_name_search ON contract USING gin (contract_name gin_trgm_ops);
