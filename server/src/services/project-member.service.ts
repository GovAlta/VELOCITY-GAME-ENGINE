import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import { logAuditEvent } from '../utils/audit-logger';
import { velocityStreamManager } from '../sse/velocity-stream';
import * as memberModel from '../models/project-member.model';
import type { MemberRole, ProjectMemberWithUser } from '../models/project-member.model';

/**
 * Membership invariant: a CLAIMED project (≥1 active member) must always
 * have ≥1 active OWNER. Removing/demoting the last owner without simultaneously
 * promoting another member is rejected. To "open" a claimed project, the last
 * owner must explicitly remove themselves last (and we accept it — the project
 * becomes open and any runner+ can take it again).
 */

interface AuditMeta {
  ipAddress?: string;
  authSource?: string;
  apiKeyId?: string;
}

function enrich(meta: AuditMeta | undefined, body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    _authSource: meta?.authSource || 'session',
    ...(meta?.apiKeyId ? { _apiKeyId: meta.apiKeyId } : {}),
  };
}

export async function listMembers(projectId: string): Promise<ProjectMemberWithUser[]> {
  return memberModel.listActiveMembers(projectId);
}

export async function listMemberHistory(projectId: string): Promise<ProjectMemberWithUser[]> {
  return memberModel.listAllMembersIncludingHistory(projectId);
}

export async function addMember(
  projectId: string,
  targetUserId: string,
  role: MemberRole,
  addedBy: string,
  meta?: AuditMeta,
): Promise<ProjectMemberWithUser> {
  // Block double-add
  const existing = await memberModel.findActiveMembership(projectId, targetUserId);
  if (existing) {
    throw AppError.conflict('User is already an active member of this project');
  }

  // Validate target user exists & is active
  const userCheck = await pool.query<{ user_display_name: string }>(
    `SELECT user_display_name FROM user_account WHERE pk_user_account = $1 AND is_deleted = false`,
    [targetUserId],
  );
  if (userCheck.rows.length === 0) {
    throw AppError.notFound('Target user not found');
  }

  const inserted = await memberModel.addMember(projectId, targetUserId, role, addedBy);

  await logAuditEvent({
    action: 'INSERT',
    tableName: 'project_member',
    recordId: inserted.pk_project_member,
    userId: addedBy,
    ipAddress: meta?.ipAddress,
    newData: enrich(meta, {
      _projectId: projectId,
      target_user_id: targetUserId,
      member_role: role,
    }),
  });

  velocityStreamManager.broadcast('member_added', {
    projectId,
    userId: targetUserId,
    userDisplayName: userCheck.rows[0].user_display_name,
    role,
    addedBy,
  });

  // Return full with-user record
  const all = await memberModel.listActiveMembers(projectId);
  return all.find(m => m.pk_project_member === inserted.pk_project_member)!;
}

export async function removeMember(
  projectId: string,
  membershipId: string,
  removedBy: string,
  meta?: AuditMeta,
): Promise<void> {
  // Find the membership being removed
  const all = await memberModel.listActiveMembers(projectId);
  const target = all.find(m => m.pk_project_member === membershipId);
  if (!target) {
    throw AppError.notFound('Membership not found or already removed');
  }

  // Owner-count invariant: if removing an owner, ensure another owner remains
  // (or accept that the project becomes open if removing the LAST member).
  if (target.member_role === 'owner') {
    const ownerCount = await memberModel.countActiveOwners(projectId);
    const totalCount = all.length;
    // If this owner is the last member overall, allow it (project becomes open)
    if (ownerCount === 1 && totalCount > 1) {
      throw new AppError(
        'Cannot remove the last owner while collaborators remain. Promote another member first or remove all members.',
        409,
        'LAST_OWNER',
      );
    }
  }

  const removed = await memberModel.deactivateMember(membershipId, removedBy);
  if (!removed) {
    throw AppError.notFound('Membership not found or already removed');
  }

  await logAuditEvent({
    action: 'DELETE',
    tableName: 'project_member',
    recordId: membershipId,
    userId: removedBy,
    ipAddress: meta?.ipAddress,
    oldData: enrich(meta, {
      _projectId: projectId,
      target_user_id: target.fk_pm_user,
      member_role: target.member_role,
    }),
  });

  velocityStreamManager.broadcast('member_removed', {
    projectId,
    userId: target.fk_pm_user,
    userDisplayName: target.user_display_name,
    role: target.member_role,
    removedBy,
  });
}

