-- Migration: 065_reaper_v2_rules
-- Description:
--   Extends the Reaper's violation_type CHECK constraint to include three
--   new rules surfaced by audit of high-volume offenders:
--
--     empty_content  — completed step where the user's turns are
--                      overwhelmingly empty (median <1 char, or >80%
--                      under 50 chars). Catches farming with no actual
--                      work product.
--     burst_turns    — user submitted >=3 turns within 5s on the same
--                      step. Bot/script signal — humans don't sustain
--                      sub-second click rates.
--     self_approval  — same user both submitted (review/pass) AND
--                      approved (approve) on the same step. The chess-
--                      clock model assumes the reviewer is a different
--                      actor; rubber-stamping your own submission
--                      defeats the integrity check.

ALTER TABLE cheating_violation DROP CONSTRAINT IF EXISTS cheating_violation_violation_type_check;
ALTER TABLE cheating_violation ADD CONSTRAINT cheating_violation_violation_type_check
  CHECK (violation_type IN (
    'speed_run',
    'no_artifact',
    'no_collaboration',
    'blank_module',
    'project_module_overflow',
    'empty_content',
    'burst_turns',
    'self_approval'
  ));
