-- Multi-fiscal-year budgets with funding sources and money types
CREATE TABLE IF NOT EXISTS project_budget (
  pk_project_budget UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_project_budget_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  budget_fiscal_year VARCHAR(10) NOT NULL,  -- e.g. 'FY25-26', 'FY26-27'
  budget_funding_source VARCHAR(50) NOT NULL
    CHECK (budget_funding_source IN ('TI', 'Ministry', 'Mixed', 'Federal', 'Other')),
  budget_money_type VARCHAR(50) NOT NULL
    CHECK (budget_money_type IN ('Salary', 'Operating', 'Capital')),
  budget_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  budget_spent NUMERIC(15,2) NOT NULL DEFAULT 0,
  budget_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES user_account(pk_user_account),
  updated_by UUID REFERENCES user_account(pk_user_account)
);

CREATE TRIGGER trg_project_budget_set_updated_at
  BEFORE UPDATE ON project_budget
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_project_budget_project ON project_budget (fk_project_budget_project);
CREATE INDEX IF NOT EXISTS idx_project_budget_fy ON project_budget (budget_fiscal_year);
