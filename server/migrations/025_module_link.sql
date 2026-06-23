-- External links for modules (same structure as project links)
CREATE TABLE IF NOT EXISTS module_link (
  pk_module_link UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_module_link_module UUID NOT NULL REFERENCES module(pk_module) ON DELETE CASCADE,
  link_type VARCHAR(50) NOT NULL
    CHECK (link_type IN ('github', 'confluence', 'jira', 'sharepoint', 'other')),
  link_url TEXT NOT NULL,
  link_label VARCHAR(255),
  link_description TEXT,
  link_pat_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account)
);

CREATE TRIGGER trg_module_link_set_updated_at
  BEFORE UPDATE ON module_link
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_module_link_module ON module_link (fk_module_link_module);
