import { pool } from '../config/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharePointFolderRecord {
  pk_sharepoint_folder: string;
  fk_sf_project: string;
  fk_sf_module: string | null;
  fk_sf_velocity_step: string | null;
  sp_site_id: string;
  sp_drive_id: string;
  sp_folder_id: string;
  sp_folder_path: string;
  sp_web_url: string | null;
  folder_type: 'project' | 'module' | 'step' | 'audit';
  sync_status: 'active' | 'orphaned' | 'error';
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface CreateFolderData {
  fk_sf_project: string;
  fk_sf_module?: string | null;
  fk_sf_velocity_step?: string | null;
  sp_site_id: string;
  sp_drive_id: string;
  sp_folder_id: string;
  sp_folder_path: string;
  sp_web_url?: string | null;
  folder_type: 'project' | 'module' | 'step' | 'audit';
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Insert a new sharepoint_folder record.
 */
export async function createFolder(data: CreateFolderData): Promise<SharePointFolderRecord> {
  const result = await pool.query<SharePointFolderRecord>(
    `INSERT INTO sharepoint_folder (
      fk_sf_project,
      fk_sf_module,
      fk_sf_velocity_step,
      sp_site_id,
      sp_drive_id,
      sp_folder_id,
      sp_folder_path,
      sp_web_url,
      folder_type,
      last_synced_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    RETURNING *`,
    [
      data.fk_sf_project,
      data.fk_sf_module || null,
      data.fk_sf_velocity_step || null,
      data.sp_site_id,
      data.sp_drive_id,
      data.sp_folder_id,
      data.sp_folder_path,
      data.sp_web_url || null,
      data.folder_type,
    ]
  );
  return result.rows[0];
}

/**
 * Find all non-deleted sharepoint_folder records for a project.
 */
export async function findByProject(projectId: string): Promise<SharePointFolderRecord[]> {
  const result = await pool.query<SharePointFolderRecord>(
    `SELECT * FROM sharepoint_folder
     WHERE fk_sf_project = $1 AND is_deleted = false
     ORDER BY folder_type ASC, sp_folder_path ASC`,
    [projectId]
  );
  return result.rows;
}

/**
 * Find all non-deleted sharepoint_folder records for a module.
 */
export async function findByModule(moduleId: string): Promise<SharePointFolderRecord[]> {
  const result = await pool.query<SharePointFolderRecord>(
    `SELECT * FROM sharepoint_folder
     WHERE fk_sf_module = $1 AND is_deleted = false
     ORDER BY folder_type ASC, sp_folder_path ASC`,
    [moduleId]
  );
  return result.rows;
}

/**
 * Find all non-deleted sharepoint_folder records for a velocity step.
 */
export async function findByStep(stepId: string): Promise<SharePointFolderRecord[]> {
  const result = await pool.query<SharePointFolderRecord>(
    `SELECT * FROM sharepoint_folder
     WHERE fk_sf_velocity_step = $1 AND is_deleted = false
     ORDER BY sp_folder_path ASC`,
    [stepId]
  );
  return result.rows;
}

/**
 * Find a non-deleted sharepoint_folder record by its SharePoint folder ID.
 */
export async function findByFolderId(spFolderId: string): Promise<SharePointFolderRecord | null> {
  const result = await pool.query<SharePointFolderRecord>(
    `SELECT * FROM sharepoint_folder
     WHERE sp_folder_id = $1 AND is_deleted = false`,
    [spFolderId]
  );
  return result.rows[0] || null;
}

/**
 * Find a sharepoint_folder record by primary key (including deleted).
 */
export async function findById(id: string): Promise<SharePointFolderRecord | null> {
  const result = await pool.query<SharePointFolderRecord>(
    `SELECT * FROM sharepoint_folder WHERE pk_sharepoint_folder = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Update the sync status and optionally the web URL of a sharepoint_folder record.
 */
export async function updateSyncStatus(
  id: string,
  status: 'active' | 'orphaned' | 'error',
  webUrl?: string
): Promise<SharePointFolderRecord | null> {
  const result = await pool.query<SharePointFolderRecord>(
    `UPDATE sharepoint_folder SET
      sync_status = $2,
      last_synced_at = NOW()
      ${webUrl !== undefined ? ', sp_web_url = $3' : ''}
     WHERE pk_sharepoint_folder = $1
     RETURNING *`,
    webUrl !== undefined ? [id, status, webUrl] : [id, status]
  );
  return result.rows[0] || null;
}

/**
 * Update the stored sp_folder_path (and optional sp_web_url) for a single
 * folder row. Used by the rename-reconciliation path when a project/module
 * is renamed and we move the SharePoint folder to match.
 */
export async function updatePath(
  id: string,
  newPath: string,
  webUrl?: string | null,
): Promise<SharePointFolderRecord | null> {
  const result = await pool.query<SharePointFolderRecord>(
    `UPDATE sharepoint_folder
        SET sp_folder_path = $2,
            sp_web_url = COALESCE($3, sp_web_url),
            last_synced_at = NOW(),
            updated_at = NOW()
      WHERE pk_sharepoint_folder = $1
      RETURNING *`,
    [id, newPath, webUrl ?? null],
  );
  return result.rows[0] || null;
}

/**
 * After a parent folder's path changes (rename), rewrite every descendant's
 * sp_folder_path that starts with the old prefix. The SharePoint folder IDs
 * stay stable because Graph moves children with the parent; only stored
 * paths drift, so this keeps the DB consistent for diagnostics and audits.
 */
export async function rewriteChildPaths(
  projectId: string,
  oldPathPrefix: string,
  newPathPrefix: string,
): Promise<number> {
  const result = await pool.query(
    `UPDATE sharepoint_folder
        SET sp_folder_path = $3 || SUBSTRING(sp_folder_path FROM $2::int + 1),
            updated_at = NOW()
      WHERE fk_sf_project = $1
        AND is_deleted = false
        AND sp_folder_path LIKE $4`,
    [projectId, oldPathPrefix.length, newPathPrefix, oldPathPrefix + '/%'],
  );
  return result.rowCount || 0;
}

/**
 * Soft-delete a sharepoint_folder record.
 */
export async function softDelete(id: string): Promise<SharePointFolderRecord | null> {
  const result = await pool.query<SharePointFolderRecord>(
    `UPDATE sharepoint_folder SET is_deleted = true WHERE pk_sharepoint_folder = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}
