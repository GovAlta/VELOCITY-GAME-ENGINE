-- External links for projects (GitHub, Confluence, Jira, SharePoint — arrays of links)
CREATE TABLE IF NOT EXISTS project_link (
  pk_project_link UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_project_link_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  link_type VARCHAR(50) NOT NULL
    CHECK (link_type IN ('github', 'confluence', 'jira', 'sharepoint', 'other')),
  link_url TEXT NOT NULL,
  link_label VARCHAR(255),
  link_description TEXT,
  link_pat_encrypted TEXT,  -- Encrypted PAT for GitHub/Jira API access
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account)
);

CREATE TRIGGER trg_project_link_set_updated_at
  BEFORE UPDATE ON project_link
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_project_link_project ON project_link (fk_project_link_project);
CREATE INDEX IF NOT EXISTS idx_project_link_type ON project_link (link_type);
