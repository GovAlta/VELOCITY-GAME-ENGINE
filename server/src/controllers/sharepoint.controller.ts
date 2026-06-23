import { Request, Response } from 'express';
import * as sharepointService from '../services/sharepoint.service';
import * as sharepointModel from '../models/sharepoint.model';
import * as sharepointAuditService from '../services/sharepoint-audit.service';
import * as aiFileProcessor from '../services/ai-file-processor.service';
import * as aiQueue from '../services/ai-processing-queue.service';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/app-error';
import { pool } from '../config/database';
import logger from '../utils/logger';
import { velocityStreamManager } from '../sse/velocity-stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUserId(req: Request): string | null {
  return (req as any).user?.pk_user_account || (req as any).user?.id || null;
}

function getApiKeyId(req: Request): string | null {
  return (req as any)._apiKeyId || null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /sharepoint/status
 * Check SharePoint connection health.
 */
export async function checkStatus(_req: Request, res: Response): Promise<void> {
  const status = await sharepointService.checkConnection();
  sendSuccess(res, status);
}

/**
 * POST /sharepoint/projects/:projectId/folders
 * Ensure the standard folder hierarchy exists for a project in SharePoint.
 */
export async function ensureProjectFolders(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const summary = await sharepointService.ensureProjectHierarchy(projectId);

  velocityStreamManager.broadcast('sharepoint_folders_created', {
    projectId,
    folderCount: summary.folders.length,
  });

  sendSuccess(res, summary, 201);
}

/**
 * GET /sharepoint/projects/:projectId/folders
 * List all tracked SharePoint folder records for a project.
 */
export async function listProjectFolders(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const folders = await sharepointModel.findByProject(projectId);
  sendSuccess(res, folders);
}

/**
 * GET /sharepoint/folders/:folderId/files
 * List files in a SharePoint folder by its local folder record ID.
 */
export async function listFolderFiles(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;

  const folderRecord = await sharepointModel.findById(folderId);
  if (!folderRecord || folderRecord.is_deleted) {
    throw AppError.notFound('SharePoint folder record not found');
  }

  const files = await sharepointService.listFiles(folderRecord.sp_folder_id);
  sendSuccess(res, files);
}

/**
 * GET /sharepoint/items/:itemId/children
 * List children (files AND subfolders) of any SharePoint item by its Graph drive-item ID.
 * This uses SharePoint as the source of truth — no DB lookup required.
 */
export async function listItemChildren(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const items = await sharepointService.listFiles(itemId);
  sendSuccess(res, items);
}

/**
 * POST /sharepoint/folders/:folderId/files
 * Upload a file to a SharePoint folder.
 */
export async function uploadFile(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;

  const folderRecord = await sharepointModel.findById(folderId);
  if (!folderRecord || folderRecord.is_deleted) {
    throw AppError.notFound('SharePoint folder record not found');
  }

  const file = req.file;
  if (!file) {
    throw AppError.badRequest('No file provided');
  }

  const uploaded = await sharepointService.uploadFile(
    folderRecord.sp_folder_id,
    file.originalname,
    file.buffer,
    file.mimetype
  );

  velocityStreamManager.broadcast('sharepoint_file_uploaded', {
    projectId: folderRecord.fk_sf_project,
    folderId,
    filename: file.originalname,
  });

  // Auto-enqueue for AI shadow processing
  aiQueue.enqueue(folderRecord.sp_folder_id, uploaded.id, file.originalname);

  sendSuccess(res, uploaded, 201);
}

/**
 * Guess a sensible Content-Type from a filename extension for blank-file uploads.
 * Falls back to text/plain since blank-file content is always typed UTF-8 text.
 */
function contentTypeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'md': case 'markdown': return 'text/markdown; charset=utf-8';
    case 'txt': case 'log': return 'text/plain; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'csv': return 'text/csv; charset=utf-8';
    case 'tsv': return 'text/tab-separated-values; charset=utf-8';
    case 'xml': return 'application/xml; charset=utf-8';
    case 'yaml': case 'yml': return 'application/yaml; charset=utf-8';
    case 'html': case 'htm': return 'text/html; charset=utf-8';
    case 'css': return 'text/css; charset=utf-8';
    case 'js': case 'mjs': case 'cjs': return 'application/javascript; charset=utf-8';
    case 'ts': case 'tsx': return 'application/typescript; charset=utf-8';
    case 'sql': return 'application/sql; charset=utf-8';
    case 'sh': return 'application/x-sh; charset=utf-8';
    default: return 'text/plain; charset=utf-8';
  }
}

