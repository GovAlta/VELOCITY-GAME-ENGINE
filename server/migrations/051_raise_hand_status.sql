-- Migration: 051_raise_hand_status
-- Description: Add 'hand_raised' status for "Raise Hand" feature and add
--   'raise_hand' / 'lower_hand' turn actions. hand_raised is a soft status
--   that doesn't block or incur penalties — it's a visual signal that help is wanted.

-- 1. Expand the module_velocity status CHECK to include 'hand_raised'
ALTER TABLE module_velocity DROP CONSTRAINT IF EXISTS module_velocity_status_check;
ALTER TABLE module_velocity ADD CONSTRAINT module_velocity_status_check
  CHECK (status IN (
    'not_started', 'ready_to_start',
    'ai_working', 'human_working',
    'ai_review', 'human_review',
    'completed', 'blocked', 'hand_raised'
  ));

-- 2. Expand the turn action CHECK to include raise_hand / lower_hand
ALTER TABLE velocity_turn DROP CONSTRAINT IF EXISTS velocity_turn_turn_action_check;
ALTER TABLE velocity_turn ADD CONSTRAINT velocity_turn_turn_action_check
  CHECK (turn_action IN (
    'start', 'pass', 'review', 'approve', 'reject',
    'complete', 'block', 'unblock', 'note', 'send_back',
    'transition', 'raise_hand', 'lower_hand'
  ));
