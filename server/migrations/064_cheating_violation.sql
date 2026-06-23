-- Migration: 064_cheating_violation
-- Description:
--   Adds the Reaper subsystem — periodic admin-run audit that detects
--   cheating patterns (speed-running solo, no artifacts, no collaboration,
--   blank modules, project-module overflow) and inverts the points the
--   offending user earned.
--
--   Persists each detected violation as a separate row for diagnostics +
--   idempotency, and inserts a paired user_points row with source
--   'cheating_penalty' so the existing leaderboard aggregation naturally
--   reflects the deduction. Re-running the Reaper is safe: the unique
--   constraints below prevent double-flagging the same (user, target, type).
--
--   Leaderboard materialized view is rebuilt to expose violations_count and
--   cheating_penalty_points columns.

-- ─── 1. Violation ledger ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cheating_violation (
  pk_cheating_violation UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_cv_user            UUID NOT NULL REFERENCES user_account(pk_user_account) ON DELETE CASCADE,
  -- Scope: violation may attach to a specific step (most common), to a
  -- whole module (blank_module), or to a whole project (project_module_overflow).
  fk_cv_project         UUID REFERENCES project(pk_project) ON DELETE SET NULL,
  fk_cv_module          UUID REFERENCES module(pk_module) ON DELETE SET NULL,
  fk_cv_module_velocity UUID REFERENCES module_velocity(pk_module_velocity) ON DELETE SET NULL,
  violation_type        VARCHAR(40) NOT NULL CHECK (violation_type IN (
    'speed_run',                -- step completed with only AI turns, no human collaboration
    'no_artifact',              -- step completed with zero attachments across all its turns
    'no_collaboration',         -- step completed with only one distinct actor (superset of speed_run for humans)
    'blank_module',             -- module has completed steps but minimal turn content and metadata
    'project_module_overflow'   -- project has >= 10 modules (point-farming via padding)
  )),
  original_points       INTEGER NOT NULL,   -- the points the user originally earned (positive)
  inverted_points       INTEGER NOT NULL,   -- the deduction recorded (negative, typically -2 * original)
  evidence              JSONB,              -- diagnostic snapshot (turn counts, actor list, etc.)
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by           UUID REFERENCES user_account(pk_user_account)
);

CREATE INDEX IF NOT EXISTS idx_cv_user      ON cheating_violation (fk_cv_user);
CREATE INDEX IF NOT EXISTS idx_cv_project   ON cheating_violation (fk_cv_project) WHERE fk_cv_project IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cv_detected  ON cheating_violation (detected_at DESC);

-- Idempotency — don't double-flag the same (user, target, type)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cv_user_step_type    ON cheating_violation (fk_cv_user, fk_cv_module_velocity, violation_type)
  WHERE fk_cv_module_velocity IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cv_user_module_type  ON cheating_violation (fk_cv_user, fk_cv_module, violation_type)
  WHERE fk_cv_module IS NOT NULL AND fk_cv_module_velocity IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cv_user_project_type ON cheating_violation (fk_cv_user, fk_cv_project, violation_type)
  WHERE fk_cv_project IS NOT NULL AND fk_cv_module IS NULL;

-- ─── 2. Allow 'cheating_penalty' as a user_points source ────────────────
ALTER TABLE user_points DROP CONSTRAINT IF EXISTS user_points_source_check;
ALTER TABLE user_points ADD CONSTRAINT user_points_source_check
  CHECK (source IN (
    'velocity_step', 'velocity_bonus', 'velocity_penalty',
    'challenge_complete', 'challenge_bonus', 'manual',
    'cheating_penalty'
  ));

-- ─── 3. Rebuild leaderboard view with violations_count + cheating_penalty_points ───
DROP MATERIALIZED VIEW IF EXISTS leaderboard;
CREATE MATERIALIZED VIEW leaderboard AS
SELECT
  ua.pk_user_account AS user_id,
  ua.user_display_name,
  ua.user_email_address,
  ua.avatar_url,
  COALESCE(SUM(up.points), 0) AS total_points,
  COALESCE(SUM(up.points) FILTER (WHERE up.source = 'velocity_step'), 0) AS velocity_points,
  COALESCE(SUM(up.points) FILTER (WHERE up.source IN ('challenge_complete', 'challenge_bonus')), 0) AS challenge_points,
  COALESCE(SUM(up.points) FILTER (WHERE up.source = 'velocity_bonus'), 0) AS bonus_points,
  COALESCE(SUM(up.points) FILTER (WHERE up.source = 'velocity_penalty'), 0) AS penalty_points,
  COALESCE(SUM(up.points) FILTER (WHERE up.source = 'cheating_penalty'), 0) AS cheating_penalty_points,
  COUNT(DISTINCT up.fk_up_module) FILTER (WHERE up.source = 'velocity_step') AS modules_completed,
  COUNT(DISTINCT up.fk_up_project) FILTER (WHERE up.source IN ('challenge_complete')) AS challenges_completed,
  COUNT(DISTINCT up.fk_up_project) AS projects_touched,
  COALESCE((SELECT COUNT(*) FROM cheating_violation cv WHERE cv.fk_cv_user = ua.pk_user_account), 0)::int AS violations_count
FROM user_account ua
LEFT JOIN user_points up ON up.fk_up_user = ua.pk_user_account
WHERE ua.is_deleted = false AND ua.is_active = true
GROUP BY ua.pk_user_account;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_user ON leaderboard (user_id);

-- refresh_leaderboard() already exists from 057_challenges_and_leaderboard.sql
-- and works against the recreated view unchanged.