/**
 * POST /sharepoint/folders/:folderId/blank-file
 * Create a brand-new file directly in a SharePoint folder (by local folder UUID)
 * with caller-supplied filename + textual content. Behaves like a normal upload
 * — same Graph PUT, same SSE broadcast, same AI shadow enqueue.
 */
export async function createBlankFile(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;

  const folderRecord = await sharepointModel.findById(folderId);
  if (!folderRecord || folderRecord.is_deleted) {
    throw AppError.notFound('SharePoint folder record not found');
  }

  const { filename, content } = req.body as { filename: string; content: string };
  const buffer = Buffer.from(content ?? '', 'utf8');
  const contentType = contentTypeForFilename(filename);

  const uploaded = await sharepointService.uploadFile(
    folderRecord.sp_folder_id,
    filename,
    buffer,
    contentType
  );

  velocityStreamManager.broadcast('sharepoint_file_uploaded', {
    projectId: folderRecord.fk_sf_project,
    folderId,
    filename,
  });

  aiQueue.enqueue(folderRecord.sp_folder_id, uploaded.id, filename);

  sendSuccess(res, uploaded, 201);
}

/**
 * POST /sharepoint/items/:itemId/blank-file
 * Create a brand-new file directly in a SharePoint folder addressed by Graph
 * drive-item ID (used when the user has navigated into a subfolder).
 */
export async function createBlankFileInItem(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;

  const { filename, content } = req.body as { filename: string; content: string };
  const buffer = Buffer.from(content ?? '', 'utf8');
  const contentType = contentTypeForFilename(filename);

  const uploaded = await sharepointService.uploadFile(
    itemId,
    filename,
    buffer,
    contentType
  );

  velocityStreamManager.broadcast('sharepoint_file_uploaded', {
    folderId: itemId,
    filename,
  });

  aiQueue.enqueue(itemId, uploaded.id, filename);

  sendSuccess(res, uploaded, 201);
}

/**
 * POST /sharepoint/items/:itemId/subfolder
 * Create a subfolder in any SharePoint folder by its Graph drive-item ID.
 */
export async function createSubfolderByItem(req: Request, res: Response): Promise<void> {
  const parentItemId = req.params.itemId as string;
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw AppError.badRequest('Folder name is required');
  }
  const item = await sharepointService.createSubfolder(parentItemId, name.trim());
  sendSuccess(res, item, 201);
}

/**
 * POST /sharepoint/items/:itemId/files
 * Upload a file to any SharePoint folder by its Graph drive-item ID (source of truth).
 */
export async function uploadFileToItem(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;

  const file = req.file;
  if (!file) throw AppError.badRequest('No file provided');

  const uploaded = await sharepointService.uploadFile(
    itemId,
    file.originalname,
    file.buffer,
    file.mimetype
  );

  velocityStreamManager.broadcast('sharepoint_file_uploaded', {
    folderId: itemId,
    filename: file.originalname,
  });

  // Auto-enqueue for AI shadow processing
  aiQueue.enqueue(itemId, uploaded.id, file.originalname);

  sendSuccess(res, uploaded, 201);
}

/**
 * GET /sharepoint/files/:itemId/download
 * Download a file from SharePoint by its item ID.
 */
// Safe MIME types that can be rendered inline without XSS risk
const INLINE_SAFE_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml',
  'text/plain', 'text/markdown', 'text/csv',
]);

