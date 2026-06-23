-- Migration: 050_module_complexity_float
-- Description: Change module_complexity from SMALLINT(1-3) to NUMERIC(0-10) for fine-grained weighting

ALTER TABLE module DROP CONSTRAINT IF EXISTS module_module_complexity_check;
ALTER TABLE module ALTER COLUMN module_complexity TYPE NUMERIC(4,2);
ALTER TABLE module ALTER COLUMN module_complexity SET DEFAULT 1.0;
ALTER TABLE module ADD CONSTRAINT module_module_complexity_check CHECK (module_complexity >= 0 AND module_complexity <= 10);
