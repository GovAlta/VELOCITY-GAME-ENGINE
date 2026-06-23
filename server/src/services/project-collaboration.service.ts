import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import { logAuditEvent } from '../utils/audit-logger';
import { velocityStreamManager } from '../sse/velocity-stream';
import * as memberService from './project-member.service';
import * as sharepointService from './sharepoint.service';
import logger from '../utils/logger';
import type { PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Auth context (controllers set this before calling service)
// ---------------------------------------------------------------------------

let _currentAuthSource: string = 'session';
let _currentApiKeyId: string | undefined;

export function setAuthContext(source: string, apiKeyId?: string) {
  _currentAuthSource = source;
  _currentApiKeyId = apiKeyId;
}

interface AuditMeta {
  ipAddress?: string;
}

function enrich(meta: AuditMeta | undefined, body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    _authSource: _currentAuthSource,
    ...(_currentApiKeyId ? { _apiKeyId: _currentApiKeyId } : {}),
  };
}

// ===========================================================================
// CLONE
// ===========================================================================

interface CloneOptions {
  versionLabel?: string | null;
  copyLinks?: boolean;     // default true
  copyBudgets?: boolean;   // default false
}

interface ProjectGateRow {
  pk_project: string;
  is_deleted: boolean;
  fk_project_parent: string | null;
  project_clone_disabled: boolean;
  project_name: string;
  project_code: string | null;
}

/**
 * Pick the next free `-vN` suffix for the cloned project_code.
 * Examples:
 *   parent code = "PRJ-0042"   → returns "PRJ-0042-v1" (or -v2, -v3...)
 *   parent code = null         → returns null
 */
async function nextVersionCode(parentCode: string | null, executor: PoolClient): Promise<string | null> {
  if (!parentCode) return null;
  // Strip any existing -vN suffix from parent code (defensive — clones-of-clones
  // are rejected before we get here, but a parent code may already contain "-v")
  const baseCode = parentCode.replace(/-v\d+$/, '');

  // Find the highest existing -vN among siblings
  const { rows } = await executor.query<{ project_code: string | null }>(
    `SELECT project_code FROM project
      WHERE project_code LIKE $1
        AND is_deleted = false`,
    [`${baseCode}-v%`],
  );
  let highest = 0;
  for (const r of rows) {
    if (!r.project_code) continue;
    const m = r.project_code.match(/-v(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > highest) highest = n;
    }
  }
  return `${baseCode}-v${highest + 1}`;
}

/**
 * Clone a project. Single-level only.
 *   - 422 CLONE_OF_CLONE  if source has fk_project_parent
 *   - 403 CLONE_DISABLED  if source.project_clone_disabled = true
 *   - Cloner becomes the sole owner of the clone
 *   - Modules are copied (each gets a new UUID; trigger inits fresh velocity state)
 *   - project_link is copied by default; project_budget optional
 *   - Resets: status=discovery, percent_complete=0, dates=null, challenge_claimed_*=null,
 *     challenge_completed_at=null, audit/turn/lead/update history fresh
 *   - Inherits: name (with " (clone)" suffix), description, ministry, priority, scope,
 *     category, branch, risk, additional_info, demand_number, mission_critical,
 *     is_challenge + challenge_points/max_days/difficulty
 *   - project_code: auto-suffixed `<parent>-vN`
 *   - project_cloned_from_name: snapshot of parent name (survives parent deletion)
 */
