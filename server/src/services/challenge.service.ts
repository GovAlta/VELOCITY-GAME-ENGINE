import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import { logAuditEvent } from '../utils/audit-logger';
import * as leaderboardService from './leaderboard.service';
import * as collabService from './project-collaboration.service';
import * as memberModel from '../models/project-member.model';
import { velocityStreamManager } from '../sse/velocity-stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Challenge {
  pk_project: string;
  project_name: string;
  project_description: string;
  project_status: string;
  challenge_points: number;
  challenge_max_days: number;
  challenge_difficulty: string;
  challenge_claimed_by: string | null;
  challenge_claimed_at: string | null;
  challenge_completed_at: string | null;
  // v5.1 multi-acceptance fields
  challenge_max_acceptances: number | null;     // null = unlimited
  challenge_closed_at: string | null;
  challenge_winner_project: string | null;
  challenge_winner_narrative: string | null;
  challenge_winner_picked_at: string | null;
  challenge_winner_picked_by: string | null;
  project_clone_disabled: boolean;
  // Derived fields
  acceptance_count?: number;                    // count of clones
  spots_remaining?: number | null;              // null when unlimited
  is_full?: boolean;
  winner_name?: string | null;                  // display name of winning clone's primary owner
  // Legacy
  claimer_name?: string;
  claimer_email?: string;
  ministry_code?: string;
  modules?: any[];
  created_by?: string | null;
  created_by_name?: string | null;
}

// ---------------------------------------------------------------------------
// List challenges
// ---------------------------------------------------------------------------

export async function listChallenges(filters?: {
  status?: 'open' | 'claimed' | 'completed' | 'closed' | 'all';
  difficulty?: string;
}): Promise<Challenge[]> {
  // Only consider TOP-LEVEL projects as challenges. Acceptances are clones with
  // fk_project_parent set; they shouldn't appear as their own challenge entries.
  let where = 'p.project_is_challenge = true AND p.is_deleted = false AND p.fk_project_parent IS NULL';
  const params: any[] = [];
  let idx = 1;

  const status = filters?.status || 'all';
  if (status === 'open') {
    where += ' AND p.challenge_closed_at IS NULL AND p.challenge_winner_project IS NULL';
  } else if (status === 'claimed') {
    // "claimed" = has at least one acceptance (clone) but not yet closed
    where += ' AND p.challenge_closed_at IS NULL AND EXISTS (SELECT 1 FROM project c WHERE c.fk_project_parent = p.pk_project AND c.is_deleted = false)';
  } else if (status === 'completed') {
    where += ' AND p.challenge_winner_project IS NOT NULL';
  } else if (status === 'closed') {
    where += ' AND p.challenge_closed_at IS NOT NULL';
  }

  if (filters?.difficulty) {
    where += ` AND p.challenge_difficulty = $${idx++}`;
    params.push(filters.difficulty);
  }

  const res = await pool.query(
    `SELECT p.*,
            ua.user_display_name AS claimer_name,
            ua.user_email_address AS claimer_email,
            cb.user_display_name  AS created_by_name,
            m.ministry_name,
            wp.project_name       AS winner_project_name,
            wo.user_display_name  AS winner_name,
            COALESCE(
              (SELECT COUNT(*)::int FROM project c
                WHERE c.fk_project_parent = p.pk_project AND c.is_deleted = false),
              0
            ) AS acceptance_count
       FROM project p
       LEFT JOIN user_account ua ON ua.pk_user_account = p.challenge_claimed_by
       LEFT JOIN user_account cb ON cb.pk_user_account = p.created_by
       LEFT JOIN ministry m      ON m.pk_ministry = p.fk_project_ministry
       LEFT JOIN project wp      ON wp.pk_project = p.challenge_winner_project
       LEFT JOIN LATERAL (
         SELECT ua2.user_display_name
           FROM project_member pm
           JOIN user_account ua2 ON ua2.pk_user_account = pm.fk_pm_user
          WHERE pm.fk_pm_project = p.challenge_winner_project
            AND pm.is_active = true
            AND pm.member_role = 'owner'
          ORDER BY pm.added_at LIMIT 1
       ) wo ON true
      WHERE ${where}
      ORDER BY
        CASE WHEN p.challenge_winner_project IS NOT NULL THEN 3
             WHEN p.challenge_closed_at IS NOT NULL THEN 2
             WHEN EXISTS (SELECT 1 FROM project c WHERE c.fk_project_parent = p.pk_project AND c.is_deleted = false) THEN 1
             ELSE 0 END ASC,
        p.challenge_points DESC,
        p.created_at DESC`,
    params
  );

  // Decorate with derived fields the UI uses for state
  return res.rows.map((row: any) => {
    const max = row.challenge_max_acceptances;
    const accepted = row.acceptance_count ?? 0;
    return {
      ...row,
      spots_remaining: max == null ? null : Math.max(0, max - accepted),
      is_full: max != null && accepted >= max,
    };
  });
}

