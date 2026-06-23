-- Migration: 039_velocity_step
-- Description: Reference table for the 8 velocity workflow steps

CREATE TABLE IF NOT EXISTS velocity_step (
  step_name VARCHAR(50) PRIMARY KEY,
  step_label VARCHAR(100) NOT NULL,
  step_order INT NOT NULL UNIQUE
);

INSERT INTO velocity_step (step_name, step_label, step_order) VALUES
  ('requirements',     'Requirements',     1),
  ('planning',         'Planning',         2),
  ('architecture',     'Architecture',     3),
  ('prototyping',      'Prototyping',      4),
  ('development',      'Development',      5),
  ('user_testing',     'User Testing',     6),
  ('user_acceptance',  'User Acceptance',  7),
  ('deployment',       'Deployment',       8)
ON CONFLICT (step_name) DO NOTHING;