export async function downloadFile(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const wantsInline = req.query.inline === 'true';

  const result = await sharepointService.downloadFile(itemId);
  const contentType = result.contentType || 'application/octet-stream';

  // Only allow inline for safe types — prevents XSS from HTML/SVG with scripts
  const inline = wantsInline && INLINE_SAFE_TYPES.has(contentType);

  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(result.filename || 'download')}"`
  );

  // CSP: prevent any script execution even for inline content
  if (inline) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'none'; script-src 'none';");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  res.send(result.buffer);
}

/**
 * PUT /sharepoint/files/:itemId/content
 * Overwrite an existing SharePoint file's content in place. Used by the
 * inline document editor. Re-enqueues AI shadow processing because the
 * underlying content has changed.
 */
export async function updateFile(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const { content } = req.body as { content: string };

  // Fetch current metadata so we know the filename (for logging + content-type
  // inference) and the parent folder (so we can re-enqueue AI processing).
  const metadata = await sharepointService.getFileMetadata(itemId);
  const filename = metadata.name || 'document';
  const parentFolderId = metadata.parentReference?.id;

  const buffer = Buffer.from(content ?? '', 'utf8');
  const contentType = contentTypeForFilename(filename);

  const updated = await sharepointService.updateFileContent(itemId, buffer, contentType);

  velocityStreamManager.broadcast('sharepoint_file_updated', {
    itemId,
    filename,
  });

  // Re-enqueue AI shadow processing now that the content has changed. Skip if
  // this file *is* a shadow (its content is the AI rendering, not source).
  if (parentFolderId && !filename.startsWith('__AI__')) {
    aiQueue.enqueue(parentFolderId, itemId, filename);
  }

  sendSuccess(res, updated);
}

/**
 * GET /sharepoint/files/:itemId/metadata
 * Get metadata for a SharePoint file.
 */
export async function getFileMetadata(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const metadata = await sharepointService.getFileMetadata(itemId);
  sendSuccess(res, metadata);
}

/**
 * DELETE /sharepoint/files/:itemId
 * Delete a file from SharePoint.
 */
export async function deleteFile(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  await sharepointService.deleteFile(itemId);

  velocityStreamManager.broadcast('sharepoint_file_deleted', { itemId });

  sendSuccess(res, { message: 'File deleted' });
}

/**
 * PATCH /sharepoint/files/:itemId/rename
 * Rename a file or folder.
 */
export async function renameItem(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw AppError.badRequest('New name is required');
  }
  const item = await sharepointService.renameItem(itemId, name.trim());

  velocityStreamManager.broadcast('sharepoint_item_renamed', { itemId, newName: name.trim() });

  sendSuccess(res, item);
}

/**
 * PATCH /sharepoint/files/:itemId/move
 * Move a file or folder to a different parent folder.
 */
export async function moveItem(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const { targetFolderId, newName } = req.body;
  if (!targetFolderId || typeof targetFolderId !== 'string') {
    throw AppError.badRequest('targetFolderId is required (SharePoint driveItem ID of the destination folder)');
  }
  const item = await sharepointService.moveItem(itemId, targetFolderId, newName);

  velocityStreamManager.broadcast('sharepoint_item_moved', { itemId });

  sendSuccess(res, item);
}

/**
 * DELETE /sharepoint/folders/:folderId/folder
 * Delete a SharePoint folder and all its contents.
 */
export async function deleteFolder(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;
  // Look up the sharepoint_folder record to get the SP item ID
  const folder = await sharepointModel.findById(folderId);
  if (!folder) throw AppError.notFound('Folder record not found');
  await sharepointService.deleteFolder(folder.sp_folder_id);
  await sharepointModel.softDelete(folderId);

  velocityStreamManager.broadcast('sharepoint_folder_deleted', { folderId });

  sendSuccess(res, { message: 'Folder deleted' });
}

/**
 * POST /sharepoint/folders/:folderId/subfolder
 * Create a new subfolder inside an existing folder.
 */
