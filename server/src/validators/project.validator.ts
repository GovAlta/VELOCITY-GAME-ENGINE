import { z } from 'zod';
import { optionalDate } from './common';

// ─── Project Schemas ──────────────────────────────────────

export const listProjectsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  search: z.string().trim().max(200).optional(),
  ministry: z.string().trim().optional(),
  status: z.string().trim().optional(),
  missionCritical: z.enum(['true', 'false']).optional(),
  sort: z
    .enum(['name', 'end_date', 'percent_complete', 'ministry', 'created_at'])
    .optional()
    .default('created_at'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const projectIdSchema = z.object({
  id: z.string().uuid('Invalid project ID'),
});

export const projectModuleIdSchema = z.object({
  id: z.string().uuid('Invalid project ID'),
  moduleId: z.string().uuid('Invalid module ID'),
});

export const projectBudgetIdSchema = z.object({
  id: z.string().uuid('Invalid project ID'),
  budgetId: z.string().uuid('Invalid budget ID'),
});

export const projectLinkIdSchema = z.object({
  id: z.string().uuid('Invalid project ID'),
  linkId: z.string().uuid('Invalid link ID'),
});

export const createProjectSchema = z.object({
  projectCode: z.string().trim().max(50).optional(),
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().optional(),
  ministryCode: z.string().trim().min(1).max(10),
  status: z
    .enum([
      'discovery', 'requirements', 'development', 'testing',
      'client_review', 'client_acceptance', 'completion',
      'on_hold', 'cancelled',
    ])
    .optional()
    .default('discovery'),
  startDate: optionalDate,
  endDate: optionalDate,
  goLiveDateType: z.enum(['legislative', 'mandated', 'announced', 'objective']).nullable().optional(),
  percentComplete: z.number().int().min(0).max(100).optional().default(0),
  priority: z.string().trim().max(50).optional(),
  scope: z.string().trim().optional(),
  category: z.string().trim().max(100).optional(),
  demandNumber: z.string().trim().max(100).optional(),
  ministryPriority: z.number().int().nullable().optional(),
  risk: z.string().trim().optional(),
  additionalInfo: z.string().trim().optional(),
  branch: z.string().trim().max(255).optional(),
  isMissionCritical: z.boolean().optional(),
  isChallenge: z.boolean().optional(),
  challengePoints: z.number().int().min(0).max(10000).optional(),
  challengeMaxDays: z.number().int().min(1).max(30).optional(),
  challengeDifficulty: z.enum(['easy', 'medium', 'hard', 'expert']).optional().nullable(),
  challengeMaxAcceptances: z.preprocess(
    v => (v === '' || v === null || v === undefined) ? null : (typeof v === 'string' ? Number(v) : v),
    z.number().int().min(1).max(1000).nullable().optional(),
  ),
});

// For updates: allow empty strings (controller coerces to null), all fields optional
export const updateProjectSchema = z.object({
  projectCode: z.string().trim().max(50).optional().nullable(),
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().optional(),
  ministryCode: z.string().trim().max(10).optional(),
  status: z.string().trim().optional(),
  startDate: optionalDate,
  endDate: optionalDate,
  goLiveDateType: z.string().optional().nullable(),
  percentComplete: z.number().int().min(0).max(100).optional().nullable(),
  priority: z.string().trim().optional(),
  scope: z.string().trim().optional(),
  category: z.string().trim().optional(),
  demandNumber: z.string().trim().optional(),
  ministryPriority: z.number().int().optional().nullable(),
  risk: z.string().trim().optional(),
  additionalInfo: z.string().trim().optional(),
  branch: z.string().trim().optional(),
  isMissionCritical: z.boolean().optional(),
}).passthrough();

// ─── Module Schemas ──────────────────────────────────────

export const createModuleSchema = z.object({
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().optional(),
  status: z
    .enum([
      'requirements_gathering', 'building', 'client_review',
      'client_sign_off', 'delivered', 'closed', 'cancelled',
    ])
    .optional()
    .default('requirements_gathering'),
  startDate: optionalDate,
  endDate: optionalDate,
  percentComplete: z.number().int().min(0).max(100).nullable().optional().default(0),
  sortOrder: z.number().int().min(0).nullable().optional().default(0),
  plan: z.string().trim().optional(),
  progress: z.string().trim().optional(),
  blockers: z.string().trim().optional(),
  complexity: z.number().min(0).max(10).optional(),
  isMissionCritical: z.boolean().optional(),
}).passthrough();

export const updateModuleSchema = createModuleSchema.partial();

// ─── Budget Schemas ──────────────────────────────────────

export const createBudgetSchema = z.object({
  fiscalYear: z.string().trim().min(1).max(20),
  fundingSource: z.enum(['TI', 'Ministry', 'Mixed', 'Federal', 'Other']),
  moneyType: z.enum(['Salary', 'Operating', 'Capital']),
  amount: z.number().min(0).nullable().optional().default(0),
  spent: z.number().min(0).nullable().optional().default(0),
  notes: z.string().trim().optional(),
}).passthrough();

export const updateBudgetSchema = createBudgetSchema.partial();

// ─── Link Schemas ──────────────────────────────────────

export const createLinkSchema = z.object({
  type: z.enum(['github', 'confluence', 'jira', 'sharepoint', 'other']),
  url: z.string().trim().min(1).max(2000).refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
      } catch { return false; }
    },
    { message: 'URL must be a valid http or https URL' }
  ),
  label: z.string().trim().max(255).optional(),
  description: z.string().trim().optional(),
}).passthrough();

// ─── Update Schemas ──────────────────────────────────────

export const createUpdateSchema = z.object({
  type: z
    .enum(['progress', 'blocker', 'plan', 'risk', 'decision', 'milestone', 'ai_summary', 'audit_result'])
    .optional()
    .default('progress'),
  title: z.string().trim().max(500).optional(),
  content: z.string().trim().min(1),
  contentJson: z.record(z.unknown()).optional(),
  moduleId: z.string().uuid().nullable().optional(),
  source: z
    .enum(['manual', 'api', 'ai_audit', 'github_webhook', 'jira_sync', 'confluence_sync'])
    .optional()
    .default('manual'),
}).passthrough();

export const listUpdatesQuerySchema = z.object({
  type: z.string().trim().optional(),
});

// ─── Ministry Schemas ──────────────────────────────────────

export const ministryCodeSchema = z.object({
  code: z.string().trim().min(1).max(10),
});

// ─── Application/Contract Link Schemas ──────────────────────────────────────

export const linkApplicationSchema = z.object({
  applicationId: z.string().uuid('Invalid application ID'),
  moduleId: z.string().uuid('Invalid module ID').optional().nullable(),
  relationshipType: z.enum(['replacing', 'dependency', 'integration', 'api', 'supports', 'other']).default('other'),
  description: z.string().trim().max(1000).optional(),
});

export const linkContractSchema = z.object({
  contractId: z.string().uuid('Invalid contract ID'),
  moduleId: z.string().uuid('Invalid module ID').optional().nullable(),
  relationshipType: z.enum(['funded_by', 'delivered_under', 'staffing', 'licensing', 'maintenance', 'infrastructure', 'consulting', 'other']).default('other'),
  description: z.string().trim().max(1000).optional(),
});

export const projectLinkEntityIdSchema = z.object({
  id: z.string().uuid('Invalid project ID'),
  linkId: z.string().uuid('Invalid link ID'),
});
