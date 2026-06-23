-- Migration: 038_contract_relationship_types
-- Description: Update project_contract relationship types for contract-specific categories

ALTER TABLE project_contract DROP CONSTRAINT IF EXISTS project_contract_pc_relationship_type_check;
ALTER TABLE project_contract ADD CONSTRAINT project_contract_pc_relationship_type_check
  CHECK (pc_relationship_type IN (
    'funded_by', 'delivered_under', 'staffing', 'licensing',
    'maintenance', 'infrastructure', 'consulting', 'other'
  ));
