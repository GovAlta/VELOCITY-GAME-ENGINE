-- Migration: 052_sharepoint_folders
-- Description: Track SharePoint folder mappings for projects, modules, and velocity steps

CREATE TABLE IF NOT EXISTS sharepoint_folder (
  pk_sharepoint_folder UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_sf_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_sf_module UUID REFERENCES module(pk_module) ON DELETE CASCADE,
  fk_sf_velocity_step UUID REFERENCES module_velocity(pk_module_velocity) ON DELETE CASCADE,
  sp_site_id VARCHAR(255) NOT NULL,
  sp_drive_id VARCHAR(255) NOT NULL,
  sp_folder_id VARCHAR(255) NOT NULL,
  sp_folder_path TEXT NOT NULL,
  sp_web_url TEXT,
  folder_type VARCHAR(20) NOT NULL CHECK (folder_type IN ('project', 'module', 'step', 'audit')),
  sync_status VARCHAR(20) DEFAULT 'active' CHECK (sync_status IN ('active', 'orphaned', 'error')),
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_sharepoint_folder_set_updated_at
  BEFORE UPDATE ON sharepoint_folder
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_sf_project ON sharepoint_folder (fk_sf_project);
CREATE INDEX idx_sf_module ON sharepoint_folder (fk_sf_module) WHERE fk_sf_module IS NOT NULL;
CREATE INDEX idx_sf_step ON sharepoint_folder (fk_sf_velocity_step) WHERE fk_sf_velocity_step IS NOT NULL;
CREATE INDEX idx_sf_sp_folder_id ON sharepoint_folder (sp_folder_id);

-- Expand audit_source CHECK to include 'sharepoint-content'
ALTER TABLE project_audit DROP CONSTRAINT IF EXISTS project_audit_audit_source_check;
ALTER TABLE project_audit ADD CONSTRAINT project_audit_audit_source_check
  CHECK (audit_source IN ('git', 'jira', 'confluence', 'sharepoint', 'sharepoint-content', 'web', 'manual', 'ai_analysis', 'deep-audit'));
