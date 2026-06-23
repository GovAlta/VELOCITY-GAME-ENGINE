import { env } from '../config/environment';
import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';
import * as sharepointModel from '../models/sharepoint.model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdBy?: { user?: { displayName?: string; email?: string } };
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  file?: { mimeType: string };
  folder?: { childCount: number };
  parentReference?: { driveId: string; id: string; path: string };
  '@microsoft.graph.downloadUrl'?: string;
}

interface GraphSiteInfo {
  id: string;
  displayName: string;
  webUrl: string;
}

interface GraphDriveInfo {
  id: string;
  name: string;
  webUrl: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

interface ConnectionStatus {
  connected: boolean;
  siteId?: string;
  siteName?: string;
  driveId?: string;
  error?: string;
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  mimeType: string;
  itemId: string;
  webUrl: string;
}

interface DownloadResult {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

interface FolderCreationSummary {
  projectId: string;
  projectName: string;
  foldersCreated: number;
  foldersExisted: number;
  folders: Array<{
    path: string;
    type: string;
    spFolderId: string;
    webUrl?: string;
  }>;
}

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

let tokenCache: TokenCache | null = null;
let cachedSiteId: string | null = null;
let cachedSiteName: string | null = null;
let cachedDriveId: string | null = null;

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

const SP_TENANT_ID = () => env.SHAREPOINT_APPLICATION_TENANT_ID || process.env.SHAREPOINT_APPLICATION_TENANT_ID || process.env.SHAREPOINT_TENANT_ID || env.MICROSOFT_TENANT_ID || '';
const SP_CLIENT_ID = () => env.SHAREPOINT_APPLICATION_CLIENT_ID || process.env.SHAREPOINT_APPLICATION_CLIENT_ID || process.env.SHAREPOINT_CLIENT_ID || env.MICROSOFT_CLIENT_ID || '';
const SP_CLIENT_SECRET = () => env.SHAREPOINT_APPLICATION_CLIENT_SECRET || process.env.SHAREPOINT_APPLICATION_CLIENT_SECRET || process.env.SHAREPOINT_CLIENT_SECRET || env.MICROSOFT_CLIENT_SECRET || '';
const SP_SITE_URL = () => env.SHAREPOINT_SITE_URL || process.env.SHAREPOINT_SITE_URL || '';

/**
 * Returns true if all four required SharePoint environment variables are set.
 */
export function isConfigured(): boolean {
  return !!(SP_TENANT_ID() && SP_CLIENT_ID() && SP_CLIENT_SECRET() && SP_SITE_URL());
}

function assertConfigured(): void {
  if (!isConfigured()) {
    throw AppError.badRequest(
      'SharePoint is not configured. Set SHAREPOINT_APPLICATION_TENANT_ID, SHAREPOINT_APPLICATION_CLIENT_ID, SHAREPOINT_APPLICATION_CLIENT_SECRET, and SHAREPOINT_SITE_URL in .env'
    );
  }
}

// ---------------------------------------------------------------------------
// Token management — client_credentials OAuth2 flow
// ---------------------------------------------------------------------------

async function getAccessToken(): Promise<string> {
  assertConfigured();

  // Return cached token if still valid (60s buffer)
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const tenantId = SP_TENANT_ID();
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SP_CLIENT_ID(),
    client_secret: SP_CLIENT_SECRET(),
    scope: 'https://graph.microsoft.com/.default',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('SharePoint token acquisition failed', {
      status: response.status,
      error: errorText,
    });
    throw AppError.unauthorized('Failed to acquire SharePoint access token');
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  logger.info('SharePoint access token acquired/refreshed', {
    expiresIn: data.expires_in,
  });

  return tokenCache.accessToken;
}

// ---------------------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------------------

async function graphGet<T>(path: string): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await handleGraphError(response, 'GET', path);
  }

  return (await response.json()) as T;
}

async function graphPost<T>(path: string, body: unknown): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Return null-ish for 409 so callers can handle "already exists"
    if (response.status === 409) {
      return null as unknown as T;
    }
    await handleGraphError(response, 'POST', path);
  }

  return (await response.json()) as T;
}

async function graphPut<T>(
  path: string,
  body: Buffer | string,
  contentType: string = 'application/octet-stream'
): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body,
  });

  if (!response.ok) {
    await handleGraphError(response, 'PUT', path);
  }

  return (await response.json()) as T;
}

async function graphPatch<T>(path: string, body: unknown): Promise<T> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await handleGraphError(response, 'PATCH', path);
  }

  return (await response.json()) as T;
}

async function graphDelete(path: string): Promise<void> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await handleGraphError(response, 'DELETE', path);
  }
}

