import { pool } from '../config/database';
import logger from '../utils/logger';

/**
 * The Reaper.
 *
 * A full-corpus audit, triggered by an admin, that walks every completed
 * velocity step + every module + every project looking for evidence of
 * point-farming or non-collaborative play.
 *
 * Detection rules:
 *
 *   speed_run       — completed step where every turn was made by the same
 *                     `ai` actor (no human collaboration).
 *   no_artifact     — completed step with zero attachments across all turns.
 *   no_collaboration— completed step touched by only one distinct actor.
 *                     (Distinct from speed_run because the lone actor may
 *                     be human.)
 *   blank_module    — module with at least one completed step but minimal
 *                     turn content (<5 total turns) AND minimal metadata
 *                     (description + plan + progress combined < 100 chars).
 *   project_module_overflow
 *                   — project with >= 10 modules (including soft-deleted ones,
 *                     since deleting modules after farming is itself a cheat
 *                     pattern — the points persist in user_points even after
 *                     the source module is removed).
 *
 * For each detected violation:
 *
 *   1. Inserts a row into `cheating_violation` (audit + idempotency).
 *   2. Inserts a paired `user_points` row with negative
 *      `cheating_penalty` value, sized so the offending user's net points
 *      for that scope flip from +N to -N (insertion = -2 * original).
 *   3. The leaderboard materialized view is refreshed once at the end so
 *      the UI shows updated `violations_count` and adjusted totals.
 *
 * Idempotent. Unique constraints on (user, scope, type) prevent
 * double-flagging — re-running only appends new findings.
 *
 * Implementation note (perf): each rule runs as a SINGLE compound SQL
 * statement using CTEs. Earlier per-step JS loops produced thousands of
 * sequential round-trips against the DB and took minutes on a few hundred
 * completed steps; the bulk-CTE version is one round-trip per rule.
 */

export type ViolationType =
  | 'speed_run'
  | 'no_artifact'
  | 'no_collaboration'
  | 'blank_module'
  | 'project_module_overflow'
  | 'empty_content'
  | 'burst_turns'
  | 'self_approval';

export interface ReaperReport {
  scannedProjects: number;
  scannedModules: number;
  scannedSteps: number;
  violationsCreated: number;
  pointsInverted: number;
  breakdown: Record<ViolationType, number>;
  perUser: Array<{ userId: string; userDisplayName: string; violations: number; pointsInverted: number }>;
}

const PENALTY_MULTIPLIER = 2;           // +N earned → -N total ≡ subtract 2N
const BLANK_MODULE_TURN_THRESHOLD = 5;
const BLANK_MODULE_METADATA_CHARS = 100;
const PROJECT_MODULE_OVERFLOW_THRESHOLD = 10;
// empty_content: a step is flagged if the offending user's turns there are
// >= EMPTY_CONTENT_PCT empty/near-empty (<50 chars) AND >= EMPTY_CONTENT_MIN_TURNS
// total. Catches farming via blank turn spam without false-positiving a single
// quick "ok" reply.
const EMPTY_CONTENT_PCT_THRESHOLD = 0.8;
const EMPTY_CONTENT_MIN_TURNS = 3;
const EMPTY_CONTENT_CHAR_THRESHOLD = 50;
// burst_turns: >= BURST_MIN_TURNS turns within BURST_WINDOW_SEC seconds.
const BURST_WINDOW_SEC = 5;
const BURST_MIN_TURNS = 3;

interface BulkResultRow {
  violation_type: ViolationType;
  count: number;
  total_original: number;
}

/**
 * Apply the aggregated insert result to the running report. Each detection
 * function returns one row per distinct violation type emitted (so 0, 1,
 * or 2 rows depending on the rule — solo completions can yield both
 * `speed_run` and `no_collaboration` in one go).
 */
function applyResult(rows: BulkResultRow[], out: ReaperReport): void {
  for (const r of rows) {
    if (!r.count) continue;
    out.breakdown[r.violation_type] = (out.breakdown[r.violation_type] || 0) + r.count;
    out.violationsCreated += r.count;
    out.pointsInverted += r.total_original * PENALTY_MULTIPLIER;
  }
}