export async function cloneProject(
  sourceId: string,
  cloningUserId: string,
  options: CloneOptions,
  meta?: AuditMeta,
): Promise<{ pk_project: string; project_code: string | null; project_name: string }> {
  const copyLinks = options.copyLinks !== false;     // default true
  const copyBudgets = options.copyBudgets === true;  // default false

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Load + validate source
    const { rows: sourceRows } = await client.query<ProjectGateRow & { project_name: string }>(
      `SELECT pk_project, is_deleted, fk_project_parent, project_clone_disabled,
              project_name, project_code
         FROM project WHERE pk_project = $1 FOR UPDATE`,
      [sourceId],
    );
    if (sourceRows.length === 0 || sourceRows[0].is_deleted) {
      throw AppError.notFound('Source project not found');
    }
    const source = sourceRows[0];

    if (source.fk_project_parent !== null) {
      throw new AppError('Cannot clone a clone — only top-level projects may be cloned', 422, 'CLONE_OF_CLONE');
    }
    if (source.project_clone_disabled) {
      throw new AppError('Cloning has been disabled for this project by an administrator', 403, 'CLONE_DISABLED');
    }

    // 2. Insert the clone with a single SELECT-INTO copy of inherited fields
    const newCode = await nextVersionCode(source.project_code, client);
    const inheritedName = source.project_name; // keep same name; user can rename

    const { rows: newRows } = await client.query<{ pk_project: string; project_name: string; project_code: string | null }>(
      `INSERT INTO project (
         project_code,
         fk_project_ministry,
         project_name,
         project_description,
         project_priority,
         project_scope,
         project_category,
         project_branch,
         project_risk,
         project_additional_info,
         project_demand_number,
         project_is_mission_critical,
         project_is_challenge,
         challenge_points,
         challenge_max_days,
         challenge_difficulty,
         fk_project_parent,
         project_cloned_from_name,
         project_version_label,
         project_cloned_at,
         project_cloned_by,
         created_by,
         updated_by
       )
       SELECT
         $2,
         fk_project_ministry,
         project_name,
         project_description,
         project_priority,
         project_scope,
         project_category,
         project_branch,
         project_risk,
         project_additional_info,
         project_demand_number,
         project_is_mission_critical,
         project_is_challenge,
         challenge_points,
         challenge_max_days,
         challenge_difficulty,
         $1,
         project_name,
         $3,
         NOW(),
         $4,
         $4,
         $4
       FROM project WHERE pk_project = $1
       RETURNING pk_project, project_name, project_code`,
      [sourceId, newCode, options.versionLabel ?? null, cloningUserId],
    );

    const clone = newRows[0];

    // 3. Copy modules. New module UUIDs cause the velocity-init trigger to
    //    create fresh module_velocity rows (per migration 040).
    await client.query(
      `INSERT INTO module (
         fk_module_project, module_name, module_description, module_status,
         module_sort_order, module_plan, module_complexity,
         module_is_mission_critical, created_by, updated_by
       )
       SELECT
         $1, module_name, module_description, 'requirements_gathering',
         module_sort_order, module_plan, module_complexity,
         module_is_mission_critical, $2, $2
       FROM module
       WHERE fk_module_project = $3 AND is_deleted = false`,
      [clone.pk_project, cloningUserId, sourceId],
    );

    // 4. Copy links (optional, default ON)
    if (copyLinks) {
      await client.query(
        `INSERT INTO project_link (fk_project_link_project, link_type, link_url, link_label, link_description)
         SELECT $1, link_type, link_url, link_label, link_description
           FROM project_link WHERE fk_project_link_project = $2`,
        [clone.pk_project, sourceId],
      );
    }

    // 5. Copy budgets (optional, default OFF)
    if (copyBudgets) {
      await client.query(
        `INSERT INTO project_budget (
           fk_project_budget_project, budget_fiscal_year, budget_funding_source,
           budget_money_type, budget_amount, budget_spent, budget_notes
         )
         SELECT $1, budget_fiscal_year, budget_funding_source,
                budget_money_type, budget_amount, 0, budget_notes
           FROM project_budget WHERE fk_project_budget_project = $2`,
        [clone.pk_project, sourceId],
      );
    }

    await client.query('COMMIT');

    // 6. Bootstrap the cloner as the inaugural owner (post-commit so audit_log
    //    is visible). Done outside the txn intentionally — failure here just
    //    leaves an open project the cloner can still membership-claim later.
    await memberService.bootstrapOwner(clone.pk_project, cloningUserId, {
      ipAddress: meta?.ipAddress,
      authSource: _currentAuthSource,
      apiKeyId: _currentApiKeyId,
    });

    // 7. Audit
    await logAuditEvent({
      action: 'INSERT',
      tableName: 'project',
      recordId: clone.pk_project,
      userId: cloningUserId,
      ipAddress: meta?.ipAddress,
      newData: enrich(meta, {
        cloned_from: sourceId,
        cloned_from_name: inheritedName,
        version_label: options.versionLabel ?? null,
        project_code: clone.project_code,
        copy_links: copyLinks,
        copy_budgets: copyBudgets,
      }),
    });

    velocityStreamManager.broadcast('version_created', {
      projectId: clone.pk_project,
      parentId: sourceId,
      projectName: clone.project_name,
      versionLabel: options.versionLabel ?? null,
      clonedBy: cloningUserId,
    });

    // Auto-provision SharePoint folders for the clone (fire-and-forget; never blocks).
    sharepointService.ensureProjectHierarchy(clone.pk_project)
      .then(summary => {
        velocityStreamManager.broadcast('sharepoint_folders_created', {
          projectId: clone.pk_project,
          projectName: clone.project_name,
          foldersCreated: summary.foldersCreated,
          foldersExisted: summary.foldersExisted,
          autoProvisioned: true,
        });
      })
      .catch(err => {
        logger.warn('SharePoint auto-provision skipped for clone', {
          projectId: clone.pk_project,
          error: (err as Error).message,
        });
      });

    return clone;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================================================
// VERSION LABEL (rename)
// ===========================================================================

export async function renameVersion(
  projectId: string,
  newLabel: string | null,
  userId: string,
  meta?: AuditMeta,
): Promise<{ project_version_label: string | null }> {
  const trimmed = newLabel?.trim() || null;

  // Capture the old label first, then update.
  const { rows: priorRows } = await pool.query<{ project_version_label: string | null }>(
    `SELECT project_version_label FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId],
  );
  if (priorRows.length === 0) throw AppError.notFound('Project not found');
  const oldLabel = priorRows[0].project_version_label;

  const { rows } = await pool.query<{ project_version_label: string | null }>(
    `UPDATE project SET project_version_label = $2, updated_by = $3
      WHERE pk_project = $1 AND is_deleted = false
      RETURNING project_version_label`,
    [projectId, trimmed, userId],
  );

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: projectId,
    userId,
    ipAddress: meta?.ipAddress,
    oldData: enrich(meta, { project_version_label: oldLabel }),
    newData: enrich(meta, { project_version_label: trimmed }),
  });

  velocityStreamManager.broadcast('version_renamed', {
    projectId,
    versionLabel: trimmed,
    renamedBy: userId,
  });

  return { project_version_label: rows[0].project_version_label };
}

// ===========================================================================
// CLUSTER QUERY
// ===========================================================================

export interface VersionRow {
  pk_project: string;
  project_name: string;
  project_code: string | null;
  project_version_label: string | null;
  project_status: string | null;
  project_percent_complete: number | null;
  project_is_locked: boolean;
  project_locked_by: string | null;
  fk_project_parent: string | null;
  project_cloned_at: string | null;
  project_cloned_by: string | null;
  active_member_count: number;
  primary_owner_email: string | null;
  primary_owner_name: string | null;
}

/**
 * Get every version in a cluster: parent + all clones (single-level).
 * If the supplied id is a clone, walks up to its parent first.
 */
export async function getCluster(projectId: string): Promise<{
  parent: VersionRow | null;
  versions: VersionRow[];
}> {
  // Resolve cluster root: if this is a clone, walk up to its parent.
  const { rows: rootRows } = await pool.query<{ root_id: string }>(
    `SELECT COALESCE(fk_project_parent, pk_project) AS root_id
       FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId],
  );
  if (rootRows.length === 0) throw AppError.notFound('Project not found');
  const rootId = rootRows[0].root_id;

  const { rows } = await pool.query<VersionRow>(
    `WITH cluster_projects AS (
       SELECT * FROM project
        WHERE (pk_project = $1 OR fk_project_parent = $1)
          AND is_deleted = false
     ),
     active_members AS (
       SELECT fk_pm_project, COUNT(*)::int AS member_count
         FROM project_member WHERE is_active = true
        GROUP BY fk_pm_project
     ),
     primary_owner AS (
       SELECT DISTINCT ON (pm.fk_pm_project)
              pm.fk_pm_project,
              ua.user_email_address,
              ua.user_display_name
         FROM project_member pm
         JOIN user_account ua ON ua.pk_user_account = pm.fk_pm_user
        WHERE pm.is_active = true AND pm.member_role = 'owner'
        ORDER BY pm.fk_pm_project, pm.added_at
     )
     SELECT cp.pk_project,
            cp.project_name,
            cp.project_code,
            cp.project_version_label,
            cp.project_status,
            cp.project_percent_complete,
            cp.project_is_locked,
            cp.project_locked_by,
            cp.fk_project_parent,
            cp.project_cloned_at,
            cp.project_cloned_by,
            COALESCE(am.member_count, 0) AS active_member_count,
            po.user_email_address AS primary_owner_email,
            po.user_display_name  AS primary_owner_name
       FROM cluster_projects cp
       LEFT JOIN active_members am ON am.fk_pm_project = cp.pk_project
       LEFT JOIN primary_owner  po ON po.fk_pm_project = cp.pk_project
      ORDER BY cp.fk_project_parent NULLS FIRST, cp.project_cloned_at NULLS FIRST, cp.created_at`,
    [rootId],
  );

  const parent = rows.find(r => r.fk_project_parent === null) ?? null;
  return { parent, versions: rows };
}

