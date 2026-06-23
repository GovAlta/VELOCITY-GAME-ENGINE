import { pool } from '../config/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModuleVelocityRecord {
  pk_module_velocity: string;
  fk_mv_module: string;
  step_name: string;
  step_order: number;
  status: string;
  current_actor: string | null;
  loop_count: number;
  started_at: string | null;
  completed_at: string | null;
  turn_count: number;
  is_locked: boolean;
  requires_human_approval: boolean;
  requires_ai_recommendation: boolean;
  step_weight: number;
  blocked_reason: string | null;
  blocked_since: string | null;
  created_at: string;
  updated_at: string;
}

export interface VelocityTurnRecord {
  pk_velocity_turn: string;
  fk_turn_module_velocity: string;
  fk_turn_module: string;
  fk_turn_project: string;
  turn_actor: string;
  turn_action: string;
  turn_from_status: string | null;
  turn_to_status: string | null;
  turn_content: string | null;
  turn_content_json: Record<string, unknown> | null;
  turn_attachments: unknown[] | null;
  turn_user_id: string | null;
  turn_api_key_id: string | null;
  created_at: string;
}

export interface ModuleVelocityWithMeta extends ModuleVelocityRecord {
  module_name: string;
  project_name: string;
  pk_project?: string;
  // Lineage (populated by findDashboard for board grouping)
  fk_project_parent?: string | null;
  project_version_label?: string | null;
  project_cloned_from_name?: string | null;
  project_is_locked?: boolean;
  project_locked_by?: string | null;
  module_is_mission_critical?: boolean;
  project_is_mission_critical?: boolean;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Find all module_velocity rows for all modules in a project,
 * joined with module name. ORDER BY module name then step_order.
 */
export async function findProjectVelocity(
  projectId: string
): Promise<ModuleVelocityWithMeta[]> {
  const result = await pool.query<ModuleVelocityWithMeta>(
    `SELECT
       mv.*,
       m.module_name,
       p.project_name
     FROM module_velocity mv
     JOIN module m ON mv.fk_mv_module = m.pk_module
     JOIN project p ON m.fk_module_project = p.pk_project
     WHERE m.fk_module_project = $1
       AND m.is_deleted = false
     ORDER BY m.module_name ASC, mv.step_order ASC`,
    [projectId]
  );
  return result.rows;
}

/**
 * Find the 8 module_velocity rows for a single module, ordered by step_order.
 */
export async function findModuleSteps(
  moduleId: string
): Promise<ModuleVelocityRecord[]> {
  const result = await pool.query<ModuleVelocityRecord>(
    `SELECT mv.*
     FROM module_velocity mv
     WHERE mv.fk_mv_module = $1
     ORDER BY mv.step_order ASC`,
    [moduleId]
  );
  return result.rows;
}

/**
 * Find a single step by module and step_name.
 * Accepts a PoolClient for transactional use with FOR UPDATE.
 */
export async function findStepByModuleAndName(
  moduleId: string,
  stepName: string,
  client?: { query: typeof pool.query }
): Promise<ModuleVelocityRecord | null> {
  const db = client || pool;
  const result = await db.query<ModuleVelocityRecord>(
    `SELECT mv.*
     FROM module_velocity mv
     WHERE mv.fk_mv_module = $1
       AND mv.step_name = $2
     ${client ? 'FOR UPDATE' : ''}`,
    [moduleId, stepName]
  );
  return result.rows[0] || null;
}

/**
 * Update a module_velocity step.
 */
export async function updateStep(
  pkModuleVelocity: string,
  data: {
    status?: string;
    current_actor?: string | null;
    loop_count?: number;
    started_at?: string | null;
    completed_at?: string | null;
    is_locked?: boolean;
    requires_human_approval?: boolean;
    requires_ai_recommendation?: boolean;
    step_weight?: number;
    blocked_reason?: string | null;
    blocked_since?: string | null;
  },
  client?: { query: typeof pool.query }
): Promise<ModuleVelocityRecord> {
  const db = client || pool;
  const result = await db.query<ModuleVelocityRecord>(
    `UPDATE module_velocity SET
       status = COALESCE($2, status),
       current_actor = COALESCE($3, current_actor),
       loop_count = COALESCE($4, loop_count),
       started_at = COALESCE($5, started_at),
       completed_at = COALESCE($6, completed_at),
       is_locked = COALESCE($7, is_locked),
       updated_at = NOW()
     WHERE pk_module_velocity = $1
     RETURNING *`,
    [
      pkModuleVelocity,
      data.status ?? null,
      data.current_actor !== undefined ? data.current_actor : null,
      data.loop_count ?? null,
      data.started_at !== undefined ? data.started_at : null,
      data.completed_at !== undefined ? data.completed_at : null,
      data.is_locked !== undefined ? data.is_locked : null,
    ]
  );
  return result.rows[0];
}

/**
 * Create a velocity turn record.
 */
export async function createTurn(
  data: {
    fk_turn_module_velocity: string;
    fk_turn_module: string;
    fk_turn_project: string;
    turn_actor: string;
    turn_action: string;
    turn_from_status: string | null;
    turn_to_status: string | null;
    turn_content: string | null;
    turn_content_json: Record<string, unknown> | null;
    turn_attachments: unknown[] | null;
    turn_user_id: string | null;
    turn_api_key_id: string | null;
    turn_is_aligned?: boolean | null;
  },
  client?: { query: typeof pool.query }
): Promise<VelocityTurnRecord> {
  const db = client || pool;
  const result = await db.query<VelocityTurnRecord>(
    `INSERT INTO velocity_turn (
       fk_turn_module_velocity,
       fk_turn_module,
       fk_turn_project,
       turn_actor,
       turn_action,
       turn_from_status,
       turn_to_status,
       turn_content,
       turn_content_json,
       turn_attachments,
       turn_user_id,
       turn_api_key_id,
       turn_is_aligned
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      data.fk_turn_module_velocity,
      data.fk_turn_module,
      data.fk_turn_project,
      data.turn_actor,
      data.turn_action,
      data.turn_from_status,
      data.turn_to_status,
      data.turn_content,
      data.turn_content_json ? JSON.stringify(data.turn_content_json) : null,
      data.turn_attachments ? JSON.stringify(data.turn_attachments) : null,
      data.turn_user_id,
      data.turn_api_key_id,
      data.turn_is_aligned ?? null,
    ]
  );
  return result.rows[0];
}

/**
 * Find paginated turns for a specific module_velocity step.
 */
export async function findTurnsByStep(
  mvId: string,
  page: number,
  limit: number
): Promise<VelocityTurnRecord[]> {
  const offset = (page - 1) * limit;
  const result = await pool.query<VelocityTurnRecord>(
    `SELECT vt.*, ua.user_email_address AS turn_user_email, ua.user_display_name AS turn_user_name
     FROM velocity_turn vt
     LEFT JOIN user_account ua ON vt.turn_user_id = ua.pk_user_account
     WHERE vt.fk_turn_module_velocity = $1
     ORDER BY vt.created_at DESC
     LIMIT $2 OFFSET $3`,
    [mvId, limit, offset]
  );
  return result.rows;
}

/**
 * Find paginated turns for all steps of a module.
 */
export async function findTurnsByModule(
  moduleId: string,
  page: number,
  limit: number
): Promise<VelocityTurnRecord[]> {
  const offset = (page - 1) * limit;
  const result = await pool.query<VelocityTurnRecord>(
    `SELECT vt.*, ua.user_email_address AS turn_user_email, ua.user_display_name AS turn_user_name
     FROM velocity_turn vt
     LEFT JOIN user_account ua ON vt.turn_user_id = ua.pk_user_account
     WHERE vt.fk_turn_module = $1
     ORDER BY vt.created_at DESC
     LIMIT $2 OFFSET $3`,
    [moduleId, limit, offset]
  );
  return result.rows;
}

/**
 * Count turns for a specific step (for pagination).
 */
export async function countTurnsByStep(mvId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM velocity_turn WHERE fk_turn_module_velocity = $1`,
    [mvId]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Count turns for a module (for pagination).
 */
export async function countTurnsByModule(moduleId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM velocity_turn WHERE fk_turn_module = $1`,
    [moduleId]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Dashboard: for each project, for each module, get all 8 step statuses.
 * Returns flat rows with project_name, module_name, and step columns.
 */
export interface ModuleMetrics {
  fk_mvm_module: string;
  loopback_count: number;
  total_turns: number;
  ai_time_seconds: number;
  human_time_seconds: number;
  current_step_name: string | null;
  velocity_score: number;
  velocity_bonus: number;
  velocity_penalty: number;
  alignment_count: number;
  misalignment_count: number;
  outcome_score: number | null;
}

export async function findDashboard(): Promise<ModuleVelocityWithMeta[]> {
  const result = await pool.query<ModuleVelocityWithMeta>(
    `SELECT
       mv.*,
       m.module_name,
       m.module_is_mission_critical,
       p.pk_project,
       p.project_name,
       p.project_is_mission_critical,
       p.fk_project_parent,
       p.project_version_label,
       p.project_cloned_from_name,
       p.project_is_locked,
       p.project_locked_by
     FROM module_velocity mv
     JOIN module m ON mv.fk_mv_module = m.pk_module
     JOIN project p ON m.fk_module_project = p.pk_project
     WHERE m.is_deleted = false
       AND p.is_deleted = false
       AND p.project_status NOT IN ('completion', 'on_hold', 'cancelled')
     ORDER BY COALESCE(p.fk_project_parent, p.pk_project) ASC,
              p.fk_project_parent NULLS FIRST,
              p.project_name ASC, m.module_name ASC, mv.step_order ASC`
  );
  return result.rows;
}

export async function findModuleMetrics(moduleIds: string[]): Promise<ModuleMetrics[]> {
  if (moduleIds.length === 0) return [];
  const result = await pool.query<ModuleMetrics>(
    `SELECT fk_mvm_module, loopback_count, total_turns, ai_time_seconds, human_time_seconds, current_step_name,
            velocity_score, velocity_bonus, velocity_penalty, alignment_count, misalignment_count, outcome_score
     FROM module_velocity_metrics
     WHERE fk_mvm_module = ANY($1)`,
    [moduleIds]
  );
  return result.rows;
}