export async function createSubfolder(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;
  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw AppError.badRequest('Folder name is required');
  }
  const parentFolder = await sharepointModel.findById(folderId);
  if (!parentFolder) throw AppError.notFound('Parent folder record not found');
  const item = await sharepointService.createSubfolder(parentFolder.sp_folder_id, name.trim());

  // Track the new subfolder in the DB so it appears in the tree
  const newPath = `${parentFolder.sp_folder_path}/${name.trim()}`;
  await sharepointModel.createFolder({
    fk_sf_project: parentFolder.fk_sf_project,
    fk_sf_module: parentFolder.fk_sf_module,
    fk_sf_velocity_step: parentFolder.fk_sf_velocity_step,
    sp_site_id: parentFolder.sp_site_id,
    sp_drive_id: parentFolder.sp_drive_id,
    sp_folder_id: item.id,
    sp_folder_path: newPath,
    sp_web_url: item.webUrl || null,
    folder_type: parentFolder.folder_type,
  });

  velocityStreamManager.broadcast('sharepoint_subfolder_created', {
    projectId: parentFolder.fk_sf_project,
    path: newPath,
  });

  sendSuccess(res, { ...item, sp_folder_path: newPath });
}

/**
 * POST /sharepoint/modules/:moduleId/steps/:stepName/artifacts
 * Upload an artifact to the SharePoint folder for a velocity step.
 */
export async function uploadStepArtifact(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const stepName = req.params.stepName as string;

  // Look up the module to find its project
  const moduleResult = await pool.query(
    `SELECT pk_module, fk_module_project FROM module WHERE pk_module = $1`,
    [moduleId]
  );
  if (moduleResult.rows.length === 0) {
    throw AppError.notFound('Module not found');
  }
  const projectId = moduleResult.rows[0].fk_module_project as string;

  // Ensure the project folder hierarchy exists (creates step folder if needed)
  await sharepointService.ensureProjectHierarchy(projectId);

  // Find the step's SharePoint folder
  const stepFolders = await sharepointModel.findByModule(moduleId);
  const stepFolder = stepFolders.find(
    (f) => f.folder_type === 'step' && f.sp_folder_path.includes(stepName)
  );
  if (!stepFolder) {
    throw AppError.notFound(`SharePoint folder for step "${stepName}" not found`);
  }

  const file = req.file;
  if (!file) {
    throw AppError.badRequest('No file provided');
  }

  const uploaded = await sharepointService.uploadFile(
    stepFolder.sp_folder_id,
    file.originalname,
    file.buffer,
    file.mimetype
  );

  velocityStreamManager.broadcast('sharepoint_file_uploaded', {
    projectId,
    moduleId,
    stepName,
    filename: file.originalname,
  });

  // Auto-enqueue for AI shadow processing
  aiQueue.enqueue(stepFolder.sp_folder_id, uploaded.id, file.originalname);

  sendSuccess(res, {
    ...uploaded,
    webUrl: stepFolder.sp_web_url,
  }, 201);
}

/**
 * GET /sharepoint/modules/:moduleId/steps/:stepName/artifacts
 * List artifacts in the SharePoint folder for a velocity step.
 */
export async function listStepArtifacts(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const stepName = req.params.stepName as string;

  // Find the step's SharePoint folder
  const stepFolders = await sharepointModel.findByModule(moduleId);
  const stepFolder = stepFolders.find(
    (f) => f.folder_type === 'step' && f.sp_folder_path.includes(stepName)
  );

  if (!stepFolder) {
    // No folder provisioned yet — return empty list
    sendSuccess(res, []);
    return;
  }

  const files = await sharepointService.listFiles(stepFolder.sp_folder_id);
  sendSuccess(res, files);
}

/**
 * POST /sharepoint/projects/:projectId/audit
 * Kick off a SharePoint content audit for a project.
 * Returns the audit ID immediately; processing runs async.
 */
export async function runSharePointAudit(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const userId = getUserId(req);
  const { provider, model, maxFiles, maxContentKB } = req.body || {};

  const auditId = await sharepointAuditService.runSharePointAuditAsync(projectId, userId || undefined, {
    provider,
    model,
    maxFiles,
    maxContentKB,
  });

  sendSuccess(res, { auditId, status: 'running' }, 202);
}

/**
 * GET /sharepoint/search
 * Search for files across SharePoint.
 */