/**
 * Rules 1 + 3: speed_run / no_collaboration.
 *
 * Find every completed step whose turn history contains exactly one
 * distinct actor. `actor = 'ai'` → speed_run. `actor = 'human'` →
 * no_collaboration.
 *
 * Bulk-insert both kinds in a single statement. Pairs each new violation
 * with a `cheating_penalty` user_points row in the same transaction.
 */
async function detectSoloCompletions(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH solo_completions AS (
       SELECT mv.pk_module_velocity AS step_id,
              m.pk_module           AS module_id,
              m.fk_module_project   AS project_id,
              mv.step_name          AS step_name,
              CASE
                WHEN ARRAY_AGG(DISTINCT vt.turn_actor) = ARRAY['ai']::varchar[]
                  THEN 'speed_run'::varchar
                WHEN ARRAY_AGG(DISTINCT vt.turn_actor) = ARRAY['human']::varchar[]
                  THEN 'no_collaboration'::varchar
              END AS violation_type,
              ARRAY_AGG(DISTINCT vt.turn_actor) AS actors
         FROM module_velocity mv
         JOIN module m ON m.pk_module = mv.fk_mv_module
         JOIN velocity_turn vt ON vt.fk_turn_module_velocity = mv.pk_module_velocity
        WHERE mv.status = 'completed'
          AND m.is_deleted = false
        GROUP BY mv.pk_module_velocity, m.pk_module, m.fk_module_project, mv.step_name
       HAVING COUNT(DISTINCT vt.turn_actor) = 1
     ),
     earners AS (
       SELECT sc.step_id, sc.module_id, sc.project_id, sc.step_name,
              sc.violation_type, sc.actors,
              up.fk_up_user        AS user_id,
              SUM(up.points)::int  AS total
         FROM solo_completions sc
         JOIN user_points up
           ON up.fk_up_module = sc.module_id
          AND up.step_name    = sc.step_name
          AND up.source      <> 'cheating_penalty'
          AND up.points       > 0
        WHERE sc.violation_type IS NOT NULL
        GROUP BY sc.step_id, sc.module_id, sc.project_id, sc.step_name,
                 sc.violation_type, sc.actors, up.fk_up_user
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, module_id, step_id,
              violation_type, total, -$1::int * total,
              jsonb_build_object('actors', actors, 'stepName', step_name),
              $2::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
                 violation_type, original_points, inverted_points
     ),
     new_violations_with_step AS (
       SELECT nv.*, mv.step_name
         FROM new_violations nv
         LEFT JOIN module_velocity mv ON mv.pk_module_velocity = nv.fk_cv_module_velocity
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: ' || violation_type || ' (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, step_name
         FROM new_violations_with_step
       RETURNING pk_user_points
     )
     SELECT violation_type,
            COUNT(*)::int             AS count,
            SUM(original_points)::int AS total_original
       FROM new_violations
      GROUP BY violation_type`,
    [PENALTY_MULTIPLIER, detectedBy],
  );
  return r.rows;
}

/**
 * Rule 2: no_artifact.
 *
 * Completed step with zero attachments across all of its velocity_turn
 * rows. Flag every user who earned points on that step.
 */
async function detectNoArtifact(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH no_artifact_steps AS (
       SELECT mv.pk_module_velocity AS step_id,
              m.pk_module           AS module_id,
              m.fk_module_project   AS project_id,
              mv.step_name          AS step_name
         FROM module_velocity mv
         JOIN module m ON m.pk_module = mv.fk_mv_module
         LEFT JOIN velocity_turn vt
           ON vt.fk_turn_module_velocity = mv.pk_module_velocity
        WHERE mv.status = 'completed'
          AND m.is_deleted = false
        GROUP BY mv.pk_module_velocity, m.pk_module, m.fk_module_project, mv.step_name
       HAVING COALESCE(SUM(
                CASE WHEN vt.turn_attachments IS NULL THEN 0
                     WHEN jsonb_typeof(vt.turn_attachments) = 'array'
                       THEN jsonb_array_length(vt.turn_attachments)
                     ELSE 0
                END
              ), 0) = 0
     ),
     earners AS (
       SELECT s.step_id, s.module_id, s.project_id, s.step_name,
              up.fk_up_user       AS user_id,
              SUM(up.points)::int AS total
         FROM no_artifact_steps s
         JOIN user_points up
           ON up.fk_up_module = s.module_id
          AND up.step_name    = s.step_name
          AND up.source      <> 'cheating_penalty'
          AND up.points       > 0
        GROUP BY s.step_id, s.module_id, s.project_id, s.step_name, up.fk_up_user
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, module_id, step_id,
              'no_artifact', total, -$1::int * total,
              jsonb_build_object('stepName', step_name, 'attachmentCount', 0),
              $2::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
                 violation_type, original_points, inverted_points
     ),
     new_violations_with_step AS (
       SELECT nv.*, mv.step_name
         FROM new_violations nv
         LEFT JOIN module_velocity mv ON mv.pk_module_velocity = nv.fk_cv_module_velocity
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: no_artifact (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, step_name
         FROM new_violations_with_step
       RETURNING pk_user_points
     )
     SELECT 'no_artifact'::varchar         AS violation_type,
            COUNT(*)::int                  AS count,
            COALESCE(SUM(original_points), 0)::int AS total_original
       FROM new_violations`,
    [PENALTY_MULTIPLIER, detectedBy],
  );
  return r.rows;
}

