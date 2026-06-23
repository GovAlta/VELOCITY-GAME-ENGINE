-- Migration: 060_collaboration
-- Description: Multi-user collaboration on projects.
--   * project_member         — membership (owner, collaborator) per project
--   * project lineage cols   — single-level clone parent + provenance + version label
--   * project lock cols      — owner can pause writes for everyone except themselves
--   * project clone-policy   — admin can disable cloning of a specific project
--
-- Design decisions (locked in via planning conversation 2026-05-06):
--   • Single-level cloning only — clones cannot themselves be cloned.
--     Enforced at the service layer for clearer error messages (CLONE_OF_CLONE).
--   • ON DELETE SET NULL on fk_project_parent — deleting a parent does NOT
--     cascade-delete clones; provenance is preserved via project_cloned_from_name.
--   • Member roles: owner, collaborator. (Viewer skipped for v1; non-members
--     can already see public reads.)
--   • Project lock is owner-self-locked — only project_locked_by (or admin) can
--     mutate. Other co-owners become read-only until unlocked.
--   • Clone policy is admin-only. Admins are NOT exempt from CLONE_DISABLED —
--     they must enable cloning, clone, then re-disable to keep audit clean.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Lineage / version columns on project
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE project ADD COLUMN IF NOT EXISTS fk_project_parent UUID
  REFERENCES project(pk_project) ON DELETE SET NULL;

ALTER TABLE project ADD COLUMN IF NOT EXISTS project_cloned_from_name VARCHAR(500);
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_version_label    VARCHAR(200);
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_cloned_at        TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_cloned_by
  UUID REFERENCES user_account(pk_user_account);

-- Cluster lookup: get parent + all clones efficiently.
CREATE INDEX IF NOT EXISTS idx_project_parent
  ON project (fk_project_parent)
  WHERE fk_project_parent IS NOT NULL AND is_deleted = false;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Lock columns on project
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE project ADD COLUMN IF NOT EXISTS project_is_locked    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_locked_by
  UUID REFERENCES user_account(pk_user_account);
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_locked_at    TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_lock_reason  TEXT;

CREATE INDEX IF NOT EXISTS idx_project_locked
  ON project (project_locked_by)
  WHERE project_is_locked = true;

-- Invariant: when locked, locked_by and locked_at must be set.
ALTER TABLE project DROP CONSTRAINT IF EXISTS chk_project_lock_consistency;
ALTER TABLE project ADD CONSTRAINT chk_project_lock_consistency CHECK (
  project_is_locked = false
  OR (project_locked_by IS NOT NULL AND project_locked_at IS NOT NULL)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Clone-policy columns on project (admin-controlled)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE project ADD COLUMN IF NOT EXISTS project_clone_disabled        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_clone_disabled_by
  UUID REFERENCES user_account(pk_user_account);
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_clone_disabled_at     TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_clone_disabled_reason TEXT;

-- Invariant: when clone is disabled, _by and _at must be set.
ALTER TABLE project DROP CONSTRAINT IF EXISTS chk_project_clone_policy_consistency;
ALTER TABLE project ADD CONSTRAINT chk_project_clone_policy_consistency CHECK (
  project_clone_disabled = false
  OR (project_clone_disabled_by IS NOT NULL AND project_clone_disabled_at IS NOT NULL)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. project_member — multi-user membership
-- ═══════════════════════════════════════════════════════════════════════════
-- A project with zero ACTIVE members is "open" — any runner+ can edit.
-- A project with ≥1 active member is "claimed" — only members can edit
-- (subject to system role gate). Project_member rows are soft-removed (kept
-- for the historical record of who participated).

CREATE TABLE IF NOT EXISTS project_member (
  pk_project_member  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_pm_project      UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  fk_pm_user         UUID NOT NULL REFERENCES user_account(pk_user_account) ON DELETE CASCADE,
  member_role        VARCHAR(20) NOT NULL DEFAULT 'collaborator'
    CHECK (member_role IN ('owner', 'collaborator')),
  added_by           UUID REFERENCES user_account(pk_user_account),
  added_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at         TIMESTAMPTZ,
  removed_by         UUID REFERENCES user_account(pk_user_account),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_project_member_set_updated_at
  BEFORE UPDATE ON project_member
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Active membership uniqueness: a user can have at most one ACTIVE membership
-- per project. Reactivating after removal creates a new row (different role
-- or new added_by attribution).
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_member_active
  ON project_member (fk_pm_project, fk_pm_user)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pm_user_active
  ON project_member (fk_pm_user)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pm_project_active
  ON project_member (fk_pm_project)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_pm_role_active
  ON project_member (fk_pm_project, member_role)
  WHERE is_active = true;
