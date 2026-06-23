-- Migration: 067_reaper_reset_empty_content
-- Description:
--   A short-lived experiment lowered EMPTY_CONTENT_MIN_TURNS from 3 to 1 to
--   try to catch high-volume offenders who spread empty turns across many
--   steps. The change fired on legitimate users who had made a single short
--   turn on a step (e.g. "ok" approvals), producing 50+ false-positive
--   violations. MIN_TURNS has been restored to 3.
--
--   This migration wipes all empty_content findings and their paired
--   cheating_penalty rows so the next Reaper run starts from a clean slate
--   under the correct threshold. The unique indexes on
--   (user, scope, violation_type) mean re-detection is idempotent.

DELETE FROM user_points
 WHERE source = 'cheating_penalty'
   AND description LIKE 'Reaper: empty_content %';

DELETE FROM cheating_violation
 WHERE violation_type = 'empty_content';

DO $$
BEGIN
  PERFORM refresh_leaderboard();
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