/**
 * Rule 4: blank_module.
 *
 * Module with at least one completed step but minimal turn content
 * (<BLANK_MODULE_TURN_THRESHOLD total turns across all 8 steps) AND
 * minimal module metadata (description + plan + progress combined
 * < BLANK_MODULE_METADATA_CHARS chars).
 *
 * Flag every user who earned points anywhere in the module.
 */
async function detectBlankModule(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH module_stats AS (
       SELECT m.pk_module           AS module_id,
              m.fk_module_project   AS project_id,
              (SELECT COUNT(*)::int FROM velocity_turn vt
                 WHERE vt.fk_turn_module = m.pk_module)        AS total_turns,
              (SELECT COUNT(*)::int FROM module_velocity mv
                 WHERE mv.fk_mv_module = m.pk_module
                   AND mv.status = 'completed')                AS completed_steps,
              (length(COALESCE(m.module_description, '')) +
               length(COALESCE(m.module_plan, '')) +
               length(COALESCE(m.module_progress, '')))         AS metadata_chars
         FROM module m
        WHERE m.is_deleted = false
     ),
     blank_modules AS (
       SELECT *
         FROM module_stats
        WHERE completed_steps >= 1
          AND total_turns      < $1::int
          AND metadata_chars   < $2::int
     ),
     earners AS (
       SELECT b.module_id, b.project_id, b.total_turns, b.completed_steps, b.metadata_chars,
              up.fk_up_user        AS user_id,
              SUM(up.points)::int  AS total
         FROM blank_modules b
         JOIN user_points up
           ON up.fk_up_module = b.module_id
          AND up.source      <> 'cheating_penalty'
          AND up.points       > 0
        GROUP BY b.module_id, b.project_id, b.total_turns, b.completed_steps, b.metadata_chars, up.fk_up_user
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, module_id, NULL,
              'blank_module', total, -$3::int * total,
              jsonb_build_object(
                'totalTurns', total_turns,
                'completedSteps', completed_steps,
                'metadataChars', metadata_chars
              ),
              $4::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module,
                 violation_type, original_points, inverted_points
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: blank_module (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, NULL
         FROM new_violations
       RETURNING pk_user_points
     )
     SELECT 'blank_module'::varchar        AS violation_type,
            COUNT(*)::int                  AS count,
            COALESCE(SUM(original_points), 0)::int AS total_original
       FROM new_violations`,
    [BLANK_MODULE_TURN_THRESHOLD, BLANK_MODULE_METADATA_CHARS, PENALTY_MULTIPLIER, detectedBy],
  );
  return r.rows;
}

/**
 * Rule 5: project_module_overflow.
 *
 * Projects with >= PROJECT_MODULE_OVERFLOW_THRESHOLD modules (including
 * soft-deleted ones). Counting deleted modules closes the "farm-then-delete"
 * loophole — a user who creates 400 modules, completes points on each, then
 * soft-deletes them should still be flagged. The earnings persist in
 * user_points; the audit follows the money, not the module's current state.
 */
async function detectProjectModuleOverflow(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH overflowing AS (
       SELECT m.fk_module_project AS project_id,
              COUNT(*)::int        AS module_count
         FROM module m
        GROUP BY m.fk_module_project
       HAVING COUNT(*) >= $1::int
     ),
     earners AS (
       SELECT o.project_id, o.module_count,
              up.fk_up_user       AS user_id,
              SUM(up.points)::int AS total
         FROM overflowing o
         JOIN user_points up
           ON up.fk_up_project = o.project_id
          AND up.source       <> 'cheating_penalty'
          AND up.points        > 0
        GROUP BY o.project_id, o.module_count, up.fk_up_user
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, NULL, NULL,
              'project_module_overflow', total, -$2::int * total,
              jsonb_build_object('moduleCount', module_count, 'threshold', $1::int),
              $3::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module,
                 violation_type, original_points, inverted_points
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: project_module_overflow (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, NULL
         FROM new_violations
       RETURNING pk_user_points
     )
     SELECT 'project_module_overflow'::varchar AS violation_type,
            COUNT(*)::int                      AS count,
            COALESCE(SUM(original_points), 0)::int AS total_original
       FROM new_violations`,
    [PROJECT_MODULE_OVERFLOW_THRESHOLD, PENALTY_MULTIPLIER, detectedBy],
  );
  return r.rows;
}