export async function searchFiles(req: Request, res: Response): Promise<void> {
  const query = req.query.q as string;

  if (!query) {
    throw AppError.badRequest('Search query (q) is required');
  }

  const results = await sharepointService.searchFiles(query);
  sendSuccess(res, results);
}

/**
 * POST /sharepoint/projects/:projectId/audit/:auditId/export
 * Export an audit report to the project's Audits folder in SharePoint.
 */
export async function exportAuditToSharePoint(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const auditId = req.params.auditId as string;

  // Look up audit record
  const auditResult = await pool.query(
    `SELECT * FROM project_audit WHERE pk_project_audit = $1`,
    [auditId]
  );
  if (auditResult.rows.length === 0) {
    throw AppError.notFound('Audit not found');
  }

  const audit = auditResult.rows[0];

  // Verify audit belongs to the project
  if (audit.fk_audit_project !== projectId) {
    throw AppError.notFound('Audit not found for this project');
  }

  // Ensure project folder hierarchy exists
  await sharepointService.ensureProjectHierarchy(projectId);

  // Find the project's audit folder
  const folders = await sharepointModel.findByProject(projectId);
  const auditFolder = folders.find((f) => f.folder_type === 'audit');
  if (!auditFolder) {
    throw AppError.notFound('Audit folder not found in SharePoint');
  }

  // Generate markdown report from audit data
  const auditData = typeof audit.audit_data === 'string'
    ? JSON.parse(audit.audit_data)
    : audit.audit_data;

  const reportDate = new Date().toISOString().split('T')[0];
  const reportContent = generateAuditMarkdown(audit, auditData, reportDate);

  const filename = `audit-report-${reportDate}-${auditId.slice(0, 8)}.md`;
  const buffer = Buffer.from(reportContent, 'utf-8');

  // Upload to SharePoint
  const uploaded = await sharepointService.uploadFile(
    auditFolder.sp_folder_id,
    filename,
    buffer,
    'text/markdown'
  );

  sendSuccess(res, {
    ...uploaded,
    webUrl: auditFolder.sp_web_url,
    filename,
  }, 201);
}

// ---------------------------------------------------------------------------
// ZIP Import / Export
// ---------------------------------------------------------------------------

/**
 * POST /sharepoint/folders/:folderId/import-zip
 * Upload a ZIP file and extract its contents into the folder.
 */
export async function importZip(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;
  const folder = await sharepointModel.findById(folderId);
  if (!folder) throw AppError.notFound('Folder not found');

  const file = (req as any).file;
  if (!file) throw AppError.badRequest('ZIP file is required');

  // Use streaming disk-based extraction if file was written to disk (large ZIPs),
  // fall back to in-memory for buffer-based uploads (tests, small files)
  const result = file.path
    ? await sharepointService.importZipFromDisk(folder.sp_folder_id, file.path)
    : await sharepointService.importZip(folder.sp_folder_id, file.buffer);

  // Broadcast SSE event
  velocityStreamManager.broadcast('sharepoint_import', {
    projectId: folder.fk_sf_project,
    folderId: folder.pk_sharepoint_folder,
    folderPath: folder.sp_folder_path,
    foldersCreated: result.foldersCreated,
    filesUploaded: result.filesUploaded,
  });

  // Enqueue imported files directly (no folder listing needed — we have the exact items)
  logger.info('ZIP import: enqueuing files for AI processing', {
    count: result.importedFiles.length,
    files: result.importedFiles.map(f => f.name),
  });
  for (const f of result.importedFiles) {
    aiQueue.enqueue(f.spFolderId, f.id, f.name);
  }

  sendSuccess(res, { foldersCreated: result.foldersCreated, filesUploaded: result.filesUploaded, errors: result.errors });
}

/**
 * POST /sharepoint/items/:itemId/import-zip
 * Import a ZIP into any SharePoint folder by its Graph drive-item ID.
 */
