-- Migration: 057_challenges_and_leaderboard
-- Description: Add Challenge fields to projects + user points tracking for leaderboard.

-- ═══ 1. Challenge fields on project table ═══
-- Challenges are just projects with is_challenge = true and extra metadata.

ALTER TABLE project ADD COLUMN IF NOT EXISTS project_is_challenge BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_points INTEGER DEFAULT 0;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_max_days INTEGER DEFAULT 5;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_claimed_by UUID REFERENCES user_account(pk_user_account);
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_claimed_at TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_completed_at TIMESTAMPTZ;
ALTER TABLE project ADD COLUMN IF NOT EXISTS challenge_difficulty VARCHAR(20) CHECK (challenge_difficulty IN ('easy', 'medium', 'hard', 'expert'));

CREATE INDEX IF NOT EXISTS idx_project_challenge ON project (project_is_challenge) WHERE project_is_challenge = true;
CREATE INDEX IF NOT EXISTS idx_project_challenge_claimed ON project (challenge_claimed_by) WHERE challenge_claimed_by IS NOT NULL;

-- ═══ 2. User points ledger ═══
-- Tracks every point event per user for auditability.
-- The leaderboard is computed by aggregating this table.

CREATE TABLE IF NOT EXISTS user_points (
  pk_user_points UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_up_user UUID NOT NULL REFERENCES user_account(pk_user_account) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  source VARCHAR(30) NOT NULL CHECK (source IN (
    'velocity_step',      -- completing a velocity step
    'velocity_bonus',     -- alignment, perfect run, approval bonuses
    'velocity_penalty',   -- rejection, send-back, blocked penalties
    'challenge_complete', -- completing a challenge
    'challenge_bonus',    -- extra challenge points
    'manual'              -- admin-granted points
  )),
  description TEXT,
  fk_up_project UUID REFERENCES project(pk_project),
  fk_up_module UUID REFERENCES module(pk_module),
  step_name VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_up_user ON user_points (fk_up_user);
CREATE INDEX idx_up_project ON user_points (fk_up_project) WHERE fk_up_project IS NOT NULL;
CREATE INDEX idx_up_created ON user_points (created_at DESC);

-- ═══ 3. Materialized leaderboard view ═══
-- Fast read for the leaderboard page. Refresh periodically or on-demand.

CREATE MATERIALIZED VIEW IF NOT EXISTS leaderboard AS
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
  COUNT(DISTINCT up.fk_up_module) FILTER (WHERE up.source = 'velocity_step') AS modules_completed,
  COUNT(DISTINCT up.fk_up_project) FILTER (WHERE up.source IN ('challenge_complete')) AS challenges_completed,
  COUNT(DISTINCT up.fk_up_project) AS projects_touched
FROM user_account ua
LEFT JOIN user_points up ON up.fk_up_user = ua.pk_user_account
WHERE ua.is_deleted = false AND ua.is_active = true
GROUP BY ua.pk_user_account;

CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_user ON leaderboard (user_id);

-- Function to refresh the leaderboard
CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard;
END;
$$ LANGUAGE plpgsql;
