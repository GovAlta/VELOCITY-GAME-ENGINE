-- Migration: 040_module_velocity
-- Description: State machine table tracking each module through 8 velocity steps

CREATE TABLE IF NOT EXISTS module_velocity (
  pk_module_velocity UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_mv_module UUID NOT NULL REFERENCES module(pk_module) ON DELETE CASCADE,
  step_name VARCHAR(50) NOT NULL REFERENCES velocity_step(step_name),
  step_order INT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'not_started'
    CHECK (status IN (
      'not_started', 'ready_to_start',
      'ai_working', 'human_working',
      'ai_review', 'human_review',
      'completed', 'blocked'
    )),
  current_actor VARCHAR(20) CHECK (current_actor IN ('human', 'ai') OR current_actor IS NULL),
  loop_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_module_velocity_step UNIQUE (fk_mv_module, step_name)
);

CREATE TRIGGER trg_module_velocity_set_updated_at
  BEFORE UPDATE ON module_velocity
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_mv_module ON module_velocity (fk_mv_module);
CREATE INDEX IF NOT EXISTS idx_mv_status ON module_velocity (status);
CREATE INDEX IF NOT EXISTS idx_mv_step_order ON module_velocity (fk_mv_module, step_order);

-- Function to auto-initialize velocity steps when a module is created
CREATE OR REPLACE FUNCTION initialize_module_velocity()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO module_velocity (fk_mv_module, step_name, step_order)
  SELECT NEW.pk_module, vs.step_name, vs.step_order
  FROM velocity_step vs
  ORDER BY vs.step_order;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_module_init_velocity
  AFTER INSERT ON module
  FOR EACH ROW EXECUTE FUNCTION initialize_module_velocity();

-- Backfill: create velocity rows for all existing modules that don't have them
INSERT INTO module_velocity (fk_mv_module, step_name, step_order)
SELECT m.pk_module, vs.step_name, vs.step_order
FROM module m
CROSS JOIN velocity_step vs
WHERE NOT EXISTS (
  SELECT 1 FROM module_velocity mv
  WHERE mv.fk_mv_module = m.pk_module AND mv.step_name = vs.step_name
)
AND m.is_deleted = false;