/**
 * Get a single challenge with the same shape as listChallenges + the list of
 * acceptances (clones) so the UI can render the "who's taking it on" panel.
 */
export async function getChallengeWithAcceptances(projectId: string): Promise<{
  challenge: Challenge;
  acceptances: Array<{
    pk_project: string;
    project_name: string;
    project_version_label: string | null;
    project_status: string;
    project_percent_complete: number | null;
    project_is_locked: boolean;
    challenge_completed_at: string | null;
    primary_owner_name: string | null;
    primary_owner_email: string | null;
  }>;
}> {
  const list = await listChallenges({ status: 'all' });
  const challenge = list.find(c => c.pk_project === projectId);
  if (!challenge) throw AppError.notFound('Challenge not found');

  const accRes = await pool.query(
    `SELECT c.pk_project, c.project_name, c.project_version_label, c.project_status,
            c.project_percent_complete, c.project_is_locked, c.challenge_completed_at,
            owner.user_display_name AS primary_owner_name,
            owner.user_email_address AS primary_owner_email
       FROM project c
       LEFT JOIN LATERAL (
         SELECT ua.user_display_name, ua.user_email_address
           FROM project_member pm
           JOIN user_account ua ON ua.pk_user_account = pm.fk_pm_user
          WHERE pm.fk_pm_project = c.pk_project
            AND pm.is_active = true
            AND pm.member_role = 'owner'
          ORDER BY pm.added_at LIMIT 1
       ) owner ON true
      WHERE c.fk_project_parent = $1 AND c.is_deleted = false
      ORDER BY c.created_at`,
    [projectId],
  );

  return { challenge, acceptances: accRes.rows };
}

// ---------------------------------------------------------------------------
// Claim a challenge
// ---------------------------------------------------------------------------

export async function claimChallenge(
  projectId: string,
  userId: string
): Promise<Challenge> {
  // Verify it's a challenge and unclaimed
  const check = await pool.query(
    `SELECT * FROM project
     WHERE pk_project = $1 AND project_is_challenge = true AND is_deleted = false`,
    [projectId]
  );
  if (check.rows.length === 0) throw AppError.notFound('Challenge not found');

  const challenge = check.rows[0];
  if (challenge.challenge_claimed_by) {
    throw AppError.badRequest('This challenge has already been claimed');
  }

  const res = await pool.query(
    `UPDATE project
     SET challenge_claimed_by = $1, challenge_claimed_at = NOW(), project_status = 'development'
     WHERE pk_project = $2
     RETURNING *`,
    [userId, projectId]
  );

  await logAuditEvent({
    action: 'UPDATE', tableName: 'project', recordId: projectId, userId,
    newData: { action: 'challenge_claimed', challenge_points: challenge.challenge_points },
  });

  velocityStreamManager.broadcast('challenge_claimed', {
    projectId, userId, challengePoints: challenge.challenge_points,
    projectName: challenge.project_name,
  });

  return res.rows[0];
}

// ---------------------------------------------------------------------------
// Complete a challenge
// ---------------------------------------------------------------------------