async function graphGetRaw(path: string): Promise<{ buffer: Buffer; contentType: string }> {
  const token = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0${path}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    await handleGraphError(response, 'GET (raw)', path);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

async function handleGraphError(
  response: Response,
  method: string,
  path: string
): Promise<never> {
  let errorBody = '';
  try {
    errorBody = await response.text();
  } catch {
    // ignore read errors
  }

  logger.error('Graph API error', {
    method,
    path,
    status: response.status,
    error: errorBody,
  });

  switch (response.status) {
    case 401:
      // Invalidate token cache on 401
      tokenCache = null;
      throw AppError.unauthorized('SharePoint authentication failed');
    case 403:
      throw AppError.forbidden('SharePoint access denied');
    case 404:
      throw AppError.notFound('SharePoint resource not found');
    case 409:
      throw AppError.conflict('SharePoint resource conflict');
    case 429:
      throw AppError.tooManyRequests('SharePoint API rate limit exceeded');
    default:
      throw AppError.internal(`SharePoint API error (${response.status}): ${errorBody}`);
  }
}

// ---------------------------------------------------------------------------
// Site resolution
// ---------------------------------------------------------------------------

/**
 * Parse the SHAREPOINT_SITE_URL and resolve the site ID and default drive ID.
 * Results are cached permanently for the lifetime of the process.
 */
async function resolveSite(): Promise<{ siteId: string; driveId: string }> {
  if (cachedSiteId && cachedDriveId) {
    return { siteId: cachedSiteId, driveId: cachedDriveId };
  }

  assertConfigured();

  const siteUrl = SP_SITE_URL();
  let hostname: string;
  let serverRelativePath: string;

  try {
    const url = new URL(siteUrl);
    hostname = url.hostname;
    // Remove leading slash for the Graph API path format
    serverRelativePath = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  } catch {
    throw AppError.badRequest(`Invalid SHAREPOINT_SITE_URL: ${siteUrl}`);
  }

  logger.info('Resolving SharePoint site', { hostname, serverRelativePath });

  const site = await graphGet<GraphSiteInfo>(
    `/sites/${hostname}:/${serverRelativePath}`
  );

  cachedSiteId = site.id;
  cachedSiteName = site.displayName;

  // Get the default document library drive
  const drive = await graphGet<GraphDriveInfo>(
    `/sites/${cachedSiteId}/drive`
  );

  cachedDriveId = drive.id;

  logger.info('SharePoint site resolved', {
    siteId: cachedSiteId,
    siteName: cachedSiteName,
    driveId: cachedDriveId,
  });

  return { siteId: cachedSiteId, driveId: cachedDriveId };
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

/**
 * Remove characters that are invalid in SharePoint folder/file names.
 * Invalid chars: / \ : * ? " < > |
 * Also trims leading/trailing whitespace and dots.
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
}

/**
 * Ensure a folder exists at the given path within the drive.
 * Creates each segment one at a time, handling 409 (already exists) gracefully.
 * Returns the driveItem for the final (deepest) folder.
 */
export async function ensureFolder(folderPath: string): Promise<GraphDriveItem> {
  const { driveId } = await resolveSite();

  const segments = folderPath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw AppError.badRequest('Folder path cannot be empty');
  }

  let parentItemId = 'root';
  let currentItem: GraphDriveItem | null = null;

  for (const segment of segments) {
    const sanitized = sanitizeFolderName(segment);
    if (!sanitized) {
      throw AppError.badRequest(`Invalid folder name segment: "${segment}"`);
    }

    // Attempt to create the folder
    const created = await graphPost<GraphDriveItem | null>(
      `/drives/${driveId}/items/${parentItemId}/children`,
      {
        name: sanitized,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }
    );

    if (created) {
      // Folder was created successfully
      currentItem = created;
      parentItemId = created.id;
    } else {
      // 409 conflict — folder already exists. Look it up.
      const existing = await graphGet<GraphDriveItem>(
        `/drives/${driveId}/items/${parentItemId}:/${encodeURIComponent(sanitized)}:`
      );
      currentItem = existing;
      parentItemId = existing.id;
    }
  }

  return currentItem!;
}

/**
 * Create the full SharePoint folder hierarchy for a project:
 *   /Velo Projects/{ProjectName} ({last4uuid})/
 *   /Velo Projects/{ProjectName} ({last4uuid})/Audits/
 *   /Velo Projects/{ProjectName} ({last4uuid})/{ModuleName} ({last4uuid})/
 *   /Velo Projects/{ProjectName} ({last4uuid})/{ModuleName} ({last4uuid})/{StepName}/
 *
 * Inserts/updates sharepoint_folder records for each folder.
 */
export async function ensureProjectHierarchy(
  projectId: string
): Promise<FolderCreationSummary> {
  assertConfigured();

  const { siteId, driveId } = await resolveSite();

  // Look up project
  const projectResult = await pool.query<{ project_name: string }>(
    `SELECT project_name FROM project WHERE pk_project = $1`,
    [projectId]
  );
  if (projectResult.rows.length === 0) {
    throw AppError.notFound(`Project not found: ${projectId}`);
  }
  const projectSuffix = projectId.slice(-4);
  const projectName = `${sanitizeFolderName(projectResult.rows[0].project_name)} (${projectSuffix})`;

  // Look up modules
  const modulesResult = await pool.query<{
    pk_module: string;
    module_name: string;
  }>(
    `SELECT pk_module, module_name FROM module
     WHERE fk_module_project = $1 AND is_deleted = false
     ORDER BY module_name ASC`,
    [projectId]
  );

  const summary: FolderCreationSummary = {
    projectId,
    projectName,
    foldersCreated: 0,
    foldersExisted: 0,
    folders: [],
  };

  // Helper to create a folder and record it in the DB
  async function createAndRecord(
    folderPath: string,
    folderType: 'project' | 'module' | 'step' | 'audit',
    moduleId: string | null,
    stepId: string | null
  ): Promise<void> {
    const item = await ensureFolder(folderPath);

    // Check if we already have a record for this sp_folder_id
    const existing = await sharepointModel.findByFolderId(item.id);

    if (existing) {
      // Update sync status
      await sharepointModel.updateSyncStatus(
        existing.pk_sharepoint_folder,
        'active',
        item.webUrl || undefined
      );
      summary.foldersExisted++;
    } else {
      await sharepointModel.createFolder({
        fk_sf_project: projectId,
        fk_sf_module: moduleId,
        fk_sf_velocity_step: stepId,
        sp_site_id: siteId,
        sp_drive_id: driveId,
        sp_folder_id: item.id,
        sp_folder_path: folderPath,
        sp_web_url: item.webUrl || null,
        folder_type: folderType,
      });
      summary.foldersCreated++;
    }

    summary.folders.push({
      path: folderPath,
      type: folderType,
      spFolderId: item.id,
      webUrl: item.webUrl || undefined,
    });
  }

  // ── Self-healing rename: if the DB already has a project- or module-type
  // folder for this entity and its current SharePoint name no longer matches
  // the desired one (because the project/module was renamed), move the
  // existing folder via Graph PATCH and update the stored paths. Without
  // this, a rename creates an orphan folder at the new path and leaves the
  // old one behind — observed in production as duplicate roots like
  // "Test User... (a5f1)" + "Sample User... (a5f1)".
  async function reconcileNamedFolder(
    existing: sharepointModel.SharePointFolderRecord | undefined,
    desiredParentPath: string,
    desiredBasename: string,
  ): Promise<{ folderId: string; path: string } | null> {
    if (!existing) return null;
    const desiredPath = `${desiredParentPath}/${desiredBasename}`;
    if (existing.sp_folder_path === desiredPath) {
      // No drift — update sync status and reuse
      await sharepointModel.updateSyncStatus(
        existing.pk_sharepoint_folder,
        'active',
        existing.sp_web_url || undefined,
      );
      summary.foldersExisted++;
      summary.folders.push({
        path: existing.sp_folder_path,
        type: existing.folder_type,
        spFolderId: existing.sp_folder_id,
        webUrl: existing.sp_web_url || undefined,
      });
      return { folderId: existing.sp_folder_id, path: existing.sp_folder_path };
    }
    // Path drift — rename on SharePoint, then rewrite stored paths
    logger.info('SharePoint folder name drift, reconciling via rename', {
      pkSharepointFolder: existing.pk_sharepoint_folder,
      folderType: existing.folder_type,
      from: existing.sp_folder_path,
      to: desiredPath,
    });
    const renamed = await renameItem(existing.sp_folder_id, desiredBasename);
    await sharepointModel.updatePath(
      existing.pk_sharepoint_folder,
      desiredPath,
      renamed.webUrl || null,
    );
    // Children move with the parent on SharePoint (Graph IDs are stable),
    // but their stored sp_folder_path is now stale — rewrite the prefix.
    const childrenRewritten = await sharepointModel.rewriteChildPaths(
      projectId,
      existing.sp_folder_path,
      desiredPath,
    );
    if (childrenRewritten > 0) {
      logger.info('SharePoint child folder paths rewritten after rename', {
        childrenRewritten,
        oldPrefix: existing.sp_folder_path,
        newPrefix: desiredPath,
      });
    }
    summary.foldersExisted++;
    summary.folders.push({
      path: desiredPath,
      type: existing.folder_type,
      spFolderId: existing.sp_folder_id,
      webUrl: renamed.webUrl || undefined,
    });
    return { folderId: existing.sp_folder_id, path: desiredPath };
  }

  // Snapshot all existing records once so we can match by project / module
  // without N+1 lookups inside the loop.
  const existingFolders = await sharepointModel.findByProject(projectId);

  // 1. Project root folder — reconcile by fk_sf_project if a record exists.
  const existingProjectRow = existingFolders.find(
    (f) => f.folder_type === 'project' && f.fk_sf_module === null
      && !f.sp_folder_path.includes('/Requirements'),
  );
  const reconciledProject = await reconcileNamedFolder(
    existingProjectRow,
    'Velo Projects',
    projectName,
  );
  const projectPath = reconciledProject
    ? reconciledProject.path
    : `Velo Projects/${projectName}`;
  if (!reconciledProject) {
    await createAndRecord(projectPath, 'project', null, null);
  }

  // 2. Standard subfolders — addressed by path under the (possibly renamed)
  // project folder. createAndRecord matches by sp_folder_id, so an existing
  // record gets a sync-status update even if its stored path was just
  // rewritten above.
  const auditsPath = `${projectPath}/Audits`;
  await createAndRecord(auditsPath, 'audit', null, null);

  const requirementsPath = `${projectPath}/Requirements`;
  await createAndRecord(requirementsPath, 'project', null, null);

  // 3. Module folders + their velocity step subfolders — reconcile each
  // module by fk_sf_module so a renamed module also self-heals instead of
  // duplicating.
  for (const mod of modulesResult.rows) {
    const moduleSuffix = mod.pk_module.slice(-4);
    const moduleName = `${sanitizeFolderName(mod.module_name)} (${moduleSuffix})`;
    const existingModuleRow = existingFolders.find(
      (f) => f.folder_type === 'module' && f.fk_sf_module === mod.pk_module,
    );
    const reconciledModule = await reconcileNamedFolder(
      existingModuleRow,
      projectPath,
      moduleName,
    );
    const modulePath = reconciledModule
      ? reconciledModule.path
      : `${projectPath}/${moduleName}`;
    if (!reconciledModule) {
      await createAndRecord(modulePath, 'module', mod.pk_module, null);
    }

    // Look up velocity steps for this module
    const stepsResult = await pool.query<{
      pk_module_velocity: string;
      step_name: string;
    }>(
      `SELECT pk_module_velocity, step_name FROM module_velocity
       WHERE fk_mv_module = $1
       ORDER BY step_order ASC`,
      [mod.pk_module]
    );

    for (const step of stepsResult.rows) {
      const stepName = sanitizeFolderName(step.step_name);
      const stepPath = `${modulePath}/${stepName}`;
      await createAndRecord(stepPath, 'step', mod.pk_module, step.pk_module_velocity);
    }
  }

  logger.info('SharePoint project hierarchy ensured', {
    projectId,
    projectName,
    foldersCreated: summary.foldersCreated,
    foldersExisted: summary.foldersExisted,
    totalFolders: summary.folders.length,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * List files and subfolders within a SharePoint folder.
 */
export async function listFiles(folderId: string): Promise<GraphDriveItem[]> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const result = await graphGet<{ value: GraphDriveItem[] }>(
    `/drives/${driveId}/items/${folderId}/children`
  );

  return result.value;
}

/**
 * Upload a file to a SharePoint folder.
 * Uses simple PUT for files ≤4MB, upload session with chunked upload for larger files.
 */
export async function uploadFile(
  folderId: string,
  filename: string,
  buffer: Buffer,
  contentType?: string
): Promise<GraphDriveItem> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // 4MB
  const encodedFilename = encodeURIComponent(filename);

  let item: GraphDriveItem;

  if (buffer.length <= SIMPLE_UPLOAD_LIMIT) {
    // Simple PUT upload for small files
    item = await graphPut<GraphDriveItem>(
      `/drives/${driveId}/items/${folderId}:/${encodedFilename}:/content`,
      buffer,
      contentType || 'application/octet-stream'
    );
  } else {
    // Large file: create upload session, then upload in chunks
    item = await uploadLargeFile(driveId, folderId, filename, buffer);
  }

  logger.info('SharePoint file uploaded', {
    folderId,
    filename,
    size: buffer.length,
    itemId: item.id,
    method: buffer.length <= SIMPLE_UPLOAD_LIMIT ? 'simple' : 'session',
  });

  return item;
}

/**
 * Upload a large file (>4MB) using an upload session with chunked upload.
 * Graph API requires 320KB-aligned chunks (multiples of 327680 bytes).
 */
async function uploadLargeFile(
  driveId: string,
  folderId: string,
  filename: string,
  buffer: Buffer
): Promise<GraphDriveItem> {
  const token = await getAccessToken();
  const encodedFilename = encodeURIComponent(filename);

  // Step 1: Create upload session
  const sessionUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/${encodedFilename}:/createUploadSession`;
  const sessionRes = await fetch(sessionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace', name: filename },
    }),
  });

  if (!sessionRes.ok) {
    const errText = await sessionRes.text().catch(() => '');
    throw AppError.internal(`Failed to create upload session: ${sessionRes.status} ${errText.substring(0, 200)}`);
  }

  const session = (await sessionRes.json()) as { uploadUrl: string };

  // Step 2: Upload in chunks (10MB chunks, 320KB-aligned)
  const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per chunk
  const totalSize = buffer.length;
  let offset = 0;
  let lastResponse: any = null;

  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunk = buffer.subarray(offset, end);

    const chunkRes = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
      },
      body: chunk,
    });

    if (!chunkRes.ok && chunkRes.status !== 202) {
      const errText = await chunkRes.text().catch(() => '');
      throw AppError.internal(`Upload chunk failed at offset ${offset}: ${chunkRes.status} ${errText.substring(0, 200)}`);
    }

    lastResponse = await chunkRes.json().catch(() => ({}));
    offset = end;

    logger.debug('SharePoint upload chunk', {
      filename,
      offset,
      totalSize,
      percent: Math.round((offset / totalSize) * 100),
    });
  }

  // The final chunk response contains the completed driveItem
  return lastResponse as GraphDriveItem;
}

/**
 * Overwrite an existing SharePoint file's content in place — preserves the
 * driveItem ID, version history, and SharePoint web URL. Simple PUT for
 * ≤4MB, upload session with chunks for larger.
 */
export async function updateFileContent(
  itemId: string,
  buffer: Buffer,
  contentType?: string
): Promise<GraphDriveItem> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

  let item: GraphDriveItem;
  if (buffer.length <= SIMPLE_UPLOAD_LIMIT) {
    item = await graphPut<GraphDriveItem>(
      `/drives/${driveId}/items/${itemId}/content`,
      buffer,
      contentType || 'application/octet-stream'
    );
  } else {
    item = await updateLargeFile(driveId, itemId, buffer);
  }

  logger.info('SharePoint file updated', {
    itemId,
    size: buffer.length,
    method: buffer.length <= SIMPLE_UPLOAD_LIMIT ? 'simple' : 'session',
  });

  return item;
}

/**
 * Large in-place update (>4MB) — uses an upload session against the item ID
 * directly. Graph replaces the existing item's content.
 */
async function updateLargeFile(
  driveId: string,
  itemId: string,
  buffer: Buffer
): Promise<GraphDriveItem> {
  const token = await getAccessToken();

  const sessionUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/createUploadSession`;
  const sessionRes = await fetch(sessionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    }),
  });

  if (!sessionRes.ok) {
    const errText = await sessionRes.text().catch(() => '');
    throw AppError.internal(`Failed to create update session: ${sessionRes.status} ${errText.substring(0, 200)}`);
  }

  const session = (await sessionRes.json()) as { uploadUrl: string };

  const CHUNK_SIZE = 10 * 1024 * 1024;
  const totalSize = buffer.length;
  let offset = 0;
  let lastResponse: any = null;

  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunk = buffer.subarray(offset, end);

    const chunkRes = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
      },
      body: chunk,
    });

    if (!chunkRes.ok && chunkRes.status !== 202) {
      const errText = await chunkRes.text().catch(() => '');
      throw AppError.internal(`Update chunk failed at offset ${offset}: ${chunkRes.status} ${errText.substring(0, 200)}`);
    }

    lastResponse = await chunkRes.json().catch(() => ({}));
    offset = end;
  }

  return lastResponse as GraphDriveItem;
}

