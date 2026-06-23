ALTER TABLE project_audit DROP CONSTRAINT IF EXISTS project_audit_audit_source_check;
ALTER TABLE project_audit ADD CONSTRAINT project_audit_audit_source_check
  CHECK (audit_source IN ('git', 'jira', 'confluence', 'sharepoint', 'web', 'manual', 'ai_analysis', 'deep-audit'));