export async function importZipToItem(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;

  const file = (req as any).file;
  if (!file) throw AppError.badRequest('ZIP file is required');

  const result = file.path
    ? await sharepointService.importZipFromDisk(itemId, file.path)
    : await sharepointService.importZip(itemId, file.buffer);

  velocityStreamManager.broadcast('sharepoint_import', {
    folderId: itemId,
    foldersCreated: result.foldersCreated,
    filesUploaded: result.filesUploaded,
  });

  logger.info('ZIP import (item): enqueuing files for AI processing', {
    count: result.importedFiles.length,
    files: result.importedFiles.map(f => f.name),
  });
  for (const f of result.importedFiles) {
    aiQueue.enqueue(f.spFolderId, f.id, f.name);
  }

  sendSuccess(res, { foldersCreated: result.foldersCreated, filesUploaded: result.filesUploaded, errors: result.errors });
}

/**
 * GET /sharepoint/folders/:folderId/export-zip
 * Download a folder and all its contents as a ZIP file.
 */
export async function exportZip(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;
  const folder = await sharepointModel.findById(folderId);
  if (!folder) throw AppError.notFound('Folder not found');

  const folderName = folder.sp_folder_path.split('/').pop() || 'export';
  const zipBuffer = await sharepointService.exportZip(folder.sp_folder_id, folderName);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
  res.setHeader('Content-Length', String(zipBuffer.length));
  res.send(zipBuffer);
}

// ---------------------------------------------------------------------------
// AI File Processing (shadow files)
// ---------------------------------------------------------------------------

/**
 * POST /sharepoint/files/:itemId/process
 * Process a single file into an AI-ready shadow version (__AI__filename.md).
 * Supports: PDF, images, DOCX, XLSX.
 */
export async function processFileToAI(req: Request, res: Response): Promise<void> {
  const itemId = req.params.itemId as string;
  const { folderId, spFolderId: clientSpFolderId, provider, model } = req.body;

  // Get file metadata — includes parentReference with the actual parent folder ID
  const metadata = await sharepointService.getFileMetadata(itemId);

  if (!aiFileProcessor.shouldProcess(metadata.name)) {
    throw AppError.badRequest(`File type not supported for AI processing: ${metadata.name}`);
  }

  // Determine the correct SharePoint folder ID for the shadow file.
  // Priority: 1) file's actual parent from Graph API, 2) client-provided SP item ID, 3) DB folder lookup
  let spFolderId = (metadata as any).parentReference?.id;

  if (!spFolderId && clientSpFolderId) {
    spFolderId = clientSpFolderId;
  }

  if (!spFolderId && folderId) {
    const folder = await sharepointModel.findById(folderId);
    if (folder) spFolderId = folder.sp_folder_id;
  }

  if (!spFolderId) {
    throw AppError.badRequest('Could not determine parent folder for shadow file');
  }

  // Enqueue through the DB-backed pipeline
  aiQueue.enqueue(spFolderId, itemId, metadata.name, provider, model);

  sendSuccess(res, {
    status: 'queued',
    originalFile: metadata.name,
    shadowFile: aiFileProcessor.shadowFilename(metadata.name),
    message: 'Queued for AI processing. Track progress in the Pipeline view.',
  }, 202);
}

/**
 * POST /sharepoint/folders/:folderId/process-all
 * Process all eligible files in a folder into AI-ready shadow versions.
 */
export async function processFolderToAI(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;
  const { provider, model } = req.body || {};

  const folder = await sharepointModel.findById(folderId);
  if (!folder) throw AppError.notFound('Folder not found');

  // List all files in the folder and enqueue processable ones through the DB pipeline
  const files = await sharepointService.listFiles(folder.sp_folder_id);
  const count = aiQueue.enqueueMany(folder.sp_folder_id, files, provider, model);

  velocityStreamManager.broadcast('sharepoint_ai_processing_all', { folderId, count });

  sendSuccess(res, {
    status: 'processing',
    message: 'AI processing started for all eligible files. Shadow files will appear as they complete.',
  }, 202);
}

/**
 * GET /sharepoint/ai-queue
 * Get the current AI processing queue status.
 */
/**
 * POST /sharepoint/ai-queue/jobs/:jobId/retry
 * Retry a failed AI processing job.
 */
