-- Migration: 037_mission_critical
-- Description: Add mission critical flag to projects and modules

ALTER TABLE project ADD COLUMN IF NOT EXISTS project_is_mission_critical BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE module ADD COLUMN IF NOT EXISTS module_is_mission_critical BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_project_mission_critical
  ON project (project_is_mission_critical) WHERE project_is_mission_critical = true;
CREATE INDEX IF NOT EXISTS idx_module_mission_critical
  ON module (module_is_mission_critical) WHERE module_is_mission_critical = true;
