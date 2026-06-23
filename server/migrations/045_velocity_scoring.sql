-- 045: Add velocity scoring columns to module_velocity_metrics
ALTER TABLE module_velocity_metrics ADD COLUMN IF NOT EXISTS velocity_score INT NOT NULL DEFAULT 0;
ALTER TABLE module_velocity_metrics ADD COLUMN IF NOT EXISTS velocity_bonus INT NOT NULL DEFAULT 0;
ALTER TABLE module_velocity_metrics ADD COLUMN IF NOT EXISTS velocity_penalty INT NOT NULL DEFAULT 0;
