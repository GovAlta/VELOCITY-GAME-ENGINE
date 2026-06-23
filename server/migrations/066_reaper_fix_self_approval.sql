-- Migration: 066_reaper_fix_self_approval
-- Description:
--   The first self_approval rule (added in 065) grouped by turn_user_id,
--   which falsely flagged the LEGITIMATE pattern of a human approving
--   their own AI agent's work (an agent is the user's delegate; the
--   human reviewing the agent's output is intentional design).
--
--   The actual cheating pattern is an AI agent both submitting AND
--   approving its OWN work using the same API key (turn_actor='ai' on
--   both sides). The fix tightens the detector to that case; this
--   migration scrubs the over-eager findings produced by the old rule
--   so a re-run starts clean.

-- 1. Remove the paired cheating_penalty user_points rows. We identify
--    them by their auto-generated description prefix, which the Reaper
--    service writes as: "Reaper: self_approval (original ...)".
DELETE FROM user_points
 WHERE source = 'cheating_penalty'
   AND description LIKE 'Reaper: self_approval %';

-- 2. Remove the cheating_violation rows themselves. The unique indexes
--    on (user, scope, type) mean the next Reaper run starting from a
--    clean slate will only re-flag genuine AI-self-approval cases.
DELETE FROM cheating_violation
 WHERE violation_type = 'self_approval';

-- 3. Refresh the materialized leaderboard so the inflated penalties
--    don't linger in the UI between the migration applying and the next
--    Reaper run. Tolerate failure (e.g. on a clean dev DB without prior
--    Reaper runs).
DO $$
BEGIN
  PERFORM refresh_leaderboard();
EXCEPTION WHEN OTHERS THEN
  -- function may not exist on a brand-new DB, that's fine
  NULL;
END $$;
