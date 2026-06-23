/**
 * Investigate a specific user's velocity activity for cheating patterns
 * not yet covered by the Reaper rules.
 *
 *   npx tsx src/scripts/investigate-cheater.ts <emailOrName>
 */
import 'dotenv/config';
import { pool } from '../config/database';

async function main(): Promise<void> {
  const lookup = process.argv[2];
  if (!lookup) {
    console.error('Usage: investigate-cheater.ts <emailOrName>');
    process.exit(1);
  }

  // Resolve user
  const u = await pool.query<{ pk_user_account: string; user_email_address: string; user_display_name: string }>(
    `SELECT pk_user_account, user_email_address, user_display_name
       FROM user_account
      WHERE user_email_address ILIKE $1 OR user_display_name ILIKE $1
      LIMIT 1`,
    [`%${lookup}%`],
  );
  if (u.rows.length === 0) {
    console.error('User not found.');
    process.exit(1);
  }
  const user = u.rows[0];
  console.log(`User: ${user.user_display_name} <${user.user_email_address}> [${user.pk_user_account}]\n`);

  // Leaderboard row (post-Reaper)
  const lb = await pool.query(
    `SELECT * FROM leaderboard WHERE user_id = $1`,
    [user.pk_user_account],
  );
  console.log('═══ Leaderboard row ═══');
  console.log(lb.rows[0] || '(not on leaderboard)');

  // Violations breakdown
  const vio = await pool.query<{ violation_type: string; count: number; sum_inverted: number }>(
    `SELECT violation_type, COUNT(*)::int AS count, SUM(inverted_points)::int AS sum_inverted
       FROM cheating_violation
      WHERE fk_cv_user = $1
      GROUP BY violation_type
      ORDER BY count DESC`,
    [user.pk_user_account],
  );
  console.log('\n═══ Violations by type ═══');
  console.table(vio.rows);

  // Top per-project point earnings (before cheating_penalty)
  const earn = await pool.query(
    `SELECT p.project_name,
            COUNT(*)::int                                              AS actions,
            SUM(up.points) FILTER (WHERE up.source <> 'cheating_penalty')::int AS earned,
            SUM(up.points) FILTER (WHERE up.source  = 'cheating_penalty')::int AS inverted,
            SUM(up.points)::int                                        AS net
       FROM user_points up
       LEFT JOIN project p ON p.pk_project = up.fk_up_project
      WHERE up.fk_up_user = $1
      GROUP BY p.project_name
      ORDER BY earned DESC NULLS LAST
      LIMIT 20`,
    [user.pk_user_account],
  );
  console.log('\n═══ Top 20 projects by earned points ═══');
  console.table(earn.rows);

  // Turn pattern: time-between-turns histogram (signal for botting / speed-running with content)
  const timing = await pool.query<{
    bucket: string;
    n: number;
  }>(
    `WITH ordered AS (
       SELECT vt.created_at,
              LAG(vt.created_at) OVER (PARTITION BY vt.fk_turn_module_velocity ORDER BY vt.created_at) AS prev_at
         FROM velocity_turn vt
        WHERE vt.turn_user_id = $1
     ),
     gaps AS (
       SELECT EXTRACT(EPOCH FROM (created_at - prev_at)) AS gap_sec
         FROM ordered
        WHERE prev_at IS NOT NULL
     )
     SELECT CASE
              WHEN gap_sec <    5 THEN '0-5s'
              WHEN gap_sec <   30 THEN '5-30s'
              WHEN gap_sec <  120 THEN '30s-2m'
              WHEN gap_sec <  600 THEN '2-10m'
              WHEN gap_sec < 3600 THEN '10-60m'
              ELSE '60m+'
            END AS bucket,
            COUNT(*)::int AS n
       FROM gaps
      GROUP BY 1
      ORDER BY MIN(gap_sec) NULLS LAST`,
    [user.pk_user_account],
  );
  console.log('\n═══ Turn-to-turn gap distribution (within same step) ═══');
  console.table(timing.rows);

  // Same-second-burst signal: turns within 5s of the previous turn on the same step
  const burst = await pool.query<{
    project_name: string | null;
    module_name: string | null;
    step_name: string;
    burst_count: number;
    fastest_gap_sec: number;
  }>(
    `WITH ordered AS (
       SELECT vt.*,
              LAG(vt.created_at) OVER (PARTITION BY vt.fk_turn_module_velocity ORDER BY vt.created_at) AS prev_at
         FROM velocity_turn vt
        WHERE vt.turn_user_id = $1
     ),
     fast AS (
       SELECT o.fk_turn_project, o.fk_turn_module, o.fk_turn_module_velocity,
              EXTRACT(EPOCH FROM (o.created_at - o.prev_at)) AS gap
         FROM ordered o
        WHERE o.prev_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (o.created_at - o.prev_at)) < 5
     )
     SELECT p.project_name, m.module_name, mv.step_name,
            COUNT(*)::int     AS burst_count,
            MIN(f.gap)::float AS fastest_gap_sec
       FROM fast f
       JOIN module_velocity mv ON mv.pk_module_velocity = f.fk_turn_module_velocity
       JOIN module m          ON m.pk_module           = mv.fk_mv_module
       JOIN project p          ON p.pk_project          = m.fk_module_project
      GROUP BY p.project_name, m.module_name, mv.step_name
      ORDER BY burst_count DESC
      LIMIT 10`,
    [user.pk_user_account],
  );
  console.log('\n═══ Top steps with <5s gaps between this user\'s turns ═══');
  console.table(burst.rows);

  // Content quality: avg turn content length + percentage empty/short
  const content = await pool.query<{
    total_turns: number;
    empty: number;
    under_50_chars: number;
    avg_chars: number;
    median_chars: number;
  }>(
    `SELECT COUNT(*)::int                                              AS total_turns,
            COUNT(*) FILTER (WHERE COALESCE(turn_content, '') = '')::int AS empty,
            COUNT(*) FILTER (WHERE length(COALESCE(turn_content, '')) < 50)::int AS under_50_chars,
            AVG(length(COALESCE(turn_content, '')))::int               AS avg_chars,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY length(COALESCE(turn_content, '')))::int AS median_chars
       FROM velocity_turn
      WHERE turn_user_id = $1`,
    [user.pk_user_account],
  );
  console.log('\n═══ Turn content profile ═══');
  console.table(content.rows);

  // Approval shape: did this user approve their own work?
  const selfApprove = await pool.query<{
    project_name: string | null;
    module_name: string | null;
    step_name: string;
    submissions: number;
    approvals_by_self: number;
  }>(
    `WITH per_step AS (
       SELECT mv.pk_module_velocity, mv.step_name, m.module_name, p.project_name,
              m.fk_module_project AS project_id,
              -- counts of this user's turns of each shape on this step
              COUNT(*) FILTER (WHERE vt.turn_action IN ('review', 'pass')) AS submissions,
              COUNT(*) FILTER (WHERE vt.turn_action = 'approve') AS approvals_by_self
         FROM velocity_turn vt
         JOIN module_velocity mv ON mv.pk_module_velocity = vt.fk_turn_module_velocity
         JOIN module m           ON m.pk_module           = mv.fk_mv_module
         JOIN project p          ON p.pk_project          = m.fk_module_project
        WHERE vt.turn_user_id = $1
        GROUP BY mv.pk_module_velocity, mv.step_name, m.module_name, p.project_name, m.fk_module_project
     )
     SELECT project_name, module_name, step_name,
            submissions::int       AS submissions,
            approvals_by_self::int AS approvals_by_self
       FROM per_step
      WHERE submissions > 0 AND approvals_by_self > 0
      ORDER BY approvals_by_self DESC
      LIMIT 10`,
    [user.pk_user_account],
  );
  console.log('\n═══ Steps where this user both submitted AND approved (self-approval) ═══');
  console.table(selfApprove.rows);

  await pool.end();
}

main().catch(async (err) => {
  console.error('Investigation FAILED:', err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