// ===========================================================================
// LOCK / UNLOCK
// ===========================================================================

export async function acquireLock(
  projectId: string,
  userId: string,
  reason: string | undefined,
  meta?: AuditMeta,
): Promise<{ project_is_locked: boolean; project_locked_by: string; project_locked_at: string; project_lock_reason: string | null }> {
  const { rows: existing } = await pool.query<{ project_is_locked: boolean; project_locked_by: string | null }>(
    `SELECT project_is_locked, project_locked_by FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId],
  );
  if (existing.length === 0) throw AppError.notFound('Project not found');

  if (existing[0].project_is_locked) {
    if (existing[0].project_locked_by === userId) {
      // Idempotent — already locked by self. Update reason if provided.
      if (reason !== undefined) {
        await pool.query(
          `UPDATE project SET project_lock_reason = $2 WHERE pk_project = $1`,
          [projectId, reason],
        );
      }
      const { rows } = await pool.query(
        `SELECT project_is_locked, project_locked_by, project_locked_at, project_lock_reason
           FROM project WHERE pk_project = $1`,
        [projectId],
      );
      return rows[0];
    }
    throw new AppError('Project is already locked by another user', 409, 'ALREADY_LOCKED');
  }

  const { rows } = await pool.query<{ project_is_locked: boolean; project_locked_by: string; project_locked_at: string; project_lock_reason: string | null }>(
    `UPDATE project
        SET project_is_locked = true,
            project_locked_by = $2,
            project_locked_at = NOW(),
            project_lock_reason = $3,
            updated_by = $2
      WHERE pk_project = $1 AND is_deleted = false AND project_is_locked = false
      RETURNING project_is_locked, project_locked_by, project_locked_at, project_lock_reason`,
    [projectId, userId, reason ?? null],
  );
  if (rows.length === 0) throw new AppError('Lock acquisition raced — try again', 409, 'LOCK_RACE');

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: projectId,
    userId,
    ipAddress: meta?.ipAddress,
    newData: enrich(meta, { project_is_locked: true, project_lock_reason: reason ?? null }),
  });

  velocityStreamManager.broadcast('lock_acquired', {
    projectId,
    lockedBy: userId,
    reason: reason ?? null,
  });

  return rows[0];
}

export async function releaseLock(
  projectId: string,
  userId: string,
  isAdmin: boolean,
  force: boolean,
  meta?: AuditMeta,
): Promise<void> {
  const { rows } = await pool.query<{ project_is_locked: boolean; project_locked_by: string | null }>(
    `SELECT project_is_locked, project_locked_by FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId],
  );
  if (rows.length === 0) throw AppError.notFound('Project not found');
  if (!rows[0].project_is_locked) return; // idempotent

  const lockedBy = rows[0].project_locked_by;
  const isOwnLock = lockedBy === userId;

  if (!isOwnLock && !(isAdmin && force)) {
    throw new AppError(
      `This lock was acquired by another user. Pass force=true as admin to override.`,
      403,
      'LOCK_OWNED_BY_OTHER',
    );
  }

  await pool.query(
    `UPDATE project
        SET project_is_locked = false,
            project_locked_by = NULL,
            project_locked_at = NULL,
            project_lock_reason = NULL,
            updated_by = $2
      WHERE pk_project = $1`,
    [projectId, userId],
  );

  // Admin force-unlock leaves a project_update of type 'decision' so the
  // original locker sees the override on their next visit.
  if (isAdmin && force && !isOwnLock && lockedBy) {
    await pool.query(
      `INSERT INTO project_update (
         fk_project_update_project, update_type, update_title, update_content,
         update_source, fk_project_update_user
       ) VALUES ($1, 'decision', $2, $3, 'manual', $4)`,
      [
        projectId,
        'Lock force-released by admin',
        `Admin user override on a lock held by user ${lockedBy}.`,
        userId,
      ],
    );
  }

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: projectId,
    userId,
    ipAddress: meta?.ipAddress,
    oldData: enrich(meta, { project_is_locked: true, project_locked_by: lockedBy }),
    newData: enrich(meta, { project_is_locked: false, force_released: !isOwnLock }),
  });

  velocityStreamManager.broadcast('lock_released', {
    projectId,
    releasedBy: userId,
    forceReleased: !isOwnLock && isAdmin && force,
    previousLocker: lockedBy,
  });
}