export async function completeChallenge(
  projectId: string,
  userId: string
): Promise<{ challenge: any; pointsAwarded: number }> {
  const check = await pool.query(
    `SELECT * FROM project
     WHERE pk_project = $1 AND project_is_challenge = true AND is_deleted = false`,
    [projectId]
  );
  if (check.rows.length === 0) throw AppError.notFound('Challenge not found');

  const challenge = check.rows[0];
  if (!challenge.challenge_claimed_by) {
    throw AppError.badRequest('Challenge must be claimed before completing');
  }
  if (challenge.challenge_completed_at) {
    throw AppError.badRequest('Challenge is already completed');
  }

  // Mark complete
  const res = await pool.query(
    `UPDATE project
     SET challenge_completed_at = NOW(), project_status = 'completion', percent_complete = 100
     WHERE pk_project = $1
     RETURNING *`,
    [projectId]
  );

  // Award points to the claimer
  const points = challenge.challenge_points || 100;
  await leaderboardService.awardPoints({
    userId: challenge.challenge_claimed_by,
    points,
    source: 'challenge_complete',
    description: `Completed challenge: ${challenge.project_name}`,
    projectId,
  });

  // Check if completed within deadline for bonus
  if (challenge.challenge_claimed_at && challenge.challenge_max_days) {
    const claimedAt = new Date(challenge.challenge_claimed_at);
    const deadline = new Date(claimedAt.getTime() + challenge.challenge_max_days * 24 * 60 * 60 * 1000);
    if (new Date() <= deadline) {
      const bonus = Math.round(points * 0.25); // 25% speed bonus
      await leaderboardService.awardPoints({
        userId: challenge.challenge_claimed_by,
        points: bonus,
        source: 'challenge_bonus',
        description: `Speed bonus: completed within ${challenge.challenge_max_days} days`,
        projectId,
      });
    }
  }

  // Refresh leaderboard
  leaderboardService.refreshLeaderboard().catch(() => {});

  await logAuditEvent({
    action: 'UPDATE', tableName: 'project', recordId: projectId, userId,
    newData: { action: 'challenge_completed', points_awarded: points },
  });

  velocityStreamManager.broadcast('challenge_completed', {
    projectId, userId, pointsAwarded: points,
    projectName: challenge.project_name,
  });

  return { challenge: res.rows[0], pointsAwarded: points };
}

// ---------------------------------------------------------------------------
// Unclaim (abandon) a challenge
// ---------------------------------------------------------------------------

export async function unclaimChallenge(
  projectId: string,
  userId: string
): Promise<void> {
  const res = await pool.query(
    `UPDATE project
     SET challenge_claimed_by = NULL, challenge_claimed_at = NULL, project_status = 'discovery'
     WHERE pk_project = $1 AND project_is_challenge = true AND challenge_completed_at IS NULL
     RETURNING *`,
    [projectId]
  );
  if (res.rows.length === 0) throw AppError.notFound('Challenge not found or already completed');

  await logAuditEvent({
    action: 'UPDATE', tableName: 'project', recordId: projectId, userId,
    newData: { action: 'challenge_unclaimed' },
  });

  velocityStreamManager.broadcast('challenge_unclaimed', { projectId, userId });
}

// ---------------------------------------------------------------------------
// Accept a challenge (clones the parent — the v5.1 path)
// ---------------------------------------------------------------------------
//
// "Accepting a challenge" creates an independent clone of the challenge
// project. Each accepter gets their own copy with their own velocity board,
// members, and progress. This replaces the single-claimer model on the
// challenges UI. The legacy `claimChallenge` is kept for back-compat.
//
// Enforces:
//   - Parent must be a top-level challenge (no clones-of-clones)
//   - Parent must not be closed (challenge_closed_at IS NULL)
//   - Parent must not have a winner yet
//   - Acceptance count < challenge_max_acceptances (when set)
//   - User cannot accept their own challenge twice (already a member of an
//     existing acceptance) — soft check, returns the existing one
// ---------------------------------------------------------------------------