/**
 * Rule 6: empty_content.
 *
 * Completed step where the offending user's own turns are overwhelmingly
 * empty/near-empty. Threshold: at least EMPTY_CONTENT_MIN_TURNS user turns
 * on the step, and >= EMPTY_CONTENT_PCT_THRESHOLD of them are
 * under EMPTY_CONTENT_CHAR_THRESHOLD chars.
 *
 * Mykola-class farming pattern: 14,842/16,225 turns empty earning points
 * the existing rules couldn't see.
 */
async function detectEmptyContent(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH per_user_step AS (
       SELECT mv.pk_module_velocity AS step_id,
              m.pk_module           AS module_id,
              m.fk_module_project   AS project_id,
              mv.step_name          AS step_name,
              vt.turn_user_id       AS user_id,
              COUNT(*)::int         AS total_turns,
              COUNT(*) FILTER (
                WHERE length(COALESCE(vt.turn_content, '')) < $1::int
              )::int                AS empty_turns
         FROM module_velocity mv
         JOIN module m ON m.pk_module = mv.fk_mv_module
         JOIN velocity_turn vt
           ON vt.fk_turn_module_velocity = mv.pk_module_velocity
        WHERE mv.status = 'completed'
          AND m.is_deleted = false
          AND vt.turn_user_id IS NOT NULL
        GROUP BY mv.pk_module_velocity, m.pk_module, m.fk_module_project,
                 mv.step_name, vt.turn_user_id
       HAVING COUNT(*) >= $2::int
          AND (
            COUNT(*) FILTER (
              WHERE length(COALESCE(vt.turn_content, '')) < $1::int
            )::float / COUNT(*) >= $3::float
          )
     ),
     earners AS (
       SELECT pus.step_id, pus.module_id, pus.project_id, pus.step_name,
              pus.user_id, pus.total_turns, pus.empty_turns,
              SUM(up.points)::int AS total
         FROM per_user_step pus
         JOIN user_points up
           ON up.fk_up_user   = pus.user_id
          AND up.fk_up_module = pus.module_id
          AND up.step_name    = pus.step_name
          AND up.source      <> 'cheating_penalty'
          AND up.points       > 0
        GROUP BY pus.step_id, pus.module_id, pus.project_id, pus.step_name,
                 pus.user_id, pus.total_turns, pus.empty_turns
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, module_id, step_id,
              'empty_content', total, -$4::int * total,
              jsonb_build_object(
                'stepName', step_name,
                'totalTurns', total_turns,
                'emptyTurns', empty_turns,
                'charThreshold', $1::int
              ),
              $5::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
                 violation_type, original_points, inverted_points
     ),
     new_violations_with_step AS (
       SELECT nv.*, mv.step_name
         FROM new_violations nv
         LEFT JOIN module_velocity mv ON mv.pk_module_velocity = nv.fk_cv_module_velocity
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: empty_content (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, step_name
         FROM new_violations_with_step
       RETURNING pk_user_points
     )
     SELECT 'empty_content'::varchar       AS violation_type,
            COUNT(*)::int                  AS count,
            COALESCE(SUM(original_points), 0)::int AS total_original
       FROM new_violations`,
    [
      EMPTY_CONTENT_CHAR_THRESHOLD,
      EMPTY_CONTENT_MIN_TURNS,
      EMPTY_CONTENT_PCT_THRESHOLD,
      PENALTY_MULTIPLIER,
      detectedBy,
    ],
  );
  return r.rows;
}

/**
 * Rule 7: burst_turns.
 *
 * User submitted >= BURST_MIN_TURNS turns within BURST_WINDOW_SEC seconds
 * of each other on the same step. Detected via a self-join sliding window:
 * each turn t, count turns by same user on same step between t and t+window.
 * A step is flagged for a user once their max-density window meets the
 * threshold. Bot/script signal — humans don't sustain sub-second cadence.
 */
async function detectBurstTurns(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH dense AS (
       SELECT mv.pk_module_velocity AS step_id,
              m.pk_module           AS module_id,
              m.fk_module_project   AS project_id,
              mv.step_name          AS step_name,
              vt.turn_user_id       AS user_id,
              MAX(window_count) AS max_burst
         FROM module_velocity mv
         JOIN module m ON m.pk_module = mv.fk_mv_module
         JOIN velocity_turn vt
           ON vt.fk_turn_module_velocity = mv.pk_module_velocity
         JOIN LATERAL (
           SELECT COUNT(*)::int AS window_count
             FROM velocity_turn inner_vt
            WHERE inner_vt.fk_turn_module_velocity = vt.fk_turn_module_velocity
              AND inner_vt.turn_user_id            = vt.turn_user_id
              AND inner_vt.created_at >= vt.created_at
              AND inner_vt.created_at <  vt.created_at + ($1::int || ' seconds')::interval
         ) w ON true
        WHERE mv.status = 'completed'
          AND m.is_deleted = false
          AND vt.turn_user_id IS NOT NULL
        GROUP BY mv.pk_module_velocity, m.pk_module, m.fk_module_project,
                 mv.step_name, vt.turn_user_id
       HAVING MAX(window_count) >= $2::int
     ),
     earners AS (
       SELECT d.step_id, d.module_id, d.project_id, d.step_name, d.user_id, d.max_burst,
              SUM(up.points)::int AS total
         FROM dense d
         JOIN user_points up
           ON up.fk_up_user   = d.user_id
          AND up.fk_up_module = d.module_id
          AND up.step_name    = d.step_name
          AND up.source      <> 'cheating_penalty'
          AND up.points       > 0
        GROUP BY d.step_id, d.module_id, d.project_id, d.step_name, d.user_id, d.max_burst
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, module_id, step_id,
              'burst_turns', total, -$3::int * total,
              jsonb_build_object(
                'stepName', step_name,
                'maxBurst', max_burst,
                'windowSec', $1::int,
                'threshold', $2::int
              ),
              $4::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
                 violation_type, original_points, inverted_points
     ),
     new_violations_with_step AS (
       SELECT nv.*, mv.step_name
         FROM new_violations nv
         LEFT JOIN module_velocity mv ON mv.pk_module_velocity = nv.fk_cv_module_velocity
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: burst_turns (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, step_name
         FROM new_violations_with_step
       RETURNING pk_user_points
     )
     SELECT 'burst_turns'::varchar         AS violation_type,
            COUNT(*)::int                  AS count,
            COALESCE(SUM(original_points), 0)::int AS total_original
       FROM new_violations`,
    [BURST_WINDOW_SEC, BURST_MIN_TURNS, PENALTY_MULTIPLIER, detectedBy],
  );
  return r.rows;
}

