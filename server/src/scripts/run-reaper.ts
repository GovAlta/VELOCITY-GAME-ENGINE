/**
 * One-shot CLI invoker for the Reaper.
 *
 *   npm run reaper                    # picks the first admin as detected_by
 *   npm run reaper -- <userId>        # explicit detected_by
 *
 * Run locally against whatever DB `server/.env` points at. The HTTP
 * endpoint /api/v1/leaderboard/reaper/run does the same thing but
 * requires an admin session + CSRF; this skips both.
 */
import 'dotenv/config';
import { pool } from '../config/database';
import { runReaper } from '../services/reaper.service';

async function pickAnyAdmin(): Promise<string | null> {
  const r = await pool.query<{ pk_user_account: string; user_display_name: string }>(
    `SELECT ua.pk_user_account, ua.user_display_name
       FROM user_account ua
       LEFT JOIN user_role ur ON ur.fk_ur_user = ua.pk_user_account
      WHERE ua.is_active = true AND ua.is_deleted = false
        AND ('admin' = ua.user_role_name OR ur.role_name = 'admin')
      LIMIT 1`,
  );
  if (r.rows.length === 0) return null;
  console.log(`detected_by → ${r.rows[0].user_display_name} (${r.rows[0].pk_user_account})`);
  return r.rows[0].pk_user_account;
}

async function main(): Promise<void> {
  const explicit = process.argv[2];
  const detectedBy = explicit || (await pickAnyAdmin());
  if (!detectedBy) {
    console.error('No admin user found. Pass a user UUID as the first arg.');
    process.exit(1);
  }

  const t0 = Date.now();
  const report = await runReaper(detectedBy);
  const elapsedMs = Date.now() - t0;

  console.log('\n══════ Reaper report ══════');
  console.log(`elapsedMs:         ${elapsedMs}`);
  console.log(`scanned projects:  ${report.scannedProjects}`);
  console.log(`scanned modules:   ${report.scannedModules}`);
  console.log(`scanned steps:     ${report.scannedSteps}`);
  console.log(`violations created: ${report.violationsCreated}`);
  console.log(`points inverted:   ${report.pointsInverted}`);
  console.log('\nBreakdown:');
  for (const [type, count] of Object.entries(report.breakdown)) {
    console.log(`  ${type.padEnd(28)} ${count}`);
  }
  if (report.perUser.length > 0) {
    console.log('\nPer-user (descending):');
    for (const u of report.perUser) {
      console.log(`  ${u.userDisplayName.padEnd(30)} ${String(u.violations).padStart(4)} violations  ${String(u.pointsInverted).padStart(8)} pts`);
    }
  } else {
    console.log('\nNo violations on file.');
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('Reaper run FAILED:', err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
