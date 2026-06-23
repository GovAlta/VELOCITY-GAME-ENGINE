-- Migration: 041_velocity_turn
-- Description: Chess-clock turn history for human-AI collaboration on velocity steps

CREATE TABLE IF NOT EXISTS velocity_turn (
  pk_velocity_turn UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_turn_module_velocity UUID NOT NULL REFERENCES module_velocity(pk_module_velocity) ON DELETE CASCADE,
  fk_turn_module UUID NOT NULL REFERENCES module(pk_module) ON DELETE CASCADE,
  fk_turn_project UUID NOT NULL REFERENCES project(pk_project) ON DELETE CASCADE,
  turn_actor VARCHAR(20) NOT NULL CHECK (turn_actor IN ('human', 'ai')),
  turn_action VARCHAR(50) NOT NULL
    CHECK (turn_action IN (
      'start', 'pass', 'review', 'approve', 'reject',
      'complete', 'block', 'unblock', 'note'
    )),
  turn_from_status VARCHAR(50),
  turn_to_status VARCHAR(50),
  turn_content TEXT,
  turn_content_json JSONB,
  turn_attachments JSONB DEFAULT '[]'::jsonb,
  turn_user_id UUID REFERENCES user_account(pk_user_account),
  turn_api_key_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vt_module_velocity ON velocity_turn (fk_turn_module_velocity);
CREATE INDEX IF NOT EXISTS idx_vt_module ON velocity_turn (fk_turn_module);
CREATE INDEX IF NOT EXISTS idx_vt_project ON velocity_turn (fk_turn_project);
CREATE INDEX IF NOT EXISTS idx_vt_created_desc ON velocity_turn (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vt_module_step ON velocity_turn (fk_turn_module, fk_turn_module_velocity);
