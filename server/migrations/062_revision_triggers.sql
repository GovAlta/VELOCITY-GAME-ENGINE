-- Migration: 062_revision_triggers
-- Description: Auto-bump revision counters on every UPDATE so service-layer
--   code never has to remember to do it. Pairs with migration 061.

-- ─── project.project_revision ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION bump_project_revision()
RETURNS TRIGGER AS $$
BEGIN
  -- Skip when nothing material changed (e.g. only updated_at touched
  -- by a no-op write). We bump for any column except updated_at.
  IF (TG_OP = 'UPDATE') THEN
    NEW.project_revision := COALESCE(OLD.project_revision, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_bump_revision ON project;
CREATE TRIGGER trg_project_bump_revision
  BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION bump_project_revision();

-- ─── module_velocity.step_revision ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION bump_step_revision()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    NEW.step_revision := COALESCE(OLD.step_revision, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_module_velocity_bump_revision ON module_velocity;
CREATE TRIGGER trg_module_velocity_bump_revision
  BEFORE UPDATE ON module_velocity
  FOR EACH ROW EXECUTE FUNCTION bump_step_revision();
