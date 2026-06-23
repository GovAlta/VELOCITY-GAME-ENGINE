import { z } from 'zod';
import { optionalDate } from './common';

// ─── Contract Schemas ──────────────────────────────────────

export const listContractsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  search: z.string().trim().max(200).optional(),
  ministry: z.string().trim().optional(),
  vendor: z.string().trim().max(500).optional(),
  commodityType: z.string().trim().max(100).optional(),
  expiringBefore: optionalDate,
  expiringAfter: optionalDate,
  sort: z
    .enum([
      'contract_name', 'contract_vendor', 'contract_effective_date',
      'contract_expiration_date', 'contract_commodity_type',
      'ministry_name', 'updated_at', 'created_at',
    ])
    .optional()
    .default('updated_at'),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const contractIdSchema = z.object({
  id: z.string().uuid('Invalid contract ID'),
});

export const createContractSchema = z.object({
  name: z.string().trim().min(1).max(500),
  description: z.string().trim().optional(),
  ministryCode: z.string().trim().min(1).max(10).optional(),
  externalId: z.string().trim().max(100).optional(),
  commodityType: z.string().trim().max(100).optional(),
  vendor: z.string().trim().max(500).optional(),
  effectiveDate: optionalDate,
  expirationDate: optionalDate,
  hierarchyType: z.string().trim().max(200).optional(),
  source: z.string().trim().max(255).optional(),
});

export const updateContractSchema = createContractSchema.partial();
