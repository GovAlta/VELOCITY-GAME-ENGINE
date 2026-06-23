import { z } from 'zod';

const uuid = z.string().uuid('Must be a valid UUID');

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const projectIdParamSchema = z.object({
  id: uuid,
});

export const projectMembershipParamSchema = z.object({
  id: uuid,
  membershipId: uuid,
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const cloneProjectSchema = z.object({
  versionLabel: z.string().trim().min(1).max(200).nullable().optional(),
  copyLinks:    z.boolean().optional(),
  copyBudgets:  z.boolean().optional(),
});

export const renameVersionSchema = z.object({
  label: z.string().trim().max(200).nullable().optional()
    .transform(v => v === '' ? null : (v ?? null)),
});

export const memberAddSchema = z.object({
  userId: uuid,
  role:   z.enum(['owner', 'collaborator']).default('collaborator'),
});

export const memberPatchSchema = z.object({
  role: z.enum(['owner', 'collaborator']),
});

export const transferOwnershipSchema = z.object({
  toUserId: uuid,
});

export const lockSchema = z.object({
  reason: z.string().trim().max(2000).optional(),
});

export const unlockSchema = z.object({
  force: z.boolean().optional().default(false),
});

export const clonePolicySchema = z.object({
  disabled: z.boolean(),
  reason:   z.string().trim().max(2000).nullable().optional()
    .transform(v => v === '' ? null : (v ?? null)),
});
