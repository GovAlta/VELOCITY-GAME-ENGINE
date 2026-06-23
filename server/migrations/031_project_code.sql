-- Human-readable project code (e.g. PRJ-0001, or user-defined like DMND0001234)
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_code VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_code ON project (project_code) WHERE project_code IS NOT NULL AND is_deleted = false;