/**
 * Rule 8: self_approval (AI-only).
 *
 * An AI agent both submitted (`review` or `pass`) AND approved
 * (`approve`) its own work on the same step, using the same API key.
 *
 * NOTE on what is intentionally NOT flagged: a *human* approving their
 * own AI agent's work is legitimate — the agent is the human's delegate,
 * and the human reviewing the agent's output is the design. We only
 * flag the case where a single API key produces both the submission and
 * the approval AND `turn_actor='ai'` on both sides. That's the agent
 * rubber-stamping itself.
 *
 * The penalty is attributed to the user who owns the API key
 * (`api_key.fk_api_key_user`), since that's whose leaderboard the
 * points came out of.
 */
async function detectSelfApproval(detectedBy: string): Promise<BulkResultRow[]> {
  const r = await pool.query<BulkResultRow>(
    `WITH per_apikey_step AS (
       SELECT mv.pk_module_velocity AS step_id,
              m.pk_module           AS module_id,
              m.fk_module_project   AS project_id,
              mv.step_name          AS step_name,
              vt.turn_api_key_id    AS api_key_id,
              ak.fk_api_key_user    AS user_id,
              COUNT(*) FILTER (WHERE vt.turn_action IN ('review', 'pass'))::int AS submissions,
              COUNT(*) FILTER (WHERE vt.turn_action = 'approve')::int           AS self_approvals
         FROM module_velocity mv
         JOIN module m ON m.pk_module = mv.fk_mv_module
         JOIN velocity_turn vt
           ON vt.fk_turn_module_velocity = mv.pk_module_velocity
         JOIN api_key ak
           ON ak.pk_api_key = vt.turn_api_key_id
        WHERE mv.status = 'completed'
          AND m.is_deleted = false
          AND vt.turn_api_key_id IS NOT NULL
          AND vt.turn_actor    = 'ai'
        GROUP BY mv.pk_module_velocity, m.pk_module, m.fk_module_project,
                 mv.step_name, vt.turn_api_key_id, ak.fk_api_key_user
       HAVING COUNT(*) FILTER (WHERE vt.turn_action IN ('review', 'pass')) > 0
          AND COUNT(*) FILTER (WHERE vt.turn_action = 'approve')           > 0
     ),
     earners AS (
       SELECT pas.step_id, pas.module_id, pas.project_id, pas.step_name,
              pas.api_key_id, pas.user_id, pas.submissions, pas.self_approvals,
              SUM(up.points)::int AS total
         FROM per_apikey_step pas
         JOIN user_points up
           ON up.fk_up_user   = pas.user_id
          AND up.fk_up_module = pas.module_id
          AND up.step_name    = pas.step_name
          AND up.source      <> 'cheating_penalty'
          AND up.points       > 0
        GROUP BY pas.step_id, pas.module_id, pas.project_id, pas.step_name,
                 pas.api_key_id, pas.user_id, pas.submissions, pas.self_approvals
       HAVING SUM(up.points) > 0
     ),
     new_violations AS (
       INSERT INTO cheating_violation
         (fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
          violation_type, original_points, inverted_points, evidence, detected_by)
       SELECT user_id, project_id, module_id, step_id,
              'self_approval', total, -$1::int * total,
              jsonb_build_object(
                'stepName', step_name,
                'apiKeyId', api_key_id,
                'submissions', submissions,
                'selfApprovals', self_approvals,
                'note', 'AI agent submitted AND approved on the same step'
              ),
              $2::uuid
         FROM earners
       ON CONFLICT DO NOTHING
       RETURNING fk_cv_user, fk_cv_project, fk_cv_module, fk_cv_module_velocity,
                 violation_type, original_points, inverted_points
     ),
     new_violations_with_step AS (
       SELECT nv.*, mv.step_name
         FROM new_violations nv
         LEFT JOIN module_velocity mv ON mv.pk_module_velocity = nv.fk_cv_module_velocity
     ),
     paired_points AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT fk_cv_user, inverted_points, 'cheating_penalty',
              'Reaper: self_approval (original ' || original_points || ')',
              fk_cv_project, fk_cv_module, step_name
         FROM new_violations_with_step
       RETURNING pk_user_points
     )
     SELECT 'self_approval'::varchar       AS violation_type,
            COUNT(*)::int                  AS count,
            COALESCE(SUM(original_points), 0)::int AS total_original
       FROM new_violations`,
    [PENALTY_MULTIPLIER, detectedBy],
  );
  return r.rows;
}