export async function acceptChallenge(
  parentId: string,
  userId: string,
  ipAddress?: string,
): Promise<{ pk_project: string; project_code: string | null; project_name: string }> {
  const challenge = await pool.query(
    `SELECT pk_project, project_name, project_is_challenge, fk_project_parent,
            challenge_closed_at, challenge_winner_project, challenge_max_acceptances,
            project_clone_disabled, is_deleted
       FROM project WHERE pk_project = $1`,
    [parentId],
  );
  if (challenge.rows.length === 0 || challenge.rows[0].is_deleted) {
    throw AppError.notFound('Challenge not found');
  }
  const c = challenge.rows[0];
  if (!c.project_is_challenge) {
    throw AppError.badRequest('That project is not a challenge');
  }
  if (c.fk_project_parent) {
    throw new AppError('Cannot accept a clone — accept the parent challenge instead', 422, 'CLONE_OF_CLONE');
  }
  if (c.challenge_closed_at) {
    throw new AppError('This challenge has been closed', 403, 'CHALLENGE_CLOSED');
  }
  if (c.challenge_winner_project) {
    throw new AppError('This challenge already has a winner', 403, 'CHALLENGE_COMPLETED');
  }

  // Acceptance count check (only counts active clones)
  if (c.challenge_max_acceptances != null) {
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM project
        WHERE fk_project_parent = $1 AND is_deleted = false`,
      [parentId],
    );
    const accepted = countRes.rows[0]?.n ?? 0;
    if (accepted >= c.challenge_max_acceptances) {
      throw new AppError(
        `This challenge is full (${accepted}/${c.challenge_max_acceptances} spots taken)`,
        409,
        'CHALLENGE_FULL',
      );
    }
  }

  // Already accepted? Return the existing clone instead of creating a duplicate.
  const existing = await pool.query(
    `SELECT c.pk_project, c.project_code, c.project_name
       FROM project c
       JOIN project_member pm ON pm.fk_pm_project = c.pk_project
                              AND pm.fk_pm_user = $2
                              AND pm.is_active = true
      WHERE c.fk_project_parent = $1 AND c.is_deleted = false
      LIMIT 1`,
    [parentId, userId],
  );
  if (existing.rows.length > 0) return existing.rows[0];

  // Delegate to the existing clone service — it does the heavy lifting:
  // copies modules + links, bootstraps cloner as owner, broadcasts version_created,
  // auto-provisions SharePoint folders, etc.
  collabService.setAuthContext('session');
  const clone = await collabService.cloneProject(
    parentId,
    userId,
    { copyLinks: true, copyBudgets: false },
    { ipAddress },
  );

  await logAuditEvent({
    action: 'INSERT',
    tableName: 'project',
    recordId: clone.pk_project,
    userId,
    newData: {
      action: 'challenge_accepted',
      parentChallengeId: parentId,
      challengeName: c.project_name,
    },
  });

  velocityStreamManager.broadcast('challenge_accepted', {
    projectId: clone.pk_project,
    parentId,
    parentName: c.project_name,
    accepterId: userId,
  });

  return clone;
}

// ---------------------------------------------------------------------------
// Close a challenge (no further acceptances; existing clones may still complete)
// ---------------------------------------------------------------------------

export async function closeChallenge(
  parentId: string,
  userId: string,
  isAdmin: boolean,
  ipAddress?: string,
): Promise<{ challenge_closed_at: string }> {
  const checkRes = await pool.query(
    `SELECT created_by, project_name, project_is_challenge, fk_project_parent,
            challenge_closed_at, is_deleted
       FROM project WHERE pk_project = $1`,
    [parentId],
  );
  if (checkRes.rows.length === 0 || checkRes.rows[0].is_deleted) {
    throw AppError.notFound('Challenge not found');
  }
  const c = checkRes.rows[0];
  if (!c.project_is_challenge || c.fk_project_parent) {
    throw AppError.badRequest('That project is not a top-level challenge');
  }
  if (c.challenge_closed_at) {
    // Idempotent — already closed
    return { challenge_closed_at: c.challenge_closed_at };
  }
  if (c.created_by !== userId && !isAdmin) {
    throw new AppError('Only the challenge creator (or an admin) can close it', 403, 'NOT_CHALLENGE_CREATOR');
  }

  const res = await pool.query(
    `UPDATE project
        SET challenge_closed_at = NOW(),
            project_clone_disabled = true,
            project_clone_disabled_by = $2,
            project_clone_disabled_at = NOW(),
            project_clone_disabled_reason = COALESCE(project_clone_disabled_reason, 'Challenge closed by creator')
      WHERE pk_project = $1
      RETURNING challenge_closed_at`,
    [parentId, userId],
  );

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: parentId,
    userId,
    ipAddress,
    newData: { action: 'challenge_closed', challenge_name: c.project_name },
  });

  velocityStreamManager.broadcast('challenge_closed', {
    projectId: parentId,
    projectName: c.project_name,
    closedBy: userId,
  });

  return res.rows[0];
}

// ---------------------------------------------------------------------------
// Pick a winner — awards points to the winning clone's owner(s)
// ---------------------------------------------------------------------------

export async function pickChallengeWinner(
  parentId: string,
  winnerProjectId: string,
  narrative: string | null,
  userId: string,
  isAdmin: boolean,
  ipAddress?: string,
): Promise<{
  parent: any;
  winner: any;
  pointsAwarded: number;
  bonusAwarded: number;
}> {
  // Validate parent
  const parentRes = await pool.query(
    `SELECT * FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [parentId],
  );
  if (parentRes.rows.length === 0) throw AppError.notFound('Challenge not found');
  const parent = parentRes.rows[0];
  if (!parent.project_is_challenge || parent.fk_project_parent) {
    throw AppError.badRequest('That project is not a top-level challenge');
  }
  if (parent.created_by !== userId && !isAdmin) {
    throw new AppError('Only the challenge creator (or an admin) can pick a winner', 403, 'NOT_CHALLENGE_CREATOR');
  }
  if (parent.challenge_winner_project) {
    throw new AppError('A winner has already been picked for this challenge', 409, 'WINNER_ALREADY_PICKED');
  }

  // Validate winner is an active acceptance of this challenge OR the parent itself.
  // (A challenge creator may legitimately award the parent if no clones exist.)
  if (winnerProjectId !== parentId) {
    const winnerRes = await pool.query(
      `SELECT * FROM project
        WHERE pk_project = $1 AND fk_project_parent = $2 AND is_deleted = false`,
      [winnerProjectId, parentId],
    );
    if (winnerRes.rows.length === 0) {
      throw AppError.badRequest('Winner project must be the parent itself or an active acceptance of it');
    }
  }

  // Update parent
  await pool.query(
    `UPDATE project
        SET challenge_winner_project = $2,
            challenge_winner_narrative = $3,
            challenge_winner_picked_at = NOW(),
            challenge_winner_picked_by = $4,
            challenge_completed_at = NOW(),
            challenge_closed_at = COALESCE(challenge_closed_at, NOW()),
            project_clone_disabled = true
      WHERE pk_project = $1`,
    [parentId, winnerProjectId, narrative, userId],
  );

  // Mark the winning clone as completed (status + percent)
  await pool.query(
    `UPDATE project
        SET project_status = 'completion',
            project_percent_complete = 100,
            challenge_completed_at = NOW()
      WHERE pk_project = $1`,
    [winnerProjectId],
  );

  // Award points to ALL active owners of the winning clone (split equally
  // when there are multiple co-owners; rounding up the last share).
  const owners = await memberModel.listActiveMembers(winnerProjectId);
  const winnerOwners = owners.filter(o => o.member_role === 'owner');
  const points = parent.challenge_points || 100;
  const bonus = computeSpeedBonus(parent, winnerProjectId);
  const sharePer = Math.max(1, Math.floor(points / Math.max(1, winnerOwners.length)));
  const bonusPer = bonus > 0 ? Math.max(0, Math.floor(bonus / Math.max(1, winnerOwners.length))) : 0;

  for (const o of winnerOwners) {
    await leaderboardService.awardPoints({
      userId: o.fk_pm_user,
      points: sharePer,
      source: 'challenge_complete',
      description: `Won challenge: ${parent.project_name}${narrative ? ` — ${narrative.slice(0, 80)}` : ''}`,
      projectId: winnerProjectId,
    });
    if (bonusPer > 0) {
      await leaderboardService.awardPoints({
        userId: o.fk_pm_user,
        points: bonusPer,
        source: 'challenge_bonus',
        description: `Speed bonus on challenge: ${parent.project_name}`,
        projectId: winnerProjectId,
      });
    }
  }
  leaderboardService.refreshLeaderboard().catch(() => {});

  await logAuditEvent({
    action: 'UPDATE',
    tableName: 'project',
    recordId: parentId,
    userId,
    ipAddress,
    newData: {
      action: 'challenge_winner_picked',
      challenge_name: parent.project_name,
      winner_project_id: winnerProjectId,
      narrative,
      points_per_owner: sharePer,
      bonus_per_owner: bonusPer,
      owners_count: winnerOwners.length,
    },
  });

  velocityStreamManager.broadcast('challenge_winner_picked', {
    projectId: parentId,
    parentId,
    winnerProjectId,
    pointsAwarded: sharePer * winnerOwners.length,
    pickedBy: userId,
  });

  return {
    parent: parent,
    winner: { pk_project: winnerProjectId },
    pointsAwarded: sharePer * winnerOwners.length,
    bonusAwarded: bonusPer * winnerOwners.length,
  };
}

function computeSpeedBonus(parent: any, _winnerProjectId: string): number {
  // Original semantics: 25% bonus when completed within challenge_max_days of
  // the parent's creation date. (We don't have per-clone claim time yet for
  // the new flow — using parent created_at as the reference.)
  if (!parent.challenge_max_days) return 0;
  const start = new Date(parent.created_at);
  const deadline = new Date(start.getTime() + parent.challenge_max_days * 24 * 60 * 60 * 1000);
  if (new Date() > deadline) return 0;
  return Math.round((parent.challenge_points || 100) * 0.25);
}