export async function changeRole(
  projectId: string,
  membershipId: string,
  newRole: MemberRole,
  changedBy: string,
  meta?: AuditMeta,
): Promise<ProjectMemberWithUser> {
  const all = await memberModel.listActiveMembers(projectId);
  const target = all.find(m => m.pk_project_member === membershipId);
  if (!target) throw AppError.notFound('Membership not found');

  if (target.member_role === newRole) {
    return target; // no-op
  }

  // Owner invariant: demoting the last owner is rejected unless someone else
  // is being promoted simultaneously (use transferOwnership for that).
  if (target.member_role === 'owner' && newRole === 'collaborator') {
    const ownerCount = await memberModel.countActiveOwners(projectId);
    if (ownerCount === 1) {
      throw new AppError(
        'Cannot demote the last owner. Use transfer-ownership instead.',
        409,
        'LAST_OWNER',
      );
    }
  }

  const updated = await memberModel.changeRole(membershipId, newRole);
  if (!updated) throw AppError.notFound('Membership not found');

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project_member',
    recordId: membershipId,
    userId: changedBy,
    ipAddress: meta?.ipAddress,
    oldData: enrich(meta, { _projectId: projectId, member_role: target.member_role }),
    newData: enrich(meta, { _projectId: projectId, member_role: newRole }),
  });

  velocityStreamManager.broadcast('member_role_changed', {
    projectId,
    userId: target.fk_pm_user,
    userDisplayName: target.user_display_name,
    fromRole: target.member_role,
    toRole: newRole,
    changedBy,
  });

  return { ...target, member_role: newRole };
}

export async function transferOwnership(
  projectId: string,
  toUserId: string,
  byUser: string,
  meta?: AuditMeta,
): Promise<void> {
  const all = await memberModel.listActiveMembers(projectId);
  const sourceOwner = all.find(m => m.fk_pm_user === byUser && m.member_role === 'owner');
  const target = all.find(m => m.fk_pm_user === toUserId);

  if (!sourceOwner) {
    throw new AppError('You are not an owner of this project', 403, 'OWNER_REQUIRED');
  }
  if (!target) {
    throw AppError.notFound('Target user is not a member of this project — add them first');
  }
  if (target.member_role === 'owner') {
    throw AppError.conflict('Target is already an owner');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await memberModel.changeRole(target.pk_project_member, 'owner', client);
    // Optional: demote the transferring owner. Decision: keep them as collaborator.
    await memberModel.changeRole(sourceOwner.pk_project_member, 'collaborator', client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project_member',
    recordId: target.pk_project_member,
    userId: byUser,
    ipAddress: meta?.ipAddress,
    oldData: enrich(meta, { _projectId: projectId, owner: byUser }),
    newData: enrich(meta, { _projectId: projectId, owner: toUserId, transferred_from: byUser }),
  });

  velocityStreamManager.broadcast('ownership_transferred', {
    projectId,
    fromUserId: byUser,
    toUserId,
    transferredBy: byUser,
  });
}

/**
 * Bootstrap a project's membership: called when someone direct-claims a parent
 * project or completes a clone. Adds the user as the inaugural owner.
 */
export async function bootstrapOwner(
  projectId: string,
  userId: string,
  meta?: AuditMeta,
): Promise<void> {
  const existing = await memberModel.findActiveMembership(projectId, userId);
  if (existing) return; // idempotent

  const inserted = await memberModel.addMember(projectId, userId, 'owner', userId);

  await logAuditEvent({
    action: 'INSERT',
    tableName: 'project_member',
    recordId: inserted.pk_project_member,
    userId,
    ipAddress: meta?.ipAddress,
    newData: enrich(meta, {
      _projectId: projectId,
      target_user_id: userId,
      member_role: 'owner',
      bootstrap: true,
    }),
  });
}
