-- Migration: 044_velocity_step_lock
-- Description: Add lock flag to velocity steps to prevent send-back

ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false;