/**
 * Download a file from SharePoint by item ID.
 */
export async function downloadFile(itemId: string): Promise<DownloadResult> {
  assertConfigured();
  const { driveId } = await resolveSite();

  // First get metadata for filename
  const metadata = await graphGet<GraphDriveItem>(
    `/drives/${driveId}/items/${itemId}`
  );

  // Download the content
  const { buffer, contentType } = await graphGetRaw(
    `/drives/${driveId}/items/${itemId}/content`
  );

  return {
    buffer,
    contentType,
    filename: metadata.name,
  };
}

/**
 * Get metadata for a SharePoint item.
 */
export async function getFileMetadata(itemId: string): Promise<GraphDriveItem> {
  assertConfigured();
  const { driveId } = await resolveSite();

  return graphGet<GraphDriveItem>(`/drives/${driveId}/items/${itemId}`);
}

/**
 * Delete a file from SharePoint.
 */
export async function deleteFile(itemId: string): Promise<void> {
  assertConfigured();
  const { driveId } = await resolveSite();

  await graphDelete(`/drives/${driveId}/items/${itemId}`);

  logger.info('SharePoint file deleted', { itemId });
}

/**
 * Rename a file or folder in SharePoint.
 */
export async function renameItem(itemId: string, newName: string): Promise<GraphDriveItem> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const item = await graphPatch<GraphDriveItem>(
    `/drives/${driveId}/items/${itemId}`,
    { name: sanitizeFolderName(newName) }
  );

  logger.info('SharePoint item renamed', { itemId, newName: item.name });
  return item;
}

