/**
 * Collaboration smoke tests.
 *
 * Exercises the project-collaboration service against the real database:
 *   - clone happy path (modules + links copied; cloner becomes owner)
 *   - clone-of-clone rejected (CLONE_OF_CLONE)
 *   - clone-disabled rejected (CLONE_DISABLED)
 *   - last-owner protection on member removal
 *   - lock acquire / self-release
 *   - admin force-unlock
 *
 * Uses a dedicated test ministry + 3 ad-hoc users + 1 test project. Cleans
 * up via fk_project_parent / fk_project_ministry on completion.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/database';
import * as collabService from '../../services/project-collaboration.service';
import * as memberService from '../../services/project-member.service';
import { AppError } from '../../utils/app-error';

interface TestCtx {
  ministryId: string;
  ownerUserId: string;
  collabUserId: string;
  adminUserId: string;
  rootProjectId: string;
}

const ctx = {} as TestCtx;
const tag = `collab-test-${Date.now()}`;

async function insertUser(email: string, role: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO user_account (
       user_email_address, user_display_name, sso_provider_name, sso_provider_id,
       user_role_name, is_active
     ) VALUES ($1, $2, 'pending', $3, $4, true)
     RETURNING pk_user_account`,
    [email, email.split('@')[0], `${tag}-${email}`, role],
  );
  const userId = r.rows[0].pk_user_account;
  // Also seed user_role junction so the multi-role checks in computePermissions resolve.
  await pool.query(
    `INSERT INTO user_role (fk_ur_user, role_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, role],
  );
  return userId;
}

beforeAll(async () => {
  // Ministry
  const m = await pool.query(
    `INSERT INTO ministry (ministry_code, ministry_name)
     VALUES ($1, $2) RETURNING pk_ministry`,
    [`COL${Date.now() % 1000}`, `${tag}-ministry`],
  );
  ctx.ministryId = m.rows[0].pk_ministry;

  ctx.ownerUserId  = await insertUser(`owner-${tag}@test.example.com`,  'project_lead');
  ctx.collabUserId = await insertUser(`collab-${tag}@test.example.com`, 'runner');
  ctx.adminUserId  = await insertUser(`admin-${tag}@test.example.com`,  'admin');

  // Root project (with one module + one link to verify clone copies)
  const p = await pool.query(
    `INSERT INTO project (
       fk_project_ministry, project_name, project_description,
       project_code, created_by, updated_by
     ) VALUES ($1, $2, 'Test source', $3, $4, $4)
     RETURNING pk_project`,
    [ctx.ministryId, `${tag}-source`, `${tag}-CODE-001`, ctx.ownerUserId],
  );
  ctx.rootProjectId = p.rows[0].pk_project;

  await pool.query(
    `INSERT INTO module (fk_module_project, module_name, created_by, updated_by)
     VALUES ($1, 'M1', $2, $2)`,
    [ctx.rootProjectId, ctx.ownerUserId],
  );
  await pool.query(
    `INSERT INTO project_link (fk_project_link_project, link_type, link_url, link_label)
     VALUES ($1, 'github', 'https://github.com/test/repo', 'Repo')`,
    [ctx.rootProjectId],
  );

  collabService.setAuthContext('session');
});

afterAll(async () => {
  const userIds = [ctx.ownerUserId, ctx.collabUserId, ctx.adminUserId];

  // Order matters: drop FK references to test users before deleting users.
  await pool.query(`DELETE FROM project_member WHERE added_by = ANY($1) OR removed_by = ANY($1) OR fk_pm_user = ANY($1)`, [userIds]);
  await pool.query(`DELETE FROM project WHERE fk_project_ministry = $1`, [ctx.ministryId]);
  await pool.query(`DELETE FROM ministry WHERE pk_ministry = $1`, [ctx.ministryId]);
  // audit_log has FK to user_account; null out instead of cascade-delete to keep history.
  await pool.query(`UPDATE audit_log SET user_id = NULL WHERE user_id = ANY($1)`, [userIds]);
  await pool.query(`DELETE FROM user_role WHERE fk_ur_user = ANY($1)`, [userIds]);
  await pool.query(`DELETE FROM user_account WHERE pk_user_account = ANY($1)`, [userIds]);
});

describe('Collaboration — Clone', () => {
  let cloneId: string;

  it('clones a top-level project, copying modules + links and making cloner an owner', async () => {
    const clone = await collabService.cloneProject(
      ctx.rootProjectId,
      ctx.collabUserId,
      { versionLabel: 'My attempt', copyLinks: true, copyBudgets: false },
    );
    expect(clone.pk_project).toBeDefined();
    expect(clone.project_code).toMatch(/-v1$/);
    cloneId = clone.pk_project;

    // Modules copied
    const mods = await pool.query(
      `SELECT module_name FROM module WHERE fk_module_project = $1 AND is_deleted = false`,
      [cloneId],
    );
    expect(mods.rows.map(r => r.module_name)).toContain('M1');

    // Links copied
    const links = await pool.query(
      `SELECT link_url FROM project_link WHERE fk_project_link_project = $1`,
      [cloneId],
    );
    expect(links.rows[0]?.link_url).toBe('https://github.com/test/repo');

    // Cloner is owner
    const members = await memberService.listMembers(cloneId);
    expect(members.length).toBe(1);
    expect(members[0].fk_pm_user).toBe(ctx.collabUserId);
    expect(members[0].member_role).toBe('owner');

    // Provenance preserved
    const proj = await pool.query(
      `SELECT fk_project_parent, project_cloned_from_name, project_version_label FROM project WHERE pk_project = $1`,
      [cloneId],
    );
    expect(proj.rows[0].fk_project_parent).toBe(ctx.rootProjectId);
    expect(proj.rows[0].project_cloned_from_name).toBe(`${tag}-source`);
    expect(proj.rows[0].project_version_label).toBe('My attempt');
  });

  it('rejects clone-of-clone with CLONE_OF_CLONE (422)', async () => {
    let err: AppError | undefined;
    try {
      await collabService.cloneProject(cloneId, ctx.ownerUserId, {});
    } catch (e) {
      err = e as AppError;
    }
    expect(err).toBeInstanceOf(AppError);
    expect(err?.code).toBe('CLONE_OF_CLONE');
    expect(err?.statusCode).toBe(422);
  });

  it('rejects clone when clone-policy is disabled (CLONE_DISABLED, 403)', async () => {
    await collabService.setClonePolicy(ctx.rootProjectId, true, 'gold-standard reference', ctx.adminUserId);

    let err: AppError | undefined;
    try {
      await collabService.cloneProject(ctx.rootProjectId, ctx.collabUserId, {});
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('CLONE_DISABLED');
    expect(err?.statusCode).toBe(403);

    // Re-enable
    await collabService.setClonePolicy(ctx.rootProjectId, false, null, ctx.adminUserId);
  });

  it('auto-suffixes -v2 on a second clone', async () => {
    const second = await collabService.cloneProject(ctx.rootProjectId, ctx.adminUserId, {});
    expect(second.project_code).toMatch(/-v2$/);
  });
});

describe('Collaboration — Members', () => {
  let memberProjectId: string;
  let collabMembershipId: string;

  beforeAll(async () => {
    // Fresh project for member tests
    const p = await pool.query(
      `INSERT INTO project (fk_project_ministry, project_name, created_by, updated_by)
       VALUES ($1, $2, $3, $3) RETURNING pk_project`,
      [ctx.ministryId, `${tag}-members`, ctx.ownerUserId],
    );
    memberProjectId = p.rows[0].pk_project;
    await memberService.bootstrapOwner(memberProjectId, ctx.ownerUserId);
  });

  it('owner can add a collaborator', async () => {
    const m = await memberService.addMember(memberProjectId, ctx.collabUserId, 'collaborator', ctx.ownerUserId);
    expect(m.member_role).toBe('collaborator');
    collabMembershipId = m.pk_project_member;
  });

  it('rejects removing the last owner while collaborators remain (LAST_OWNER, 409)', async () => {
    const members = await memberService.listMembers(memberProjectId);
    const ownerMembership = members.find(m => m.member_role === 'owner')!;

    let err: AppError | undefined;
    try {
      await memberService.removeMember(memberProjectId, ownerMembership.pk_project_member, ctx.ownerUserId);
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('LAST_OWNER');
    expect(err?.statusCode).toBe(409);
  });

  it('allows removing a collaborator', async () => {
    await memberService.removeMember(memberProjectId, collabMembershipId, ctx.ownerUserId);
    const remaining = await memberService.listMembers(memberProjectId);
    expect(remaining.find(m => m.fk_pm_user === ctx.collabUserId)).toBeUndefined();
  });

  it('allows removing the last owner once all collaborators are gone (project becomes open)', async () => {
    const members = await memberService.listMembers(memberProjectId);
    const ownerMembership = members.find(m => m.member_role === 'owner')!;
    await memberService.removeMember(memberProjectId, ownerMembership.pk_project_member, ctx.ownerUserId);
    const remaining = await memberService.listMembers(memberProjectId);
    expect(remaining.length).toBe(0);
  });
});

describe('Collaboration — Lock', () => {
  let lockProjectId: string;

  beforeAll(async () => {
    const p = await pool.query(
      `INSERT INTO project (fk_project_ministry, project_name, created_by, updated_by)
       VALUES ($1, $2, $3, $3) RETURNING pk_project`,
      [ctx.ministryId, `${tag}-locks`, ctx.ownerUserId],
    );
    lockProjectId = p.rows[0].pk_project;
    await memberService.bootstrapOwner(lockProjectId, ctx.ownerUserId);
  });

  it('owner acquires the lock', async () => {
    const r = await collabService.acquireLock(lockProjectId, ctx.ownerUserId, 'deep audit running');
    expect(r.project_is_locked).toBe(true);
    expect(r.project_locked_by).toBe(ctx.ownerUserId);
    expect(r.project_lock_reason).toBe('deep audit running');
  });

  it('blocks a second user trying to acquire the same lock (ALREADY_LOCKED, 409)', async () => {
    let err: AppError | undefined;
    try {
      await collabService.acquireLock(lockProjectId, ctx.collabUserId, 'I want it too');
    } catch (e) { err = e as AppError; }
    expect(err?.code).toBe('ALREADY_LOCKED');
    expect(err?.statusCode).toBe(409);
  });

  it('rejects non-locker unlock without admin force (LOCK_OWNED_BY_OTHER, 403)', async () => {
    let err: AppError | undefined;
    try {
      await collabService.releaseLock(lockProjectId, ctx.collabUserId, /*isAdmin=*/false, /*force=*/false);
    } catch (e) { err = e as AppError; }
    expect(err?.code).toBe('LOCK_OWNED_BY_OTHER');
  });

  it('admin force-unlock succeeds and writes a project_update', async () => {
    await collabService.releaseLock(lockProjectId, ctx.adminUserId, /*isAdmin=*/true, /*force=*/true);
    const { rows } = await pool.query(
      `SELECT project_is_locked FROM project WHERE pk_project = $1`,
      [lockProjectId],
    );
    expect(rows[0].project_is_locked).toBe(false);

    const updates = await pool.query(
      `SELECT update_title, update_type FROM project_update WHERE fk_project_update_project = $1`,
      [lockProjectId],
    );
    expect(updates.rows.find(r => r.update_title.includes('Lock force-released'))).toBeDefined();
  });

  it('owner self-unlock is idempotent on already-unlocked project', async () => {
    // Already unlocked — should be a no-op (no throw)
    await collabService.releaseLock(lockProjectId, ctx.ownerUserId, false, false);
  });
});
