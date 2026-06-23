-- Migration: 049_module_complexity
-- Description: Add module-level complexity multiplier for velocity scoring

ALTER TABLE module ADD COLUMN IF NOT EXISTS module_complexity SMALLINT NOT NULL DEFAULT 1
  CHECK (module_complexity BETWEEN 1 AND 3);

COMMENT ON COLUMN module.module_complexity IS 'Complexity multiplier (1=simple, 2=standard, 3=complex). Multiplies velocity scoring for all steps in this module.';
