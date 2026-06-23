-- Migration: 042_velocity_metrics
-- Description: Add iteration tracking, time tracking, and module-level loopback counters

-- Step-level: track total number of turns (iterations) per step
ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS turn_count INT NOT NULL DEFAULT 0;

-- Module-level velocity metrics table
CREATE TABLE IF NOT EXISTS module_velocity_metrics (
  pk_module_velocity_metrics UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_mvm_module UUID NOT NULL UNIQUE REFERENCES module(pk_module) ON DELETE CASCADE,
  -- Module-level loopback count (when a later step sends work back to an earlier step)
  loopback_count INT NOT NULL DEFAULT 0,
  -- Total turns across all steps
  total_turns INT NOT NULL DEFAULT 0,
  -- Time tracking: cumulative seconds spent by each actor across all steps
  ai_time_seconds INT NOT NULL DEFAULT 0,
  human_time_seconds INT NOT NULL DEFAULT 0,
  -- Current step tracking
  current_step_name VARCHAR(50),
  current_step_started_at TIMESTAMPTZ,
  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_mvm_set_updated_at
  BEFORE UPDATE ON module_velocity_metrics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Initialize metrics for all existing modules
INSERT INTO module_velocity_metrics (fk_mvm_module)
SELECT pk_module FROM module WHERE is_deleted = false
ON CONFLICT (fk_mvm_module) DO NOTHING;

-- Auto-create metrics row when a module is created
CREATE OR REPLACE FUNCTION initialize_module_velocity_metrics()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO module_velocity_metrics (fk_mvm_module)
  VALUES (NEW.pk_module)
  ON CONFLICT (fk_mvm_module) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_module_init_velocity_metrics
  AFTER INSERT ON module
  FOR EACH ROW EXECUTE FUNCTION initialize_module_velocity_metrics();

CREATE INDEX IF NOT EXISTS idx_mvm_module ON module_velocity_metrics (fk_mvm_module);
