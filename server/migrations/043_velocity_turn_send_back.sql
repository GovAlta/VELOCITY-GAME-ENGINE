-- Migration: 043_velocity_turn_send_back
-- Description: Add 'send_back' to velocity_turn action check constraint

ALTER TABLE velocity_turn DROP CONSTRAINT IF EXISTS velocity_turn_turn_action_check;
ALTER TABLE velocity_turn ADD CONSTRAINT velocity_turn_turn_action_check
  CHECK (turn_action IN (
    'start', 'pass', 'review', 'approve', 'reject',
    'complete', 'block', 'unblock', 'note', 'send_back'
  ));