/**
 * Move a file or folder to a different parent folder.
 */
export async function moveItem(
  itemId: string,
  targetFolderId: string,
  newName?: string
): Promise<GraphDriveItem> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const body: Record<string, unknown> = {
    parentReference: { driveId, id: targetFolderId },
  };
  if (newName) {
    body.name = sanitizeFolderName(newName);
  }

  const item = await graphPatch<GraphDriveItem>(
    `/drives/${driveId}/items/${itemId}`,
    body
  );

  logger.info('SharePoint item moved', { itemId, targetFolderId, newName: item.name });
  return item;
}

/**
 * Delete a folder from SharePoint (and all its contents).
 */
export async function deleteFolder(itemId: string): Promise<void> {
  assertConfigured();
  const { driveId } = await resolveSite();

  await graphDelete(`/drives/${driveId}/items/${itemId}`);
  logger.info('SharePoint folder deleted', { itemId });
}

/**
 * Create a new subfolder inside a parent folder.
 */
export async function createSubfolder(parentFolderId: string, name: string): Promise<GraphDriveItem> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const safeName = sanitizeFolderName(name);
  const item = await graphPost<GraphDriveItem>(
    `/drives/${driveId}/items/${parentFolderId}/children`,
    { name: safeName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }
  );

  if (!item) {
    // 409 conflict — folder already exists, fetch it
    const children = await graphGet<{ value: GraphDriveItem[] }>(
      `/drives/${driveId}/items/${parentFolderId}/children`
    );
    const existing = children.value?.find(
      (c) => c.name.toLowerCase() === safeName.toLowerCase() && c.folder
    );
    if (existing) return existing;
    throw AppError.internal(`Failed to create or find subfolder "${safeName}"`);
  }

  logger.info('SharePoint subfolder created', { parentFolderId, name: safeName, itemId: item.id });
  return item;
}

