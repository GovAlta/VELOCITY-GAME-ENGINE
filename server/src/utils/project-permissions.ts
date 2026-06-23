import { pool } from '../config/database';
import { AppError } from './app-error';
import type { AuthUser } from '../types/auth';
import * as memberModel from '../models/project-member.model';

/**
 * Computed permission state for an authenticated user against a single project.
 *
 * Source of truth for every project-write decision. Combines:
 *   1. System role gate         — runner/project_lead/admin can act on open projects
 *   2. Membership gate          — claimed projects require membership (or admin)
 *   3. Lock state               — locked projects allow only the locker (or admin)
 *
 * Public reads do not pass through this helper — anyone can GET a project.
 */
export interface ProjectPermissionState {
  projectId: string;
  isOpen: boolean;          // no active members
  isClaimed: boolean;       // ≥1 active member
  isLocked: boolean;
  lockedBy: string | null;
  isMember: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  cloneDisabled: boolean;
  // Derived gates
  canRead: boolean;
  canWriteProject: boolean;        // edit core fields, modules, sub-resources
  canMakeVelocityMoves: boolean;   // velocity moves, notes, send-back
  canManageMembers: boolean;       // add/remove members, transfer ownership
  canRename: boolean;              // version label rename
  canToggleLock: boolean;          // own lock acquire/release (admin can force)
  canTogglePolicy: boolean;        // clone-policy toggle (admin only)
  canClone: boolean;               // gated by clone_disabled + clone-of-clone
}

interface ProjectGateRow {
  pk_project: string;
  is_deleted: boolean;
  fk_project_parent: string | null;
  project_is_locked: boolean;
  project_locked_by: string | null;
  project_clone_disabled: boolean;
}

