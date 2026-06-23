-- Duplicate detection pairs
CREATE TABLE IF NOT EXISTS project_duplicate (
  pk_project_duplicate UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_duplicate_project_1 UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_duplicate_project_2 UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  duplicate_similarity NUMERIC(4,2) NOT NULL,
  duplicate_is_confirmed BOOLEAN,  -- null = unreviewed, true = confirmed dup, false = not dup
  duplicate_reviewed_by UUID REFERENCES user_account(pk_user_account),
  duplicate_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_duplicate_pair UNIQUE (fk_duplicate_project_1, fk_duplicate_project_2),
  CONSTRAINT chk_duplicate_order CHECK (fk_duplicate_project_1 < fk_duplicate_project_2)
);

CREATE INDEX IF NOT EXISTS idx_project_duplicate_p1 ON project_duplicate (fk_duplicate_project_1);
CREATE INDEX IF NOT EXISTS idx_project_duplicate_p2 ON project_duplicate (fk_duplicate_project_2);
