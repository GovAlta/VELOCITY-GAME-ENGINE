-- Migration: 061_revisions_and_idempotency
-- Description: Optimistic-concurrency revision counters + idempotency-key storage
--   for safe multi-agent collaboration on the velocity board.
--
-- The core problem: two agents (or human + agent) attempting moves on the
-- same step simultaneously must produce a deterministic winner without
-- corrupting state. We solve this with two cooperative mechanisms:
--
--   1. Revision counters (optimistic concurrency):
--        - project.project_revision    bumped on every project mutation
--        - module_velocity.step_revision bumped on every velocity status change
--      Clients read the current value, send it back via If-Match on writes.
--      Server compares; mismatch returns 412 Precondition Failed and the
--      client must re-fetch + decide whether to retry.
--
--   2. Idempotency keys:
--        - velocity_idempotency stores (key, request_hash → cached response)
--      Agents include Idempotency-Key: <uuid> on retries; the server replays
--      the cached response within a 24h TTL. Different request body with the
--      same key returns 422 IDEMPOTENCY_KEY_REUSED so retries can't change
--      semantics. A nightly cleanup keeps the table small.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Revision counters
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE project ADD COLUMN IF NOT EXISTS project_revision INT NOT NULL DEFAULT 1;

ALTER TABLE module_velocity ADD COLUMN IF NOT EXISTS step_revision INT NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Idempotency-key storage
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS velocity_idempotency (
  idempotency_key      UUID PRIMARY KEY,
  fk_user              UUID REFERENCES user_account(pk_user_account) ON DELETE SET NULL,
  fk_api_key           UUID REFERENCES api_key(pk_api_key) ON DELETE SET NULL,
  request_method       VARCHAR(10) NOT NULL,
  request_path         VARCHAR(500) NOT NULL,
  request_hash         VARCHAR(64)  NOT NULL,
  response_status      INT          NOT NULL,
  response_body        JSONB        NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at           TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

-- Drain index for the cleanup cron.
CREATE INDEX IF NOT EXISTS idx_velocity_idempotency_expires
  ON velocity_idempotency (expires_at);

-- Per-user lookup (debugging / dashboard).
CREATE INDEX IF NOT EXISTS idx_velocity_idempotency_user
  ON velocity_idempotency (fk_user, created_at DESC)
  WHERE fk_user IS NOT NULL;