/**
 * Download a text-based file and return its content as a string.
 * Useful for auditing document contents.
 */
export async function getFileContent(itemId: string): Promise<string> {
  const { buffer } = await downloadFile(itemId);
  return buffer.toString('utf-8');
}

/**
 * Search for files within a drive or specific folder.
 */
export async function searchFiles(
  query: string,
  folderId?: string
): Promise<GraphDriveItem[]> {
  assertConfigured();
  const { driveId } = await resolveSite();

  const searchPath = folderId
    ? `/drives/${driveId}/items/${folderId}/search(q='${encodeURIComponent(query)}')`
    : `/drives/${driveId}/root/search(q='${encodeURIComponent(query)}')`;

  const result = await graphGet<{ value: GraphDriveItem[] }>(searchPath);
  return result.value;
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

/**
 * Recursively enumerate all files under a project's SharePoint root folder.
 * Returns a flat array of file entries.
 */
export async function enumerateProjectFiles(projectId: string): Promise<FileEntry[]> {
  assertConfigured();
  const { driveId } = await resolveSite();

  // Find the project root folder record
  const folders = await sharepointModel.findByProject(projectId);
  const projectFolder = folders.find((f) => f.folder_type === 'project');

  if (!projectFolder) {
    throw AppError.notFound('No SharePoint folder mapping found for this project. Run ensureProjectHierarchy first.');
  }

  const files: FileEntry[] = [];

  async function recurse(parentId: string, currentPath: string): Promise<void> {
    const children = await graphGet<{ value: GraphDriveItem[] }>(
      `/drives/${driveId}/items/${parentId}/children`
    );

    for (const child of children.value) {
      if (child.folder) {
        // Recurse into subfolders
        await recurse(child.id, `${currentPath}/${child.name}`);
      } else {
        files.push({
          name: child.name,
          path: `${currentPath}/${child.name}`,
          size: child.size || 0,
          lastModified: child.lastModifiedDateTime || '',
          mimeType: child.file?.mimeType || 'application/octet-stream',
          itemId: child.id,
          webUrl: child.webUrl || '',
        });
      }
    }
  }

  await recurse(projectFolder.sp_folder_id, projectFolder.sp_folder_path);

  logger.info('SharePoint project files enumerated', {
    projectId,
    fileCount: files.length,
  });

  return files;
}

/**
 * Upload an audit report to the project's /Audits/ subfolder in SharePoint.
 */
export async function uploadAuditReport(
  projectId: string,
  filename: string,
  content: string | Buffer
): Promise<GraphDriveItem> {
  assertConfigured();

  // Find the audit folder record
  const folders = await sharepointModel.findByProject(projectId);
  const auditFolder = folders.find((f) => f.folder_type === 'audit');

  if (!auditFolder) {
    throw AppError.notFound(
      'No SharePoint audit folder found for this project. Run ensureProjectHierarchy first.'
    );
  }

  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  const contentType = filename.endsWith('.html')
    ? 'text/html'
    : filename.endsWith('.json')
      ? 'application/json'
      : filename.endsWith('.md')
        ? 'text/markdown'
        : 'application/octet-stream';

  const item = await uploadFile(auditFolder.sp_folder_id, filename, buffer, contentType);

  logger.info('SharePoint audit report uploaded', {
    projectId,
    filename,
    itemId: item.id,
  });

  return item;
}

// ---------------------------------------------------------------------------
// Connection check
// ---------------------------------------------------------------------------

/**
 * Verify SharePoint connectivity and return status information.
 */
/**
 * Import a ZIP file: extract all files/folders and recreate them in a SharePoint folder.
 * Uses JSZip to parse the ZIP buffer, then creates folders and uploads files.
 */
export interface ImportedFile { id: string; name: string; spFolderId: string; }

export async function importZip(
  parentFolderId: string,
  zipBuffer: Buffer,
  onProgress?: (detail: string, pct: number) => void
): Promise<{ foldersCreated: number; filesUploaded: number; errors: string[]; importedFiles: ImportedFile[] }> {
  assertConfigured();
  const { driveId } = await resolveSite();
  const JSZip = (await import('jszip')).default;

  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.entries(zip.files);
  const errors: string[] = [];
  const importedFiles: ImportedFile[] = [];
  let foldersCreated = 0;
  let filesUploaded = 0;

  // ZIP bomb protection
  const MAX_ZIP_ENTRIES = 5000;
  const MAX_SINGLE_FILE = 500 * 1024 * 1024; // 500MB per file
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains ${entries.length} entries (max ${MAX_ZIP_ENTRIES})`);
  }

  // Sort entries: folders first, then files (ensures parent folders exist before files)
  const sorted = entries.sort(([a], [b]) => {
    const aIsDir = a.endsWith('/');
    const bIsDir = b.endsWith('/');
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a.localeCompare(b);
  });

  // Track created folder IDs by path
  const folderIds = new Map<string, string>();
  folderIds.set('', parentFolderId); // root = parent folder

  for (let i = 0; i < sorted.length; i++) {
    const [path, entry] = sorted[i];
    if (!path || path.startsWith('__MACOSX') || path.startsWith('.')) continue;
    // Path traversal protection
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) {
      errors.push(`${path}: blocked (path traversal attempt)`);
      continue;
    }

    const pct = Math.round((i / sorted.length) * 100);
    onProgress?.(`Processing ${i + 1}/${sorted.length}: ${path}`, pct);

    try {
      if (entry.dir) {
        // Create folder
        const segments = path.replace(/\/$/, '').split('/');
        let currentParent = parentFolderId;
        let currentPath = '';

        for (const segment of segments) {
          currentPath = currentPath ? `${currentPath}/${segment}` : segment;
          if (!folderIds.has(currentPath)) {
            const created = await createSubfolder(currentParent, segment);
            folderIds.set(currentPath, created.id);
            foldersCreated++;
          }
          currentParent = folderIds.get(currentPath)!;
        }
      } else {
        // Upload file
        const content = await entry.async('nodebuffer');
        if (!content || content.length === 0) continue;
        if (content.length > MAX_SINGLE_FILE) {
          errors.push(`${path}: skipped (${(content.length / 1024 / 1024).toFixed(0)}MB exceeds limit)`);
          continue;
        }

        // Ensure parent folder exists
        const parts = path.split('/');
        const filename = parts.pop()!;
        let targetFolderId = parentFolderId;

        if (parts.length > 0) {
          let currentPath = '';
          let currentParent = parentFolderId;
          for (const segment of parts) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            if (!folderIds.has(currentPath)) {
              const created = await createSubfolder(currentParent, segment);
              folderIds.set(currentPath, created.id);
              foldersCreated++;
            }
            currentParent = folderIds.get(currentPath)!;
          }
          targetFolderId = folderIds.get(currentPath)!;
        }

        const uploaded = await uploadFile(targetFolderId, filename, content);
        importedFiles.push({ id: uploaded.id, name: filename, spFolderId: targetFolderId });
        filesUploaded++;
      }
    } catch (err) {
      errors.push(`${path}: ${(err as Error).message}`);
    }
  }

  return { foldersCreated, filesUploaded, errors, importedFiles };
}

/**
 * Import a ZIP file from disk using streaming extraction (yauzl).
 * Processes each entry inline as yauzl reads it — only one file's content
 * is in memory at a time. Suitable for ZIP files up to 2GB+.
 */
export async function importZipFromDisk(
  parentFolderId: string,
  filePath: string,
  onProgress?: (detail: string, pct: number) => void
): Promise<{ foldersCreated: number; filesUploaded: number; errors: string[]; importedFiles: ImportedFile[] }> {
  assertConfigured();
  const yauzl = await import('yauzl');
  const { promises: fs } = await import('fs');

  const errors: string[] = [];
  const importedFiles: ImportedFile[] = [];
  let foldersCreated = 0;
  let filesUploaded = 0;
  let entryIndex = 0;

  // Track created folder IDs by path
  const folderIds = new Map<string, string>();
  folderIds.set('', parentFolderId);

  /** Ensure all ancestor folders exist and return the target folder ID */
  async function ensureFolderPath(dirPath: string): Promise<string> {
    const segments = dirPath.split('/').filter(Boolean);
    let currentParent = parentFolderId;
    let currentPath = '';
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!folderIds.has(currentPath)) {
        const created = await createSubfolder(currentParent, segment);
        folderIds.set(currentPath, created.id);
        foldersCreated++;
      }
      currentParent = folderIds.get(currentPath)!;
    }
    return currentParent;
  }

  /** Read a yauzl entry's content into a Buffer */
  function readEntryBuffer(zipFile: any, entry: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      zipFile.openReadStream(entry, (err: any, stream: any) => {
        if (err || !stream) return reject(err || new Error('No read stream'));
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }

  await new Promise<void>((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zipFile) => {
      if (err || !zipFile) return reject(err || new Error('Failed to open ZIP'));

      const totalEntries = zipFile.entryCount;
      logger.info('ZIP import (streaming) started', { filePath, totalEntries });

      zipFile.on('entry', async (entry: any) => {
        entryIndex++;
        const fn = entry.fileName;

        // Skip Mac metadata and hidden files
        if (!fn || fn.startsWith('__MACOSX') || fn.startsWith('.')) {
          zipFile.readEntry();
          return;
        }

        // Path traversal protection
        if (fn.includes('..') || fn.startsWith('/') || fn.includes('\\')) {
          errors.push(`${fn}: blocked (path traversal attempt)`);
          zipFile.readEntry();
          return;
        }

        const pct = Math.round((entryIndex / totalEntries) * 100);
        onProgress?.(`Processing ${entryIndex}/${totalEntries}: ${fn}`, pct);

        try {
          if (/\/$/.test(fn)) {
            // Directory entry — ensure it exists in SharePoint
            await ensureFolderPath(fn.replace(/\/$/, ''));
          } else {
            // File entry — read content, ensure parent exists, upload
            const content = await readEntryBuffer(zipFile, entry);

            if (content.length > 0) {
              const parts = fn.split('/');
              const filename = parts.pop()!;
              const dirPath = parts.join('/');
              const targetFolderId = dirPath
                ? await ensureFolderPath(dirPath)
                : parentFolderId;

              const uploaded = await uploadFile(targetFolderId, filename, content);
              importedFiles.push({ id: uploaded.id, name: filename, spFolderId: targetFolderId });
              filesUploaded++;
            }
          }
        } catch (entryErr) {
          errors.push(`${fn}: ${(entryErr as Error).message}`);
        }

        // Move to next entry AFTER current one is fully processed
        zipFile.readEntry();
      });

      zipFile.on('end', () => resolve());
      zipFile.on('error', reject);
      zipFile.readEntry(); // start reading first entry
    });
  });

  // Clean up temp file
  try { await fs.unlink(filePath); } catch { /* ignore */ }

  logger.info('ZIP import (streaming) complete', { foldersCreated, filesUploaded, errors: errors.length });
  return { foldersCreated, filesUploaded, errors, importedFiles };
}

/**
 * Export a SharePoint folder as a ZIP file.
 * Recursively downloads all files and creates a ZIP buffer.
 */
export async function exportZip(
  folderId: string,
  folderName: string,
  onProgress?: (detail: string, pct: number) => void
): Promise<Buffer> {
  assertConfigured();
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // Recursive function to walk folder tree
  async function addFolder(spFolderId: string, zipPath: string, depth: number) {
    const items = await listFiles(spFolderId);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      onProgress?.(`${zipPath}/${item.name}`, Math.min(90, depth * 20 + i));

      if (item.folder) {
        // Recurse into subfolder
        await addFolder(item.id, `${zipPath}/${item.name}`, depth + 1);
      } else {
        // Download and add file
        try {
          const { buffer } = await downloadFile(item.id);
          zip.file(`${zipPath}/${item.name}`, buffer);
        } catch (err) {
          // Skip failed downloads
          logger.warn('ZIP export: failed to download file', { name: item.name, error: (err as Error).message });
        }
      }
    }
  }

  onProgress?.('Building ZIP...', 0);
  await addFolder(folderId, folderName, 0);

  onProgress?.('Compressing...', 95);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  return buffer;
}

// ---------------------------------------------------------------------------
// Connection check
// ---------------------------------------------------------------------------

export async function checkConnection(): Promise<ConnectionStatus> {
  if (!isConfigured()) {
    return {
      connected: false,
      error: 'SharePoint environment variables are not configured',
    };
  }

  try {
    const { siteId, driveId } = await resolveSite();
    return {
      connected: true,
      siteId,
      siteName: cachedSiteName || undefined,
      driveId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('SharePoint connection check failed', { error: message });
    return {
      connected: false,
      error: message,
    };
  }
}
