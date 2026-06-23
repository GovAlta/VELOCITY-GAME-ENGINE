-- Performance indexes for frequently queried FK columns and common query patterns

-- project_lead: JOINed on person for every project detail load (1262 rows)
CREATE INDEX IF NOT EXISTS idx_project_lead_person ON project_lead (fk_project_lead_person) WHERE fk_project_lead_person IS NOT NULL;

-- project_update: JOINed on user for every update listing
CREATE INDEX IF NOT EXISTS idx_project_update_user ON project_update (fk_project_update_user) WHERE fk_project_update_user IS NOT NULL;

-- project: composite for common list query (is_deleted + sort columns)
CREATE INDEX IF NOT EXISTS idx_project_active_name ON project (project_name) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_project_active_end_date ON project (project_end_date NULLS LAST) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_project_active_pct ON project (project_percent_complete NULLS LAST) WHERE is_deleted = false;

-- project: start_date for gantt/canvas queries
CREATE INDEX IF NOT EXISTS idx_project_start_date ON project (project_start_date) WHERE is_deleted = false;

-- audit_log: JSONB _projectId for sub-resource lookup after deletion
CREATE INDEX IF NOT EXISTS idx_audit_log_project_id ON audit_log ((new_data->>'_projectId')) WHERE new_data->>'_projectId' IS NOT NULL;

-- audit_log: created_at for pagination (if not already covering)
CREATE INDEX IF NOT EXISTS idx_audit_log_created_desc ON audit_log (created_at DESC);

-- project_duplicate: for duplicate page queries
CREATE INDEX IF NOT EXISTS idx_project_duplicate_similarity ON project_duplicate (duplicate_similarity DESC);

-- person: for the people directory sort
CREATE INDEX IF NOT EXISTS idx_person_is_fte ON person (person_is_fte);

-- module: composite for project detail load
CREATE INDEX IF NOT EXISTS idx_module_project_active ON module (fk_module_project, module_sort_order) WHERE is_deleted = false;
