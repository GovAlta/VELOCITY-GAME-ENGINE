/**
 * Concurrency e2e — verifies the optimistic-concurrency triggers and the
 * idempotency-key storage behave correctly against the real database.
 *
 *   - project_revision auto-bumps on every UPDATE
 *   - module_velocity.step_revision auto-bumps on every UPDATE
 *   - velocity_idempotency stores + retrieves cached responses
 *   - velocity_idempotency rejects key reuse with different body hash
 *   - velocity_idempotency cleanup deletes expired rows
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/database';
import { cleanupExpiredIdempotency } from '../../middleware/idempotency';
import crypto from 'crypto';

const tag = `concurrency-test-${Date.now()}`;
let ministryId: string;
let projectId: string;
let userId: string;
let moduleId: string;

beforeAll(async () => {
  const m = await pool.query(
    `INSERT INTO ministry (ministry_code, ministry_name) VALUES ($1, $2) RETURNING pk_ministry`,
    [`CON${Date.now() % 1000}`, `${tag}-ministry`],
  );
  ministryId = m.rows[0].pk_ministry;

  const u = await pool.query(
    `INSERT INTO user_account (
       user_email_address, user_display_name, sso_provider_name, sso_provider_id,
       user_role_name, is_active
     ) VALUES ($1, $2, 'pending', $3, 'admin', true) RETURNING pk_user_account`,
    [`concurrency-${tag}@test.example.com`, 'Concurrency Tester', `${tag}-user`],
  );
  userId = u.rows[0].pk_user_account;

  const p = await pool.query(
    `INSERT INTO project (fk_project_ministry, project_name, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING pk_project`,
    [ministryId, `${tag}-project`, userId],
  );
  projectId = p.rows[0].pk_project;

  // Module triggers velocity-row creation (8 steps via DB trigger).
  const mod = await pool.query(
    `INSERT INTO module (fk_module_project, module_name, created_by, updated_by)
     VALUES ($1, 'M1', $2, $2) RETURNING pk_module`,
    [projectId, userId],
  );
  moduleId = mod.rows[0].pk_module;
});

afterAll(async () => {
  await pool.query(`DELETE FROM velocity_idempotency WHERE fk_user = $1`, [userId]);
  await pool.query(`DELETE FROM project WHERE fk_project_ministry = $1`, [ministryId]);
  await pool.query(`DELETE FROM ministry WHERE pk_ministry = $1`, [ministryId]);
  await pool.query(`UPDATE audit_log SET user_id = NULL WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM user_account WHERE pk_user_account = $1`, [userId]);
});

describe('Concurrency — project_revision trigger', () => {
  it('starts at 1 on insert', async () => {
    const { rows } = await pool.query(
      `SELECT project_revision FROM project WHERE pk_project = $1`,
      [projectId],
    );
    expect(rows[0].project_revision).toBe(1);
  });

  it('bumps to 2 on first UPDATE', async () => {
    await pool.query(
      `UPDATE project SET project_description = 'rev-test-1' WHERE pk_project = $1`,
      [projectId],
    );
    const { rows } = await pool.query(
      `SELECT project_revision FROM project WHERE pk_project = $1`,
      [projectId],
    );
    expect(rows[0].project_revision).toBe(2);
  });

  it('keeps incrementing on subsequent UPDATEs', async () => {
    await pool.query(
      `UPDATE project SET project_description = 'rev-test-2' WHERE pk_project = $1`,
      [projectId],
    );
    await pool.query(
      `UPDATE project SET project_description = 'rev-test-3' WHERE pk_project = $1`,
      [projectId],
    );
    const { rows } = await pool.query(
      `SELECT project_revision FROM project WHERE pk_project = $1`,
      [projectId],
    );
    expect(rows[0].project_revision).toBe(4);
  });

  it('explicit assignment in UPDATE is overridden by trigger', async () => {
    // Trigger uses OLD.project_revision + 1 regardless of NEW value supplied.
    await pool.query(
      `UPDATE project SET project_revision = 999, project_description = 'override-attempt' WHERE pk_project = $1`,
      [projectId],
    );
    const { rows } = await pool.query(
      `SELECT project_revision FROM project WHERE pk_project = $1`,
      [projectId],
    );
    expect(rows[0].project_revision).toBe(5); // 4 + 1, NOT 999
  });
});

describe('Concurrency — step_revision trigger', () => {
  it('starts at 0 on the auto-initialized rows', async () => {
    const { rows } = await pool.query(
      `SELECT step_revision FROM module_velocity WHERE fk_mv_module = $1 AND step_name = 'requirements'`,
      [moduleId],
    );
    expect(rows[0].step_revision).toBe(0);
  });

  it('bumps on UPDATE of any column', async () => {
    await pool.query(
      `UPDATE module_velocity SET status = 'ready_to_start' WHERE fk_mv_module = $1 AND step_name = 'requirements'`,
      [moduleId],
    );
    const { rows } = await pool.query(
      `SELECT step_revision FROM module_velocity WHERE fk_mv_module = $1 AND step_name = 'requirements'`,
      [moduleId],
    );
    expect(rows[0].step_revision).toBe(1);
  });
});

describe('Concurrency — velocity_idempotency storage', () => {
  const key1 = crypto.randomUUID();
  const key2 = crypto.randomUUID();
  const key3 = crypto.randomUUID();

  it('stores a (key, hash, body) row', async () => {
    await pool.query(
      `INSERT INTO velocity_idempotency
         (idempotency_key, fk_user, request_method, request_path, request_hash,
          response_status, response_body)
       VALUES ($1, $2, 'PUT', '/api/v1/velocity/...', $3, 200, $4)`,
      [key1, userId, 'hash-A', JSON.stringify({ ok: true })],
    );
    const { rows } = await pool.query(
      `SELECT request_hash, response_status, response_body FROM velocity_idempotency WHERE idempotency_key = $1`,
      [key1],
    );
    expect(rows[0].request_hash).toBe('hash-A');
    expect(rows[0].response_status).toBe(200);
    expect(rows[0].response_body).toEqual({ ok: true });
  });

  it('rejects duplicate primary key (would surface as IDEMPOTENCY_KEY_REUSED in middleware)', async () => {
    let err: any;
    try {
      await pool.query(
        `INSERT INTO velocity_idempotency
           (idempotency_key, fk_user, request_method, request_path, request_hash,
            response_status, response_body)
         VALUES ($1, $2, 'PUT', '/api/v1/velocity/...', $3, 200, $4)`,
        [key1, userId, 'hash-different', JSON.stringify({ ok: false })],
      );
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(String(err.code)).toBe('23505'); // PG unique violation
  });

  it('cleanup removes only expired rows', async () => {
    // Fresh row — expires_at default is NOW() + 24h.
    await pool.query(
      `INSERT INTO velocity_idempotency
         (idempotency_key, fk_user, request_method, request_path, request_hash,
          response_status, response_body)
       VALUES ($1, $2, 'POST', '/x', 'h', 201, '{}'::jsonb)`,
      [key2, userId],
    );
    // Pre-expired row.
    await pool.query(
      `INSERT INTO velocity_idempotency
         (idempotency_key, fk_user, request_method, request_path, request_hash,
          response_status, response_body, expires_at)
       VALUES ($1, $2, 'POST', '/x', 'h', 201, '{}'::jsonb, NOW() - INTERVAL '1 hour')`,
      [key3, userId],
    );

    const removed = await cleanupExpiredIdempotency();
    expect(removed).toBeGreaterThanOrEqual(1);

    const { rows: stillThere } = await pool.query(
      `SELECT idempotency_key FROM velocity_idempotency WHERE idempotency_key = $1`,
      [key2],
    );
    expect(stillThere.length).toBe(1);

    const { rows: gone } = await pool.query(
      `SELECT idempotency_key FROM velocity_idempotency WHERE idempotency_key = $1`,
      [key3],
    );
    expect(gone.length).toBe(0);
  });
});
