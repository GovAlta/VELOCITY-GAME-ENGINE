import { z } from 'zod';

// ---------------------------------------------------------------------------
// Git extraction
// ---------------------------------------------------------------------------

export const extractBodySchema = z.object({
  repoUrl: z.string().url('Must be a valid URL').refine(
    (url) => /github\.com/.test(url),
    { message: 'Must be a GitHub URL' }
  ),
  branch: z.string().trim().max(200).optional(),
  maxCommits: z.coerce.number().int().min(1).max(50000).optional(),
  since: z.string().trim().refine(
    (val) => !val || !isNaN(Date.parse(val)),
    { message: 'Must be a valid date string' }
  ).optional(),
});

export const repoParamsSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
});

export const filePathSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
  path: z.string().max(500).optional().default(''),
});

export const commitBodySchema = z.object({
  branch: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(500),
  content: z.string().min(0),
  message: z.string().trim().min(1).max(500),
});

export const prBodySchema = z.object({
  head: z.string().trim().min(1).max(200),
  base: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  body: z.string().max(10000).optional(),
});

export const branchBodySchema = z.object({
  branchName: z.string().trim().min(1).max(200),
  fromSha: z.string().trim().min(7).max(40),
});

// ---------------------------------------------------------------------------
// Audit schemas
// ---------------------------------------------------------------------------

export const auditListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(['github', 'azure-devops', 'manual']).optional(),
});

export const auditIdSchema = z.object({
  id: z.string().uuid('Invalid project ID'),
  auditId: z.string().uuid('Invalid audit ID'),
});

export const runAuditBodySchema = z.object({
  source: z.enum(['git', 'jira', 'confluence', 'sharepoint', 'web', 'manual']),
  sourceUrl: z.string().url('Must be a valid URL'),
  moduleId: z.string().uuid().optional(),
  branch: z.string().trim().max(200).optional(),
  maxCommits: z.coerce.number().int().min(1).max(50000).optional(),
  since: z.string().trim().refine(
    (val) => !val || !isNaN(Date.parse(val)),
    { message: 'Must be a valid date string' }
  ).optional(),
});

export const runLlmBodySchema = z.object({
  provider: z.enum(['claude', 'gemini', 'grok']),
  model: z.string().max(100).optional(),
  prompt: z.string().max(5000).optional(),
});

// ---------------------------------------------------------------------------
// Deep Audit schemas
// ---------------------------------------------------------------------------

export const runDeepAuditBodySchema = z.object({
  sourceUrl: z.string().url('Must be a valid URL'),
  branch: z.string().trim().max(200).optional(),
  maxFiles: z.coerce.number().int().min(10).max(500).default(200),
  maxContentKB: z.coerce.number().int().min(100).max(2000).default(500),
  provider: z.enum(['claude', 'gemini', 'grok']).default('claude'),
  model: z.string().max(100).optional(),
});

export const deepAuditIdSchema = z.object({
  id: z.string().uuid(),
  auditId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Settings schemas
// ---------------------------------------------------------------------------

export const savePatBodySchema = z.object({
  pat: z.string().min(1, 'PAT is required').max(500),
});
