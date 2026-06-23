-- Enable trigram extension for fuzzy/typeahead search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Centralized person/resource table for lazy lookup
CREATE TABLE IF NOT EXISTS person (
  pk_person UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  person_display_name VARCHAR(255) NOT NULL,
  person_email VARCHAR(255),
  person_organization VARCHAR(255),
  person_is_fte BOOLEAN NOT NULL DEFAULT true,
  person_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_person_set_updated_at
  BEFORE UPDATE ON person
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_person_display_name ON person (person_display_name);
CREATE INDEX IF NOT EXISTS idx_person_name_search ON person USING gin (person_display_name gin_trgm_ops);

-- Upgrade project_lead to reference person table + add more roles
ALTER TABLE project_lead
  ADD COLUMN IF NOT EXISTS fk_project_lead_person UUID REFERENCES person(pk_person),
  ADD COLUMN IF NOT EXISTS lead_is_fte BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS lead_organization VARCHAR(255);

-- Drop old role CHECK and add expanded one
ALTER TABLE project_lead DROP CONSTRAINT IF EXISTS project_lead_lead_role_check;
ALTER TABLE project_lead ADD CONSTRAINT project_lead_lead_role_check
  CHECK (lead_role IN (
    'lead', 'delivery_director', 'delivery_manager',
    'developer', 'business_analyst', 'qa_tester', 'designer',
    'project_manager', 'product_owner', 'architect',
    'data_analyst', 'devops', 'scrum_master',
    'stakeholder', 'sponsor', 'team_member', 'other'
  ));
