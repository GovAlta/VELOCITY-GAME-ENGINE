import { z } from 'zod';

export const projectIdSchema = z.object({
  projectId: z.string().uuid('Invalid project ID'),
});

export const folderIdSchema = z.object({
  folderId: z.string().uuid('Invalid folder ID'),
});

export const spItemIdSchema = z.object({
  itemId: z.string().min(1).max(500),
});

export const moduleStepSchema = z.object({
  moduleId: z.string().uuid('Invalid module ID'),
  stepName: z.string().min(1).max(50),
});

export const uploadMetadataSchema = z.object({
  description: z.string().max(500).optional(),
  velocityTurnContent: z.string().max(2000).optional(),
});

export const auditBodySchema = z.object({
  provider: z.enum(['claude', 'gemini', 'grok']).optional(),
  model: z.string().max(100).optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  folderId: z.string().optional(),
});

// Reject SharePoint-forbidden filename chars and ASCII control chars (0x00–0x1F).
// Forbidden set per Microsoft Graph / OneDrive: " * : < > ? / \ |
const SP_ILLEGAL_FILENAME_CHARS = /[\x00-\x1f"*:<>?/\\|]/;

// Body for PUT /sharepoint/files/:itemId/content — content-only in-place edit.
// Filename / extension are immutable from this endpoint; use the rename
// endpoint to change them. Cap matches blank-file (250MB).
export const updateFileBodySchema = z.object({
  content: z
    .string()
    .max(250 * 1024 * 1024, 'Content exceeds 250MB limit')
    .nullable()
    .default('')
    .transform((v) => v ?? ''),
});

export const blankFileBodySchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1, 'Filename is required')
    .max(255, 'Filename must be 255 characters or fewer')
    .refine((v) => !SP_ILLEGAL_FILENAME_CHARS.test(v), {
      message: 'Filename contains characters not allowed by SharePoint',
    })
    .refine((v) => v !== '.' && v !== '..', { message: 'Invalid filename' })
    // Leading dots are allowed (.env, .gitignore). Reject only trailing dot or
    // trailing space — SharePoint rejects those.
    .refine((v) => !v.endsWith('.') && !v.endsWith(' '), {
      message: 'Filename cannot end with a dot or space',
    }),
  // Empty / null content creates a genuinely blank file.
  // Cap at 250MB — matches the regular file-upload ceiling. The /blank-file
  // routes also raise their express.json limit to 260MB.
  content: z
    .string()
    .max(250 * 1024 * 1024, 'Content exceeds 250MB limit')
    .nullable()
    .default('')
    .transform((v) => v ?? ''),
});