export async function retryAIJob(req: Request, res: Response): Promise<void> {
  const jobId = req.params.jobId as string;
  const { getJob, requeueJob, failJob } = await import('../models/ai-processing.model');

  const job = await getJob(jobId);
  if (!job) throw AppError.notFound('Job not found');
  if (job.status !== 'failed') throw AppError.badRequest(`Cannot retry job in '${job.status}' status`);

  // Delete old sub-jobs and re-enqueue
  const { pool } = await import('../config/database');
  await pool.query('DELETE FROM ai_processing_sub_job WHERE fk_apsj_job = $1', [jobId]);
  await pool.query(
    `UPDATE ai_processing_job
     SET status = 'queued', retry_count = retry_count + 1, error_message = NULL,
         started_at = NULL, completed_at = NULL,
         total_sub_jobs = 0, completed_sub_jobs = 0, failed_sub_jobs = 0
     WHERE pk_ai_processing_job = $1`,
    [jobId]
  );

  logger.info('AI queue: job retried manually', { jobId, filename: job.filename });
  sendSuccess(res, { status: 'queued', message: 'Job requeued for processing' });
}

export async function getAIQueueStatus(_req: Request, res: Response): Promise<void> {
  const queueStatus = await aiQueue.status();
  sendSuccess(res, queueStatus);
}

/**
 * GET /sharepoint/ai-queue/jobs
 * Get detailed jobs with sub-jobs. Optional ?folderId= filter.
 */
export async function getAIQueueJobs(req: Request, res: Response): Promise<void> {
  const folderId = req.query.folderId as string | undefined;
  // If folderId is a DB UUID, look up the SP folder ID
  let spFolderId = folderId;
  if (folderId && folderId.includes('-') && folderId.length === 36) {
    const folder = await sharepointModel.findById(folderId);
    if (folder) spFolderId = folder.sp_folder_id;
  }
  const { getJobsDetailed } = await import('../models/ai-processing.model');
  const jobs = await getJobsDetailed(spFolderId);
  sendSuccess(res, jobs);
}

/**
 * GET /sharepoint/folders/:folderId/ai-status
 * Check staleness of AI shadow files in a folder.
 * Single API call to SharePoint — very fast.
 */
export async function checkAIStaleness(req: Request, res: Response): Promise<void> {
  const folderId = req.params.folderId as string;
  const folder = await sharepointModel.findById(folderId);
  if (!folder) throw AppError.notFound('Folder not found');

  const report = await aiFileProcessor.checkFolderStaleness(folder.sp_folder_id);
  sendSuccess(res, report);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a markdown report from audit data.
 */
function generateAuditMarkdown(
  audit: Record<string, unknown>,
  auditData: Record<string, unknown>,
  reportDate: string
): string {
  const title = (audit.audit_title as string) || 'SharePoint Content Audit';
  const source = (audit.audit_source as string) || 'unknown';
  const status = (auditData.status as string) || 'unknown';
  const totalFiles = (auditData.totalFiles as number) || 0;
  const totalFolders = (auditData.totalFolders as number) || 0;

  let report = `# ${title}\n\n`;
  report += `**Date:** ${reportDate}\n`;
  report += `**Source:** ${source}\n`;
  report += `**Status:** ${status}\n`;
  report += `**Total Folders:** ${totalFolders}\n`;
  report += `**Total Files:** ${totalFiles}\n\n`;
  report += `---\n\n`;

  const files = auditData.files as Array<Record<string, unknown>> | undefined;
  if (files && files.length > 0) {
    report += `## Files Inventory\n\n`;
    report += `| File | Folder | Type |\n`;
    report += `|------|--------|------|\n`;

    for (const file of files) {
      const name = (file.name as string) || 'unknown';
      const folderPath = (file.folderPath as string) || '';
      const folderType = (file.folderType as string) || '';
      report += `| ${name} | ${folderPath} | ${folderType} |\n`;
    }
    report += `\n`;
  } else {
    report += `No files found.\n\n`;
  }

  report += `---\n\n`;
  report += `*Generated by Velo — Project Tool for AI*\n`;

  return report;
}