// ===========================================================================
// CLONE POLICY
// ===========================================================================

export async function setClonePolicy(
  projectId: string,
  disabled: boolean,
  reason: string | null,
  adminUserId: string,
  meta?: AuditMeta,
): Promise<{ project_clone_disabled: boolean; project_clone_disabled_by: string | null; project_clone_disabled_at: string | null; project_clone_disabled_reason: string | null }> {
  const { rows: prior } = await pool.query<{ project_clone_disabled: boolean }>(
    `SELECT project_clone_disabled FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId],
  );
  if (prior.length === 0) throw AppError.notFound('Project not found');

  const sql = disabled
    ? `UPDATE project
          SET project_clone_disabled = true,
              project_clone_disabled_by = $2,
              project_clone_disabled_at = NOW(),
              project_clone_disabled_reason = $3,
              updated_by = $2
        WHERE pk_project = $1
        RETURNING project_clone_disabled, project_clone_disabled_by, project_clone_disabled_at, project_clone_disabled_reason`
    : `UPDATE project
          SET project_clone_disabled = false,
              project_clone_disabled_by = NULL,
              project_clone_disabled_at = NULL,
              project_clone_disabled_reason = NULL,
              updated_by = $2
        WHERE pk_project = $1
        RETURNING project_clone_disabled, project_clone_disabled_by, project_clone_disabled_at, project_clone_disabled_reason`;

  const params = disabled ? [projectId, adminUserId, reason] : [projectId, adminUserId];
  const { rows } = await pool.query(sql, params);

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: projectId,
    userId: adminUserId,
    ipAddress: meta?.ipAddress,
    oldData: enrich(meta, { project_clone_disabled: prior[0].project_clone_disabled }),
    newData: enrich(meta, { project_clone_disabled: disabled, reason }),
  });

  velocityStreamManager.broadcast('clone_policy_changed', {
    projectId,
    disabled,
    reason,
    by: adminUserId,
  });

  return rows[0];
}
