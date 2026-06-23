-- Migration: 063_challenge_acceptance
-- Description: Multi-acceptance + winner-pick workflow for challenges.
--
-- Background: Originally a challenge had a single `challenge_claimed_by` user
-- (one-claimer model). With v5.0 cloning, "accepting a challenge" really means
-- cloning the parent project — each clone is its own independent attempt.
-- This migration adds the metadata needed to manage that on the parent:
--
--   * `challenge_max_acceptances`  — NULL = unlimited; integer = first-come,
--     first-served cap on the number of clones that can be made.
--   * `challenge_closed_at`        — when the creator closes the challenge.
--     Closing also flips `project_clone_disabled = true` so no further clones.
--   * `challenge_winner_project`   — when the creator picks a winning clone.
--   * `challenge_winner_narrative` — optional explanation of why they won.
--   * `challenge_winner_picked_at` / `_by` — audit attribution.
--
-- The legacy `challenge_claimed_by` / `_at` fields stay for back-compat with
-- existing direct-claim flows; new acceptances populate them on the *clone*,
-- not the parent.

ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_max_acceptances    INTEGER;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_closed_at          TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_winner_project     UUID
  REFERENCES project(pk_project) ON DELETE SET NULL;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_winner_narrative   TEXT;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_winner_picked_at   TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_winner_picked_by   UUID
  REFERENCES user_account(pk_user_account);

-- Sanity: max_acceptances must be a positive integer when set.
ALTER TABLE project DROP CONSTRAINT IF EXISTS chk_challenge_max_acceptances_positive;
ALTER TABLE project ADD CONSTRAINT chk_challenge_max_acceptances_positive CHECK (
  challenge_max_acceptances IS NULL OR challenge_max_acceptances >= 1
);

-- Speed up "find acceptances" queries on parent challenges (already covered by
-- idx_project_parent in migration 060 but adding a tighter one for is_challenge=true).
CREATE INDEX IF NOT EXISTS idx_challenge_parent_acceptance
  ON project (fk_project_parent)
  WHERE fk_project_parent IS NOT NULL AND is_deleted = false;