async function loadProject(projectId: string): Promise<ProjectGateRow | null> {
  const result = await pool.query<ProjectGateRow>(
    `SELECT pk_project, is_deleted, fk_project_parent,
            project_is_locked, project_locked_by, project_clone_disabled
       FROM project WHERE pk_project = $1`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

function userHasRole(user: AuthUser, ...roles: string[]): boolean {
  const userRoles = user.roles || [user.role];
  return roles.some(r => userRoles.includes(r as any));
}

export async function computePermissions(
  projectId: string,
  user: AuthUser,
): Promise<ProjectPermissionState> {
  const project = await loadProject(projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.is_deleted) throw AppError.notFound('Project not found');

  const isAdmin = userHasRole(user, 'admin');
  const activeMemberCount = await memberModel.countActiveMembers(projectId);
  const isOpen = activeMemberCount === 0;
  const isClaimed = !isOpen;

  let isMember = false;
  let isOwner = false;
  if (!isOpen) {
    const membership = await memberModel.findActiveMembership(projectId, user.id);
    if (membership) {
      isMember = true;
      isOwner = membership.member_role === 'owner';
    }
  }

  const isLocked = project.project_is_locked;
  const lockedBy = project.project_locked_by;
  const lockerIsSelf = lockedBy === user.id;

  // Read is universal.
  const canRead = true;

  // System role gate for non-admins.
  const hasWriteRole = isAdmin || userHasRole(user, 'runner', 'project_lead');

  // Open projects: any runner+ can edit. Claimed projects: must be member or admin.
  const passesMembershipGate = isAdmin || isOpen || isMember;

  // Lock gate: when locked, only the locker (or admin) can write.
  const passesLockGate = !isLocked || isAdmin || lockerIsSelf;

  const canWriteProject = hasWriteRole && passesMembershipGate && passesLockGate;
  // Velocity moves use a stricter gate than canWriteProject: admin does NOT
  // bypass membership here. Rationale: admins are platform operators, not
  // players. They should be able to administer the system (manage members,
  // force-release locks, toggle policy, delete projects) without silently
  // hijacking another player's turn in an active game. An admin who needs to
  // act in-game can add themselves as a member first (auditable) and then play
  // like everyone else. Lock-bypass is retained for admin because a stuck lock
  // is a platform incident, not a game move.
  const passesVelocityMembershipGate = isOpen || isMember;
  const canMakeVelocityMoves = hasWriteRole && passesVelocityMembershipGate && passesLockGate;

  const canManageMembers = isAdmin || isOwner;
  const canRename = isAdmin || isOwner;
  // Lock-acquire: any owner. Lock-release: own lock OR admin force.
  const canToggleLock = isAdmin || isOwner;
  const canTogglePolicy = isAdmin;

  // Clone gate: clone_disabled blocks everyone (admins included — re-enable to clone).
  // Clone-of-clone is blocked at the service layer with a separate code.
  const canClone = !project.project_clone_disabled;

  return {
    projectId,
    isOpen,
    isClaimed,
    isLocked,
    lockedBy,
    isMember,
    isOwner,
    isAdmin,
    cloneDisabled: project.project_clone_disabled,
    canRead,
    canWriteProject,
    canMakeVelocityMoves,
    canManageMembers,
    canRename,
    canToggleLock,
    canTogglePolicy,
    canClone,
  };
}

/**
 * Throw 403 with an actionable error code if the user cannot write to this project.
 * Used as a single guard at the top of every write controller.
 */
export async function requireProjectWrite(projectId: string, user: AuthUser): Promise<ProjectPermissionState> {
  const perms = await computePermissions(projectId, user);
  if (!perms.canWriteProject) {
    if (perms.isLocked && !perms.isAdmin && perms.lockedBy !== user.id) {
      throw new AppError(
        `Project is locked by another user`,
        423,
        'PROJECT_LOCKED',
      );
    }
    if (perms.isClaimed && !perms.isMember && !perms.isAdmin) {
      throw new AppError(
        `Only project members can edit this claimed project`,
        403,
        'NOT_A_MEMBER',
      );
    }
    throw AppError.forbidden('Insufficient privileges to edit this project');
  }
  return perms;
}

/**
 * Throw 403 NOT_A_MEMBER / 423 PROJECT_LOCKED if the user cannot make a
 * velocity move on this project. Stricter than requireProjectWrite: admin
 * role does NOT bypass the membership gate here — admins must explicitly
 * add themselves as a member to play. (Lock-force-release bypass is
 * preserved because a stuck lock is a platform issue, not a game move.)
 */
export async function requireVelocityMove(projectId: string, user: AuthUser): Promise<ProjectPermissionState> {
  const perms = await computePermissions(projectId, user);
  if (!perms.canMakeVelocityMoves) {
    if (perms.isLocked && !perms.isAdmin && perms.lockedBy !== user.id) {
      throw new AppError(
        `Project is locked by another user`,
        423,
        'PROJECT_LOCKED',
      );
    }
    if (perms.isClaimed && !perms.isMember) {
      // Admin role does NOT exempt — different message so callers can
      // distinguish "add yourself" from "ask an existing member".
      throw new AppError(
        perms.isAdmin
          ? 'Admins cannot make velocity moves without being a project member. ' +
            'Add yourself as a member first (POST /projects/:id/members).'
          : 'Only project members can make velocity moves on this claimed project',
        403,
        'NOT_A_MEMBER',
      );
    }
    throw AppError.forbidden('Insufficient privileges to make velocity moves');
  }
  return perms;
}

/**
 * Throw if the user is not an owner (or admin) of this project.
 */
export async function requireProjectOwner(projectId: string, user: AuthUser): Promise<ProjectPermissionState> {
  const perms = await computePermissions(projectId, user);
  if (!perms.isAdmin && !perms.isOwner) {
    throw new AppError('Only project owners can perform this action', 403, 'OWNER_REQUIRED');
  }
  return perms;
}

/**
 * Throw if the user is not admin.
 */
export function requireAdmin(user: AuthUser): void {
  if (!userHasRole(user, 'admin')) {
    throw AppError.forbidden('Admin role required');
  }
}