/**
 * Get the scanned-counts header for the report in one round-trip.
 */
async function getScannedCounts(): Promise<Pick<ReaperReport, 'scannedProjects' | 'scannedModules' | 'scannedSteps'>> {
  const r = await pool.query<{
    scanned_projects: number;
    scanned_modules: number;
    scanned_steps: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM project WHERE is_deleted = false) AS scanned_projects,
       (SELECT COUNT(*)::int FROM module  WHERE is_deleted = false) AS scanned_modules,
       (SELECT COUNT(*)::int FROM module_velocity mv
          JOIN module m ON m.pk_module = mv.fk_mv_module
         WHERE mv.status = 'completed' AND m.is_deleted = false) AS scanned_steps`,
  );
  const row = r.rows[0];
  return {
    scannedProjects: row.scanned_projects,
    scannedModules:  row.scanned_modules,
    scannedSteps:    row.scanned_steps,
  };
}

/**
 * Run the full Reaper. ~4 round-trips for the detection phase (one per
 * rule), plus a small counts query and the leaderboard MV refresh. Total
 * elapsed scales with rows-flagged, not rows-scanned.
 */
export async function runReaper(detectedByUserId: string): Promise<ReaperReport> {
  const t0 = Date.now();
  const scanned = await getScannedCounts();

  const out: ReaperReport = {
    ...scanned,
    violationsCreated: 0,
    pointsInverted: 0,
    breakdown: {
      speed_run: 0,
      no_artifact: 0,
      no_collaboration: 0,
      blank_module: 0,
      project_module_overflow: 0,
      empty_content: 0,
      burst_turns: 0,
      self_approval: 0,
    },
    perUser: [],
  };

  logger.info('Reaper run started', { detectedBy: detectedByUserId, ...scanned });

  applyResult(await detectSoloCompletions(detectedByUserId), out);
  applyResult(await detectNoArtifact(detectedByUserId), out);
  applyResult(await detectBlankModule(detectedByUserId), out);
  applyResult(await detectProjectModuleOverflow(detectedByUserId), out);
  applyResult(await detectEmptyContent(detectedByUserId), out);
  applyResult(await detectBurstTurns(detectedByUserId), out);
  applyResult(await detectSelfApproval(detectedByUserId), out);

  // Aggregate per-user impact across ALL violations (not just newly-inserted
  // ones), so re-runs still surface the cumulative tally in the report.
  const perUser = await pool.query<{
    userId: string;
    userDisplayName: string;
    violations: number;
    pointsInverted: number;
  }>(
    `SELECT cv.fk_cv_user            AS "userId",
            ua.user_display_name     AS "userDisplayName",
            COUNT(*)::int            AS "violations",
            SUM(cv.inverted_points)::int AS "pointsInverted"
       FROM cheating_violation cv
       JOIN user_account ua ON ua.pk_user_account = cv.fk_cv_user
      GROUP BY cv.fk_cv_user, ua.user_display_name
      ORDER BY "violations" DESC`,
  );
  out.perUser = perUser.rows;

  // Refresh the leaderboard so the UI shows updated violations_count.
  try {
    await pool.query('SELECT refresh_leaderboard()');
  } catch (err) {
    logger.warn('Reaper finished but leaderboard refresh failed', {
      error: (err as Error).message,
    });
  }

  logger.info('Reaper run complete', {
    detectedBy: detectedByUserId,
    elapsedMs: Date.now() - t0,
    violationsCreated: out.violationsCreated,
    pointsInverted: out.pointsInverted,
    breakdown: out.breakdown,
  });

  return out;
}

// ─── Redemption ───────────────────────────────────────────────────────────
// Inverse counterpart to the Reaper. For every user whose current total
// is negative, inserts a positive 'redemption' row in user_points exactly
// large enough to zero them out. cheating_violation history is preserved
// (the public Skull badge and Violations column remain populated) — the
// score is forgiven, not the audit trail.
//
// Idempotent: a second run finds no negative totals and does nothing.

export interface RedeemedUser {
  userId: string;
  userDisplayName: string;
  priorTotal: number;        // negative
  redemptionPoints: number;  // positive, equals abs(priorTotal)
}

export interface RedemptionReport {
  redeemedUsers: number;
  pointsForgiven: number;
  details: RedeemedUser[];
}

export async function runRedemption(triggeredByUserId: string): Promise<RedemptionReport> {
  const t0 = Date.now();
  logger.info('Redemption run started', { triggeredBy: triggeredByUserId });

  // Single-statement: identify every user whose CURRENT total is negative
  // (live SUM, not the materialized view — the MV may be stale between
  // refreshes) and INSERT a redemption row that exactly cancels them.
  // RETURNING gives us the per-user report for the UI.
  const r = await pool.query<{
    userId: string;
    userDisplayName: string;
    priorTotal: number;
    redemptionPoints: number;
  }>(
    `WITH negative_users AS (
       SELECT ua.pk_user_account             AS user_id,
              ua.user_display_name           AS user_display_name,
              COALESCE(SUM(up.points), 0)::int AS prior_total
         FROM user_account ua
         LEFT JOIN user_points up ON up.fk_up_user = ua.pk_user_account
        WHERE ua.is_deleted = false AND ua.is_active = true
        GROUP BY ua.pk_user_account, ua.user_display_name
       HAVING COALESCE(SUM(up.points), 0) < 0
     ),
     inserted AS (
       INSERT INTO user_points
         (fk_up_user, points, source, description,
          fk_up_project, fk_up_module, step_name)
       SELECT user_id, -prior_total, 'redemption',
              'Redemption: cleared ' || prior_total || ' pt deficit',
              NULL, NULL, NULL
         FROM negative_users
       RETURNING fk_up_user, points
     )
     SELECT nu.user_id              AS "userId",
            nu.user_display_name    AS "userDisplayName",
            nu.prior_total          AS "priorTotal",
            i.points                AS "redemptionPoints"
       FROM negative_users nu
       JOIN inserted i ON i.fk_up_user = nu.user_id
      ORDER BY nu.prior_total ASC`,
  );

  // Refresh the MV so the UI shows zeros and updated redemption_points.
  try {
    await pool.query('SELECT refresh_leaderboard()');
  } catch (err) {
    logger.warn('Redemption finished but leaderboard refresh failed', {
      error: (err as Error).message,
    });
  }

  const out: RedemptionReport = {
    redeemedUsers: r.rows.length,
    pointsForgiven: r.rows.reduce((sum, row) => sum + row.redemptionPoints, 0),
    details: r.rows,
  };

  logger.info('Redemption run complete', {
    triggeredBy: triggeredByUserId,
    elapsedMs: Date.now() - t0,
    redeemedUsers: out.redeemedUsers,
    pointsForgiven: out.pointsForgiven,
  });

  return out;
}
