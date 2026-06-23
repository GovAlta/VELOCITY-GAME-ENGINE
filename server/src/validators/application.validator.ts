import { z } from 'zod';
import { optionalDate } from './common';

// ─── Application Schemas ──────────────────────────────────────

export const listApplicationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  search: z.string().trim().max(200).optional(),
  ministry: z.string().trim().optional(),
  installType: z.string().trim().optional(),
  dataClassification: z.string().trim().optional(),
  applicationType: z.string().trim().optional(),
  businessCriticality: z.string().trim().optional(),
  sort: z
    .enum([
      'application_name', 'application_type', 'application_install_type',
      'application_install_status', 'application_lifecycle_stage',
      'application_business_criticality', 'application_data_classification',
      'ministry_name', 'updated_at', 'created_at',
    ])
    .optional()
    .default('updated_at'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const applicationIdSchema = z.object({
  id: z.string().uuid('Invalid application ID'),
});

export const createApplicationSchema = z.object({
  name: z.string().trim().min(1).max(500),
  aliases: z.string().trim().optional(),
  description: z.string().trim().optional(),
  businessProcess: z.string().trim().optional(),
  ministryCode: z.string().trim().min(1).max(10).optional(),
  applicationType: z.string().trim().max(100).optional(),
  architectureType: z.string().trim().max(100).optional(),
  installType: z.string().trim().max(100).optional(),
  installStatus: z.string().trim().max(100).optional(),
  lifecycleStageStatus: z.string().trim().max(100).optional(),
  lifecycleStage: z.string().trim().max(100).optional(),
  technologyStack: z.string().trim().optional(),
  userBase: z.string().trim().max(50).optional(),
  platform: z.string().trim().max(200).optional(),
  lastChangeDate: optionalDate,
  businessOwner: z.string().trim().max(255).optional(),
  itOwner: z.string().trim().max(255).optional(),
  lastUpdatedBy: z.string().trim().max(255).optional(),
  businessCriticality: z.string().trim().max(50).optional(),
  emergencyTier: z.string().trim().max(50).optional(),
  dataClassification: z.string().trim().max(100).optional(),
  isCertified: z.boolean().optional().default(false),
  department: z.string().trim().max(255).optional(),
  source: z.string().trim().max(255).optional(),
});

// For updates: allow empty strings (controller coerces to null), all fields optional
export const updateApplicationSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  aliases: z.string().trim().optional().nullable(),
  description: z.string().trim().optional().nullable(),
  businessProcess: z.string().trim().optional().nullable(),
  ministryCode: z.string().trim().max(10).optional(),
  applicationType: z.string().trim().max(100).optional().nullable(),
  architectureType: z.string().trim().max(100).optional().nullable(),
  installType: z.string().trim().max(100).optional().nullable(),
  installStatus: z.string().trim().max(100).optional().nullable(),
  lifecycleStageStatus: z.string().trim().max(100).optional().nullable(),
  lifecycleStage: z.string().trim().max(100).optional().nullable(),
  technologyStack: z.string().trim().optional().nullable(),
  userBase: z.string().trim().max(50).optional().nullable(),
  platform: z.string().trim().max(200).optional().nullable(),
  lastChangeDate: z.string().optional().nullable(),
  businessOwner: z.string().trim().max(255).optional().nullable(),
  itOwner: z.string().trim().max(255).optional().nullable(),
  lastUpdatedBy: z.string().trim().max(255).optional().nullable(),
  businessCriticality: z.string().trim().max(50).optional().nullable(),
  emergencyTier: z.string().trim().max(50).optional().nullable(),
  dataClassification: z.string().trim().max(100).optional().nullable(),
  isCertified: z.boolean().optional().nullable(),
  department: z.string().trim().max(255).optional().nullable(),
  source: z.string().trim().max(255).optional().nullable(),
}).passthrough();
