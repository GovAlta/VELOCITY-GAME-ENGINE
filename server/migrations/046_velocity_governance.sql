-- Migration: 046_velocity_governance
-- Description: AI authority gates, blocked escalation, step weights, alignment tracking

-- Step-level: require human sign-off (prevents AI self-approval)
ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS requires_human_approval BOOLEAN NOT NULL DEFAULT false;

-- Step-level: require AI recommendation before human can approve
ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS requires_ai_recommendation BOOLEAN NOT NULL DEFAULT false;

-- Step-level: complexity weight for scoring (1=simple, 2=standard, 3=complex)
ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS step_weight SMALLINT NOT NULL DEFAULT 1
  CHECK (step_weight BETWEEN 1 AND 3);

-- Blocked escalation fields
ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS blocked_since TIMESTAMPTZ;

-- Turn-level: track whether this turn represents alignment (both actors agree)
ALTER TABLE velocity_turn ADD COLUMN IF NOT EXISTS turn_is_aligned BOOLEAN;

-- Module-level: alignment tracking and outcome score
ALTER TABLE module_velocity_metrics ADD COLUMN IF NOT EXISTS alignment_count INT NOT NULL DEFAULT 0;
ALTER TABLE module_velocity_metrics ADD COLUMN IF NOT EXISTS misalignment_count INT NOT NULL DEFAULT 0;
ALTER TABLE module_velocity_metrics ADD COLUMN IF NOT EXISTS outcome_score SMALLINT CHECK (outcome_score IS NULL OR outcome_score BETWEEN 1 AND 5);

-- Set default governance: steps 1, 6, 7 require human approval
-- Steps 3 (architecture), 5 (development) require AI recommendation
UPDATE module_velocity SET requires_human_approval = true WHERE step_name IN ('requirements', 'user_testing', 'user_acceptance');
UPDATE module_velocity SET requires_ai_recommendation = true WHERE step_name IN ('architecture', 'development');
