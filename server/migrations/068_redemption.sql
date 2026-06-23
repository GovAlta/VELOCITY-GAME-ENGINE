-- Migration: 068_redemption
-- Description:
--   Adds a 'redemption' source to user_points. Redemption is the inverse
--   counterpart to the Reaper: an admin-invoked action that writes a
--   positive user_points row for every user whose total is currently
--   negative, exactly large enough to bring them to zero.
--
--   The cheating_violation history is intentionally preserved — the
--   Violations column on the leaderboard remains populated as a public
--   record of which rules the user was caught violating. Redemption
--   forgives the score, not the audit trail.
--
--   Each row has source='redemption' so the leaderboard view's existing
--   per-source FILTER aggregations don't double-count it as a velocity
--   or bonus earning. A new redemption_points column on the MV exposes
--   the running total of forgiven points.

ALTER TABLE user_points DROP CONSTRAINT IF EXISTS user_points_source_check;
ALTER TABLE user_points ADD CONSTRAINT user_points_source_check
  CHECK (source IN (
    'velocity_step', 'velocity_bonus', 'velocity_penalty',
    'challenge_complete', 'challenge_bonus', 'manual',
    'cheating_penalty', 'redemption'
  ));

-- Rebuild the leaderboard view with a redemption_points column so the
-- UI can show "you were forgiven N points" alongside the existing
-- cheating_penalty_points column.
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
  COALESCE(SUM(up.points) FILTER (WHERE up.source = 'redemption'), 0) AS redemption_points,
  COUNT(DISTINCT up.fk_up_module) FILTER (WHERE up.source = 'velocity_step') AS modules_completed,
  COUNT(DISTINCT up.fk_up_project) FILTER (WHERE up.source = 'challenge_complete') AS challenges_completed,
  COUNT(DISTINCT up.fk_up_project) AS projects_touched,
  COALESCE(cv.violations_count, 0) AS violations_count
FROM user_account ua
LEFT JOIN user_points up ON up.fk_up_user = ua.pk_user_account
LEFT JOIN (
  SELECT fk_cv_user, COUNT(*) AS violations_count
    FROM cheating_violation
   GROUP BY fk_cv_user
) cv ON cv.fk_cv_user = ua.pk_user_account
WHERE ua.is_deleted = false AND ua.is_active = true
GROUP BY ua.pk_user_account, cv.violations_count;

CREATE UNIQUE INDEX leaderboard_user_id_idx ON leaderboard (user_id);
CREATE INDEX leaderboard_total_points_idx ON leaderboard (total_points DESC);

-- Recreate the refresh function (DROP MV invalidated any prior reference).
CREATE OR REPLACE FUNCTION refresh_leaderboard() RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard;
EXCEPTION WHEN OTHERS THEN
  -- CONCURRENTLY requires the unique index AND a non-empty MV. On first
  -- refresh of a brand-new MV, fall back to non-concurrent.
  REFRESH MATERIALIZED VIEW leaderboard;
END;
$$ LANGUAGE plpgsql;

-- Populate immediately so the view is queryable.
DO $$ BEGIN PERFORM refresh_leaderboard(); EXCEPTION WHEN OTHERS THEN NULL; END $$;
