import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const STEP_NAMES = [
  'requirements',
  'planning',
  'architecture',
  'prototyping',
  'development',
  'user_testing',
  'user_acceptance',
  'deployment',
] as const;

const STATUSES = [
  'not_started',
  'ready_to_start',
  'ai_working',
  'human_working',
  'ai_review',
  'human_review',
  'completed',
  'blocked',
] as const;

// ---------------------------------------------------------------------------
// Param Schemas
// ---------------------------------------------------------------------------

export const projectIdParam = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

export const moduleIdParam = z.object({
  moduleId: z.string().uuid('Invalid module ID'),
});

export const moduleStepParam = z.object({
  moduleId: z.string().uuid('Invalid module ID'),
  stepName: z.enum(STEP_NAMES),
});

// ---------------------------------------------------------------------------
// Body Schemas
// ---------------------------------------------------------------------------

export const makeMoveBody = z.object({
  status: z.enum(STATUSES),
  actor: z.enum(['human', 'ai']).optional(),
  content: z.string().max(10000).optional(),
  contentJson: z.record(z.unknown()).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        url: z.string(),
        type: z.string().optional(),
      })
    )
    .optional(),
});

export const addNoteBody = z.object({
  content: z.string().min(1).max(10000),
  actor: z.enum(['human', 'ai']).default('human'),
  contentJson: z.record(z.unknown()).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        url: z.string(),
        type: z.string().optional(),
      })
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Query Schemas
// ---------------------------------------------------------------------------

export const toggleLockBody = z.object({
  locked: z.boolean(),
});

export const sendBackBody = z.object({
  targetStep: z.enum(STEP_NAMES),
  content: z.string().max(10000).optional(),
  actor: z.enum(['human', 'ai']).default('human'),
});

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
