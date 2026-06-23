import { pool } from '../config/database';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  user_id: string;
  user_display_name: string;
  user_email_address: string;
  avatar_url: string | null;
  total_points: number;
  velocity_points: number;
  challenge_points: number;
  bonus_points: number;
  penalty_points: number;
  cheating_penalty_points: number;
  modules_completed: number;
  challenges_completed: number;
  projects_touched: number;
  violations_count: number;
  rank?: number;
}

export interface PointEvent {
  userId: string;
  points: number;
  source: 'velocity_step' | 'velocity_bonus' | 'velocity_penalty' | 'challenge_complete' | 'challenge_bonus' | 'manual' | 'cheating_penalty';
  description?: string;
  projectId?: string;
  moduleId?: string;
  stepName?: string;
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/**
 * Record a point event for a user.
 */
export async function awardPoints(event: PointEvent): Promise<void> {
  await pool.query(
    `INSERT INTO user_points (fk_up_user, points, source, description, fk_up_project, fk_up_module, step_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [event.userId, event.points, event.source, event.description || null,
     event.projectId || null, event.moduleId || null, event.stepName || null]
  );
}

/**
 * Get total points for a user.
 */
export async function getUserPoints(userId: string): Promise<number> {
  const res = await pool.query(
    'SELECT COALESCE(SUM(points), 0) AS total FROM user_points WHERE fk_up_user = $1',
    [userId]
  );
  return parseInt(res.rows[0].total, 10);
}

/**
 * Get point history for a user (most recent first).
 */
export async function getUserPointHistory(userId: string, limit = 50): Promise<any[]> {
  const res = await pool.query(
    `SELECT up.*, p.project_name, m.module_name
     FROM user_points up
     LEFT JOIN project p ON p.pk_project = up.fk_up_project
     LEFT JOIN module m ON m.pk_module = up.fk_up_module
     WHERE up.fk_up_user = $1
     ORDER BY up.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * Get all contributors to a module with their point breakdown.
 */
export async function getModuleContributors(moduleId: string): Promise<any[]> {
  const res = await pool.query(
    `SELECT
       up.fk_up_user AS user_id,
       ua.user_display_name,
       ua.user_email_address,
       SUM(up.points)::int AS total_points,
       COUNT(*)::int AS actions,
       json_agg(json_build_object(
         'points', up.points,
         'source', up.source,
         'description', up.description,
         'step', up.step_name,
         'date', up.created_at
       ) ORDER BY up.created_at DESC) AS history
     FROM user_points up
     JOIN user_account ua ON ua.pk_user_account = up.fk_up_user
     WHERE up.fk_up_module = $1
     GROUP BY up.fk_up_user, ua.user_display_name, ua.user_email_address
     ORDER BY total_points DESC`,
    [moduleId]
  );
  return res.rows;
}

/**
 * Get all contributors to a project with their point breakdown.
 */
export async function getProjectContributors(projectId: string): Promise<any[]> {
  const res = await pool.query(
    `SELECT
       up.fk_up_user AS user_id,
       ua.user_display_name,
       ua.user_email_address,
       SUM(up.points)::int AS total_points,
       COUNT(*)::int AS actions,
       COUNT(DISTINCT up.fk_up_module)::int AS modules_touched,
       json_agg(DISTINCT up.step_name) FILTER (WHERE up.step_name IS NOT NULL) AS steps
     FROM user_points up
     JOIN user_account ua ON ua.pk_user_account = up.fk_up_user
     WHERE up.fk_up_project = $1
     GROUP BY up.fk_up_user, ua.user_display_name, ua.user_email_address
     ORDER BY total_points DESC`,
    [projectId]
  );
  return res.rows;
}

/**
 * Get the leaderboard (top users by points).
 * Supports date range filtering for month/year/all-time views.
 */
export async function getLeaderboard(
  limit = 50,
  period?: 'month' | 'year' | 'all'
): Promise<LeaderboardEntry[]> {
  // For all-time with no filter, try materialized view
  if (!period || period === 'all') {
    try {
      const res = await pool.query(
        `SELECT *, ROW_NUMBER() OVER (ORDER BY total_points DESC) AS rank
         FROM leaderboard
         ORDER BY total_points DESC
         LIMIT $1`,
        [limit]
      );
      return res.rows;
    } catch {
      return getLiveLeaderboard(limit);
    }
  }

  // For month/year, use live query with date filter
  return getLiveLeaderboard(limit, period);
}

async function getLiveLeaderboard(limit: number, period?: 'month' | 'year'): Promise<LeaderboardEntry[]> {
  let dateFilter = '';
  const params: any[] = [];
  let paramIdx = 1;

  if (period === 'month') {
    dateFilter = `AND up.created_at >= date_trunc('month', CURRENT_DATE)`;
  } else if (period === 'year') {
    dateFilter = `AND up.created_at >= date_trunc('year', CURRENT_DATE)`;
  }

  params.push(limit);

  // Live query — used for the month/year periods (no MV available). Returns
  // the same shape as the all-time MV path, including violations_count and
  // cheating_penalty_points, and includes users with negative totals so
  // post-Reaper cheaters remain visible.
  const res = await pool.query(
    `SELECT
       ua.pk_user_account AS user_id,
       ua.user_display_name,
       ua.user_email_address,
       ua.avatar_url,
       COALESCE(SUM(up.points), 0)::int AS total_points,
       COALESCE(SUM(up.points) FILTER (WHERE up.source = 'velocity_step'), 0)::int AS velocity_points,
       COALESCE(SUM(up.points) FILTER (WHERE up.source IN ('challenge_complete', 'challenge_bonus')), 0)::int AS challenge_points,
       COALESCE(SUM(up.points) FILTER (WHERE up.source = 'velocity_bonus'), 0)::int AS bonus_points,
       COALESCE(SUM(up.points) FILTER (WHERE up.source = 'velocity_penalty'), 0)::int AS penalty_points,
       COALESCE(SUM(up.points) FILTER (WHERE up.source = 'cheating_penalty'), 0)::int AS cheating_penalty_points,
       COUNT(DISTINCT up.fk_up_module) FILTER (WHERE up.source = 'velocity_step')::int AS modules_completed,
       COUNT(DISTINCT up.fk_up_project) FILTER (WHERE up.source = 'challenge_complete')::int AS challenges_completed,
       COUNT(DISTINCT up.fk_up_project)::int AS projects_touched,
       COALESCE(cv.violations_count, 0)::int AS violations_count,
       ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(up.points), 0) DESC) AS rank
     FROM user_account ua
     LEFT JOIN user_points up ON up.fk_up_user = ua.pk_user_account ${dateFilter}
     LEFT JOIN (
       SELECT fk_cv_user, COUNT(*) AS violations_count
         FROM cheating_violation
        GROUP BY fk_cv_user
     ) cv ON cv.fk_cv_user = ua.pk_user_account
     WHERE ua.is_deleted = false AND ua.is_active = true
     GROUP BY ua.pk_user_account, cv.violations_count
     HAVING COALESCE(SUM(up.points), 0) <> 0 OR COALESCE(cv.violations_count, 0) > 0
     ORDER BY total_points DESC
     LIMIT $1`,
    params
  );
  return res.rows;
}

/**
 * Refresh the materialized leaderboard view.
 */
export async function refreshLeaderboard(): Promise<void> {
  try {
    await pool.query('SELECT refresh_leaderboard()');
  } catch (err) {
    logger.warn('Failed to refresh leaderboard view', { error: (err as Error).message });
  }
}

/**
 * List every detected cheating violation, newest first. Joined with user
 * + project + module names so the admin UI can render a forensic table
 * without N+1 follow-up queries.
 */
/**
 * Get a single user's cheating violations grouped by rule, plus the most
 * recent N example rows. Public — visible to every authenticated user
 * because the Skull badge and Violations count are already public; this
 * just lets the curious see *which* rules fired.
 */
export async function listUserViolations(userId: string, examplesPerType = 5): Promise<{
  summary: Array<{ type: string; count: number; total_inverted: number }>;
  examples: any[];
}> {
  const summary = await pool.query<{ type: string; count: number; total_inverted: number }>(
    `SELECT violation_type           AS type,
            COUNT(*)::int            AS count,
            SUM(inverted_points)::int AS total_inverted
       FROM cheating_violation
      WHERE fk_cv_user = $1
      GROUP BY violation_type
      ORDER BY SUM(inverted_points) ASC`,
    [userId],
  );

  // Top N most-painful examples per type — handy for showing "where" it fired.
  const examples = await pool.query(
    `WITH ranked AS (
       SELECT cv.violation_type,
              cv.original_points,
              cv.inverted_points,
              cv.evidence,
              cv.detected_at,
              cv.fk_cv_project        AS project_id,
              p.project_name,
              cv.fk_cv_module         AS module_id,
              m.module_name,
              mv.step_name,
              ROW_NUMBER() OVER (
                PARTITION BY cv.violation_type
                ORDER BY cv.inverted_points ASC
              ) AS rn
         FROM cheating_violation cv
         LEFT JOIN project p  ON p.pk_project    = cv.fk_cv_project
         LEFT JOIN module  m  ON m.pk_module     = cv.fk_cv_module
         LEFT JOIN module_velocity mv ON mv.pk_module_velocity = cv.fk_cv_module_velocity
        WHERE cv.fk_cv_user = $1
     )
     SELECT violation_type AS type,
            original_points,
            inverted_points,
            evidence,
            detected_at,
            project_id,
            project_name,
            module_id,
            module_name,
            step_name
       FROM ranked
      WHERE rn <= $2::int
      ORDER BY violation_type, inverted_points ASC`,
    [userId, examplesPerType],
  );

  return { summary: summary.rows, examples: examples.rows };
}

export async function listViolations(limit = 200): Promise<any[]> {
  const res = await pool.query(
    `SELECT cv.pk_cheating_violation AS id,
            cv.violation_type        AS type,
            cv.original_points       AS original_points,
            cv.inverted_points       AS inverted_points,
            cv.evidence              AS evidence,
            cv.detected_at           AS detected_at,
            cv.fk_cv_user            AS user_id,
            ua.user_display_name     AS user_display_name,
            ua.user_email_address    AS user_email_address,
            cv.fk_cv_project         AS project_id,
            p.project_name           AS project_name,
            cv.fk_cv_module          AS module_id,
            m.module_name            AS module_name,
            cv.fk_cv_module_velocity AS step_id,
            mv.step_name             AS step_name,
            cv.detected_by           AS detected_by_user_id,
            db.user_display_name     AS detected_by_display_name
       FROM cheating_violation cv
       JOIN user_account ua ON ua.pk_user_account = cv.fk_cv_user
       LEFT JOIN project p  ON p.pk_project    = cv.fk_cv_project
       LEFT JOIN module  m  ON m.pk_module     = cv.fk_cv_module
       LEFT JOIN module_velocity mv ON mv.pk_module_velocity = cv.fk_cv_module_velocity
       LEFT JOIN user_account db ON db.pk_user_account = cv.detected_by
      ORDER BY cv.detected_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows;
}
