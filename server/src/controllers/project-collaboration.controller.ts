import { Request, Response } from 'express';
import * as collabService from '../services/project-collaboration.service';
import * as memberService from '../services/project-member.service';
import {
  computePermissions,
  requireProjectWrite,
  requireProjectOwner,
  requireAdmin,
} from '../utils/project-permissions';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/app-error';

function setAuth(req: Request) {
  const source = (req as any)._authSource || 'session';
  const apiKeyId = (req as any)._apiKeyId;
  collabService.setAuthContext(source, apiKeyId);
}

// ─── Clone ───────────────────────────────────────────────────────────────────

export async function clone(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const sourceId = req.params.id as string;
  const user = req.user!;

  // Permission: source must be readable + clone-policy allows + role gate.
  // Service double-checks clone_disabled in a transaction for race safety.
  const perms = await computePermissions(sourceId, user);
  if (!perms.canClone) {
    throw new AppError('Cloning is disabled for this project', 403, 'CLONE_DISABLED');
  }
  // Anyone authenticated with runner+ may clone any cloneable, top-level project.
  const userRoles = user.roles || [user.role];
  if (!userRoles.includes('admin') && !userRoles.includes('runner') && !userRoles.includes('project_lead')) {
    throw AppError.forbidden('Cloning requires runner, project_lead, or admin role');
  }

  const newProject = await collabService.cloneProject(
    sourceId,
    user.id,
    {
      versionLabel: req.body?.versionLabel ?? null,
      copyLinks:    req.body?.copyLinks,
      copyBudgets:  req.body?.copyBudgets,
    },
    { ipAddress: req.ip ?? undefined },
  );
  sendSuccess(res, newProject, 201);
}

// ─── Cluster / Versions ──────────────────────────────────────────────────────

export async function getCluster(req: Request, res: Response): Promise<void> {
  const cluster = await collabService.getCluster(req.params.id as string);
  sendSuccess(res, cluster);
}

export async function listVersions(req: Request, res: Response): Promise<void> {
  const cluster = await collabService.getCluster(req.params.id as string);
  // Flat list — same as cluster.versions but the dedicated endpoint stays
  // useful for clients that want only the array.
  sendSuccess(res, cluster.versions);
}

// ─── Version label ───────────────────────────────────────────────────────────

export async function renameVersion(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;
  await requireProjectOwner(projectId, req.user!);
  const result = await collabService.renameVersion(
    projectId,
    req.body?.label ?? null,
    req.user!.id,
    { ipAddress: req.ip ?? undefined },
  );
  sendSuccess(res, result);
}

// ─── Lock / Unlock ───────────────────────────────────────────────────────────

export async function lock(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;
  await requireProjectOwner(projectId, req.user!);
  const result = await collabService.acquireLock(
    projectId,
    req.user!.id,
    req.body?.reason,
    { ipAddress: req.ip ?? undefined },
  );
  sendSuccess(res, result);
}

export async function unlock(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;
  const force = !!req.body?.force;
  const userRoles = req.user!.roles || [req.user!.role];
  const isAdmin = userRoles.includes('admin');

  if (!isAdmin) {
    // Non-admin path: must be the locker (owner) themselves.
    await requireProjectOwner(projectId, req.user!);
  }

  await collabService.releaseLock(
    projectId,
    req.user!.id,
    isAdmin,
    force,
    { ipAddress: req.ip ?? undefined },
  );
  res.status(204).end();
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function listMembers(req: Request, res: Response): Promise<void> {
  const members = await memberService.listMembers(req.params.id as string);
  sendSuccess(res, members);
}

export async function listMemberHistory(req: Request, res: Response): Promise<void> {
  const members = await memberService.listMemberHistory(req.params.id as string);
  sendSuccess(res, members);
}

export async function addMember(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;

  // Special bootstrap rule: if the project has zero active members and the
  // requester has runner+, they may add themselves as the first owner — this
  // is the "direct claim" path. Otherwise, only existing owners can add members.
  const perms = await computePermissions(projectId, req.user!);
  const targetUserId = req.body.userId as string;
  const isSelfAddOnOpenProject =
    perms.isOpen
    && targetUserId === req.user!.id;

  if (!isSelfAddOnOpenProject && !perms.isOwner && !perms.isAdmin) {
    throw new AppError('Only project owners can add members', 403, 'OWNER_REQUIRED');
  }

  const role = req.body.role || (perms.isOpen && targetUserId === req.user!.id ? 'owner' : 'collaborator');

  const member = await memberService.addMember(
    projectId,
    targetUserId,
    role,
    req.user!.id,
    { ipAddress: req.ip ?? undefined, authSource: (req as any)._authSource, apiKeyId: (req as any)._apiKeyId },
  );
  sendSuccess(res, member, 201);
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;
  const membershipId = req.params.membershipId as string;

  const perms = await computePermissions(projectId, req.user!);
  // Anyone removing themselves is allowed; otherwise must be owner or admin.
  // We need the membership to know whose it is — fetch via the service.
  const members = await memberService.listMembers(projectId);
  const target = members.find(m => m.pk_project_member === membershipId);
  if (!target) throw AppError.notFound('Membership not found');
  const isSelfRemoval = target.fk_pm_user === req.user!.id;

  if (!isSelfRemoval && !perms.isOwner && !perms.isAdmin) {
    throw new AppError('Only owners can remove other members', 403, 'OWNER_REQUIRED');
  }

  await memberService.removeMember(
    projectId,
    membershipId,
    req.user!.id,
    { ipAddress: req.ip ?? undefined, authSource: (req as any)._authSource, apiKeyId: (req as any)._apiKeyId },
  );
  res.status(204).end();
}

export async function patchMemberRole(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;
  await requireProjectOwner(projectId, req.user!);
  const updated = await memberService.changeRole(
    projectId,
    req.params.membershipId as string,
    req.body.role,
    req.user!.id,
    { ipAddress: req.ip ?? undefined, authSource: (req as any)._authSource, apiKeyId: (req as any)._apiKeyId },
  );
  sendSuccess(res, updated);
}

export async function transferOwnership(req: Request, res: Response): Promise<void> {
  setAuth(req);
  const projectId = req.params.id as string;
  await requireProjectOwner(projectId, req.user!);
  await memberService.transferOwnership(
    projectId,
    req.body.toUserId,
    req.user!.id,
    { ipAddress: req.ip ?? undefined, authSource: (req as any)._authSource, apiKeyId: (req as any)._apiKeyId },
  );
  res.status(204).end();
}

// ─── Clone Policy (admin only) ───────────────────────────────────────────────

export async function setClonePolicy(req: Request, res: Response): Promise<void> {
  setAuth(req);
  requireAdmin(req.user!);
  const projectId = req.params.id as string;
  const result = await collabService.setClonePolicy(
    projectId,
    !!req.body.disabled,
    req.body.reason ?? null,
    req.user!.id,
    { ipAddress: req.ip ?? undefined },
  );
  sendSuccess(res, result);
}

// ─── Permission introspection (UI uses to render gates) ──────────────────────

export async function getPermissions(req: Request, res: Response): Promise<void> {
  const perms = await computePermissions(req.params.id as string, req.user!);
  sendSuccess(res, perms);
}
