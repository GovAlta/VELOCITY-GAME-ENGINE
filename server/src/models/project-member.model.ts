import { pool } from '../config/database';
import type { PoolClient } from 'pg';

export type MemberRole = 'owner' | 'collaborator';

export interface ProjectMemberRecord {
  pk_project_member: string;
  fk_pm_project: string;
  fk_pm_user: string;
  member_role: MemberRole;
  added_by: string | null;
  added_at: string;
  removed_at: string | null;
  removed_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectMemberWithUser extends ProjectMemberRecord {
  user_email_address: string;
  user_display_name: string;
  avatar_url: string | null;
}

const SELECT_WITH_USER = `
  SELECT pm.*,
         ua.user_email_address,
         ua.user_display_name,
         ua.avatar_url
    FROM project_member pm
    JOIN user_account ua ON ua.pk_user_account = pm.fk_pm_user
`;

export async function listActiveMembers(projectId: string): Promise<ProjectMemberWithUser[]> {
  const result = await pool.query<ProjectMemberWithUser>(
    `${SELECT_WITH_USER} WHERE pm.fk_pm_project = $1 AND pm.is_active = true ORDER BY pm.member_role, pm.added_at`,
    [projectId],
  );
  return result.rows;
}

export async function listAllMembersIncludingHistory(projectId: string): Promise<ProjectMemberWithUser[]> {
  const result = await pool.query<ProjectMemberWithUser>(
    `${SELECT_WITH_USER} WHERE pm.fk_pm_project = $1 ORDER BY pm.is_active DESC, pm.added_at`,
    [projectId],
  );
  return result.rows;
}

export async function findActiveMembership(
  projectId: string,
  userId: string,
): Promise<ProjectMemberRecord | null> {
  const result = await pool.query<ProjectMemberRecord>(
    `SELECT * FROM project_member
      WHERE fk_pm_project = $1 AND fk_pm_user = $2 AND is_active = true
      LIMIT 1`,
    [projectId, userId],
  );
  return result.rows[0] ?? null;
}

export async function countActiveMembers(projectId: string): Promise<number> {
  const result = await pool.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM project_member WHERE fk_pm_project = $1 AND is_active = true`,
    [projectId],
  );
  return result.rows[0]?.c ?? 0;
}

export async function countActiveOwners(projectId: string, executor: PoolClient | typeof pool = pool): Promise<number> {
  const result = await executor.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM project_member
      WHERE fk_pm_project = $1 AND is_active = true AND member_role = 'owner'`,
    [projectId],
  );
  return result.rows[0]?.c ?? 0;
}

export async function addMember(
  projectId: string,
  userId: string,
  role: MemberRole,
  addedBy: string,
  executor: PoolClient | typeof pool = pool,
): Promise<ProjectMemberRecord> {
  const result = await executor.query<ProjectMemberRecord>(
    `INSERT INTO project_member (fk_pm_project, fk_pm_user, member_role, added_by)
       VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [projectId, userId, role, addedBy],
  );
  return result.rows[0];
}

export async function deactivateMember(
  membershipId: string,
  removedBy: string,
  executor: PoolClient | typeof pool = pool,
): Promise<ProjectMemberRecord | null> {
  const result = await executor.query<ProjectMemberRecord>(
    `UPDATE project_member
        SET is_active = false, removed_at = NOW(), removed_by = $2
      WHERE pk_project_member = $1 AND is_active = true
      RETURNING *`,
    [membershipId, removedBy],
  );
  return result.rows[0] ?? null;
}

export async function changeRole(
  membershipId: string,
  newRole: MemberRole,
  executor: PoolClient | typeof pool = pool,
): Promise<ProjectMemberRecord | null> {
  const result = await executor.query<ProjectMemberRecord>(
    `UPDATE project_member SET member_role = $2 WHERE pk_project_member = $1 AND is_active = true RETURNING *`,
    [membershipId, newRole],
  );
  return result.rows[0] ?? null;
}
