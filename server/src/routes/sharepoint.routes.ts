import { Router, json as jsonBody } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import * as sharepointController from '../controllers/sharepoint.controller';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/async-handler';
import { sharepointMutationLimiter } from '../middleware/rate-limit';
import * as v from '../validators/sharepoint.validator';

const router = Router();

// Rate limit all SharePoint mutations (POST/PATCH/DELETE): 120 per 15 min per IP
router.use((req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next(); // skip rate limiting for reads
  }
  sharepointMutationLimiter(req, _res, next);
});

// Standard memory-based upload for individual files (≤250MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB max
});

// Route-local JSON body parser for blank-file creation — lets users paste
// large documents into the New Document editor without hitting the global 1MB
// BODY_LIMIT_JSON. The validator caps the actual content field at 250MB; the
// parser allows a little extra headroom for JSON encoding overhead.
const blankFileBody = jsonBody({ limit: '260mb' });

// Disk-based upload for ZIP imports (≤2GB) — never holds full file in memory
const uploadZipToDisk = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `velo-zip-${Date.now()}-${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are accepted'));
    }
  },
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * GET /sharepoint/status
 * Health check — no auth required.
 */
router.get('/status', asyncHandler(sharepointController.checkStatus));

// ---------------------------------------------------------------------------
// Project folder management
// ---------------------------------------------------------------------------

/**
 * POST /sharepoint/projects/:projectId/folders
 * Ensure the standard folder hierarchy exists for a project.
 */
router.post(
  '/projects/:projectId/folders',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.projectIdSchema }),
  asyncHandler(sharepointController.ensureProjectFolders)
);

/**
 * GET /sharepoint/projects/:projectId/folders
 * List all tracked SharePoint folder records for a project.
 */
router.get(
  '/projects/:projectId/folders',
  authenticate,
  validate({ params: v.projectIdSchema }),
  asyncHandler(sharepointController.listProjectFolders)
);

// ---------------------------------------------------------------------------
// Folder file operations
// ---------------------------------------------------------------------------

/**
 * GET /sharepoint/folders/:folderId/files
 * List files in a SharePoint folder.
 */
router.get(
  '/folders/:folderId/files',
  authenticate,
  validate({ params: v.folderIdSchema }),
  asyncHandler(sharepointController.listFolderFiles)
);

/**
 * POST /sharepoint/folders/:folderId/files
 * Upload a file to a SharePoint folder.
 */
router.post(
  '/folders/:folderId/files',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.folderIdSchema }),
  upload.single('file'),
  asyncHandler(sharepointController.uploadFile)
);

/**
 * POST /sharepoint/folders/:folderId/blank-file
 * Create a brand-new file in a SharePoint folder from a JSON body (filename + content).
 */
router.post(
  '/folders/:folderId/blank-file',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  blankFileBody,
  validate({ params: v.folderIdSchema, body: v.blankFileBodySchema }),
  asyncHandler(sharepointController.createBlankFile)
);

/**
 * POST /sharepoint/items/:itemId/blank-file
 * Create a brand-new file in a SharePoint folder addressed by Graph drive-item ID.
 */
router.post(
  '/items/:itemId/blank-file',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  blankFileBody,
  validate({ params: v.spItemIdSchema, body: v.blankFileBodySchema }),
  asyncHandler(sharepointController.createBlankFileInItem)
);

/**
 * POST /sharepoint/folders/:folderId/import-zip
 * Upload a ZIP and extract its folder/file structure into the target folder.
 * Uses disk storage + streaming extraction — supports ZIPs up to 2GB.
 */
router.post(
  '/folders/:folderId/import-zip',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.folderIdSchema }),
  uploadZipToDisk.single('file'),
  asyncHandler(sharepointController.importZip)
);

/**
 * GET /sharepoint/folders/:folderId/export-zip
 * Download a folder and all its contents as a ZIP file.
 */
router.get(
  '/folders/:folderId/export-zip',
  authenticate,
  validate({ params: v.folderIdSchema }),
  asyncHandler(sharepointController.exportZip)
);

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * GET /sharepoint/items/:itemId/children
 * List children (files + subfolders) by SharePoint drive-item ID — source of truth.
 */
router.get(
  '/items/:itemId/children',
  authenticate,
  validate({ params: v.spItemIdSchema }),
  asyncHandler(sharepointController.listItemChildren)
);

/**
 * POST /sharepoint/items/:itemId/subfolder
 * Create a subfolder in any SharePoint folder by its Graph drive-item ID.
 */
router.post(
  '/items/:itemId/subfolder',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.spItemIdSchema }),
  asyncHandler(sharepointController.createSubfolderByItem)
);

/**
 * POST /sharepoint/items/:itemId/import-zip
 * Import a ZIP into any SharePoint folder by its Graph drive-item ID.
 */
router.post(
  '/items/:itemId/import-zip',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.spItemIdSchema }),
  uploadZipToDisk.single('file'),
  asyncHandler(sharepointController.importZipToItem)
);

/**
 * POST /sharepoint/items/:itemId/files
 * Upload a file to any SharePoint folder by its Graph drive-item ID.
 */
router.post(
  '/items/:itemId/files',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.spItemIdSchema }),
  upload.single('file'),
  asyncHandler(sharepointController.uploadFileToItem)
);

/**
 * GET /sharepoint/files/:itemId/download
 * Download a file from SharePoint.
 */
router.get(
  '/files/:itemId/download',
  authenticate,
  validate({ params: v.spItemIdSchema }),
  asyncHandler(sharepointController.downloadFile)
);

/**
 * PUT /sharepoint/files/:itemId/content
 * Overwrite an existing SharePoint file's content in place (inline editor).
 */
router.put(
  '/files/:itemId/content',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  blankFileBody,
  validate({ params: v.spItemIdSchema, body: v.updateFileBodySchema }),
  asyncHandler(sharepointController.updateFile)
);

/**
 * GET /sharepoint/files/:itemId/metadata
 * Get metadata for a SharePoint file.
 */
router.get(
  '/files/:itemId/metadata',
  authenticate,
  validate({ params: v.spItemIdSchema }),
  asyncHandler(sharepointController.getFileMetadata)
);

/**
 * DELETE /sharepoint/files/:itemId
 * Delete a file from SharePoint.
 */
router.delete(
  '/files/:itemId',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.spItemIdSchema }),
  asyncHandler(sharepointController.deleteFile)
);

// ---------------------------------------------------------------------------
// Rename, Move, Delete folders, Create subfolders
// ---------------------------------------------------------------------------

/**
 * PATCH /sharepoint/files/:itemId/rename
 * Rename a file or folder in SharePoint.
 */
router.patch(
  '/files/:itemId/rename',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  asyncHandler(sharepointController.renameItem)
);

/**
 * PATCH /sharepoint/files/:itemId/move
 * Move a file or folder to a different parent folder.
 */
router.patch(
  '/files/:itemId/move',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  asyncHandler(sharepointController.moveItem)
);

/**
 * DELETE /sharepoint/folders/:folderId/folder
 * Delete a SharePoint folder and all its contents.
 */
router.delete(
  '/folders/:folderId/folder',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.folderIdSchema }),
  asyncHandler(sharepointController.deleteFolder)
);

/**
 * POST /sharepoint/folders/:folderId/subfolder
 * Create a new subfolder inside an existing folder.
 */
router.post(
  '/folders/:folderId/subfolder',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.folderIdSchema }),
  asyncHandler(sharepointController.createSubfolder)
);

// ---------------------------------------------------------------------------
// Velocity step artifacts
// ---------------------------------------------------------------------------

/**
 * POST /sharepoint/modules/:moduleId/steps/:stepName/artifacts
 * Upload an artifact to the SharePoint folder for a velocity step.
 */
router.post(
  '/modules/:moduleId/steps/:stepName/artifacts',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.moduleStepSchema }),
  upload.single('file'),
  asyncHandler(sharepointController.uploadStepArtifact)
);

/**
 * GET /sharepoint/modules/:moduleId/steps/:stepName/artifacts
 * List artifacts in a velocity step's SharePoint folder.
 */
router.get(
  '/modules/:moduleId/steps/:stepName/artifacts',
  authenticate,
  validate({ params: v.moduleStepSchema }),
  asyncHandler(sharepointController.listStepArtifacts)
);

// ---------------------------------------------------------------------------
// SharePoint content audit
// ---------------------------------------------------------------------------

/**
 * POST /sharepoint/projects/:projectId/audit
 * Kick off a SharePoint content audit.
 */
router.post(
  '/projects/:projectId/audit',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.projectIdSchema, body: v.auditBodySchema }),
  asyncHandler(sharepointController.runSharePointAudit)
);

/**
 * POST /sharepoint/projects/:projectId/audit/:auditId/export
 * Export an audit report to the project's Audits folder in SharePoint.
 */
router.post(
  '/projects/:projectId/audit/:auditId/export',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  asyncHandler(sharepointController.exportAuditToSharePoint)
);

// ---------------------------------------------------------------------------
// AI File Processing (shadow files)
// ---------------------------------------------------------------------------

/**
 * POST /sharepoint/files/:itemId/process
 * Process a single file into an AI-ready shadow (__AI__filename.md).
 */
router.post(
  '/files/:itemId/process',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  asyncHandler(sharepointController.processFileToAI)
);

/**
 * POST /sharepoint/folders/:folderId/process-all
 * Process all eligible files in a folder into AI-ready shadows.
 */
router.post(
  '/folders/:folderId/process-all',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  validate({ params: v.folderIdSchema }),
  asyncHandler(sharepointController.processFolderToAI)
);

/**
 * GET /sharepoint/ai-queue
 * Get current background AI processing queue status.
 */
router.get(
  '/ai-queue',
  authenticate,
  asyncHandler(sharepointController.getAIQueueStatus)
);

/**
 * GET /sharepoint/ai-queue/jobs
 * Get detailed jobs with sub-jobs. Optional ?folderId= query param.
 */
router.get(
  '/ai-queue/jobs',
  authenticate,
  asyncHandler(sharepointController.getAIQueueJobs)
);

/**
 * POST /sharepoint/ai-queue/jobs/:jobId/retry
 * Retry a failed AI processing job.
 */
router.post(
  '/ai-queue/jobs/:jobId/retry',
  authenticate,
  authorize('runner', 'project_lead'),
  csrf,
  asyncHandler(sharepointController.retryAIJob)
);

/**
 * GET /sharepoint/folders/:folderId/ai-status
 * Check which files have stale or missing AI shadow versions. Single SP API call — fast.
 */
router.get(
  '/folders/:folderId/ai-status',
  authenticate,
  validate({ params: v.folderIdSchema }),
  asyncHandler(sharepointController.checkAIStaleness)
);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * GET /sharepoint/search
 * Search for files across SharePoint.
 */
router.get(
  '/search',
  authenticate,
  validate({ query: v.searchQuerySchema }),
  asyncHandler(sharepointController.searchFiles)
);

export default router;
