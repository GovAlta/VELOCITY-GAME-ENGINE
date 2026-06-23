import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import { logAuditEvent } from '../utils/audit-logger';
import * as velocityModel from '../models/velocity.model';
import type {
  ModuleVelocityRecord,
  ModuleVelocityWithMeta,
  VelocityTurnRecord,
} from '../models/velocity.model';
import { velocityStreamManager } from '../sse/velocity-stream';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

// `hand_raised` and `blocked` are universally available from every other
// state. The signals carry different semantics (hand_raised = "I need help,
// no penalty"; blocked = "real impediment, penalty applies") and we never
// want either to be unreachable because of state-machine geometry. The
// human or AI must always be able to flag for help or flag an impediment,
// even from `not_started`, `ready_to_start`, `*_review`, or `completed`.
const VALID_TRANSITIONS: Record<string, string[]> = {
  'not_started':    ['ready_to_start', 'hand_raised', 'blocked'],
  'ready_to_start': ['ai_working', 'human_working', 'hand_raised', 'blocked'],
  // Working states also allow lateral handoff (ai↔human) and rewind to
  // ready_to_start — covers "I started but actually you take it" and
  // "nobody actually did anything — put it back on the shelf" without
  // forcing a fake review turn into the audit log.
  'ai_working':     ['ai_review', 'human_review', 'blocked', 'hand_raised', 'human_working', 'ready_to_start'],
  'human_working':  ['ai_review', 'human_review', 'blocked', 'hand_raised', 'ai_working', 'ready_to_start'],
  'ai_review':      ['ai_working', 'human_working', 'completed', 'hand_raised', 'blocked'],
  'human_review':   ['ai_working', 'human_working', 'completed', 'hand_raised', 'blocked'],
  'blocked':        ['ready_to_start', 'ai_working', 'human_working', 'hand_raised'],
  'hand_raised':    ['ai_working', 'human_working', 'ai_review', 'human_review', 'blocked'],
  // `completed` can loop back via ready_to_start for rework; hand_raised /
  // blocked from completed signal "I just realized this was wrong and needs
  // to be re-opened with a clear cause."
  'completed':      ['ready_to_start', 'hand_raised', 'blocked'],
};

/**
 * Derive the action label from a status transition.
 */
function deriveAction(fromStatus: string, toStatus: string): string {
  if (toStatus === 'hand_raised') return 'raise_hand';
  if (fromStatus === 'hand_raised') return 'lower_hand';
  if (toStatus === 'blocked') return 'block';
  if (fromStatus === 'blocked') return 'unblock';
  if (fromStatus === 'not_started' && toStatus === 'ready_to_start') return 'start';
  if (fromStatus === 'ready_to_start') return 'start';
  if (
    (fromStatus === 'ai_working' || fromStatus === 'human_working') &&
    (toStatus === 'ai_review' || toStatus === 'human_review')
  ) {
    return 'review';
  }
  if (
    (fromStatus === 'ai_review' || fromStatus === 'human_review') &&
    toStatus === 'completed'
  ) {
    return 'approve';
  }
  if (
    (fromStatus === 'ai_review' || fromStatus === 'human_review') &&
    (toStatus === 'ai_working' || toStatus === 'human_working')
  ) {
    return 'reject';
  }
  // Lateral handoff (ai_working ↔ human_working) and rewind
  // (*_working → ready_to_start): no work judged, just a re-routing.
  if (
    (fromStatus === 'ai_working' && toStatus === 'human_working') ||
    (fromStatus === 'human_working' && toStatus === 'ai_working') ||
    ((fromStatus === 'ai_working' || fromStatus === 'human_working') &&
      toStatus === 'ready_to_start')
  ) {
    return 'pass';
  }
  return 'transition';
}

// ---------------------------------------------------------------------------
// Velocity Scoring
// ---------------------------------------------------------------------------

/**
 * Calculate and apply velocity score changes based on a move action.
 * Returns the delta applied so it can be broadcast.
 */
async function applyScoring(
  moduleId: string,
  action: string,
  fromStatus: string,
  _toStatus: string,
  opts?: { isAligned?: boolean; stepWeight?: number; loopCount?: number; stepsBack?: number },
): Promise<{ scoreDelta: number; bonusDelta: number; penaltyDelta: number }> {
  // Module score uses the SAME flat values as user_points (single source of truth).
  // No complexity multiplier — keeps module score and leaderboard points in sync.
  const isRework = (opts?.loopCount || 0) > 0;
  let scoreDelta = 0;
  let bonusDelta = 0;
  let penaltyDelta = 0;

  switch (action) {
    case 'approve': // review -> completed
      if (isRework) {
        scoreDelta = 10; // recovery credit only on rework
      } else {
        scoreDelta = 100;
        bonusDelta = 50;
        if (opts?.isAligned) {
          scoreDelta += 25;
          bonusDelta += 25;
        }
      }
      break;
    case 'review':
      scoreDelta = isRework ? 0 : 20;
      break;
    case 'start':
      scoreDelta = 10;
      break;
    case 'reject':
      scoreDelta = -30;
      penaltyDelta = 30;
      break;
    case 'block':
      scoreDelta = -10;
      penaltyDelta = 10;
      break;
    case 'send_back':
      const steps = opts?.stepsBack || 1;
      scoreDelta = -50 * steps;
      penaltyDelta = 50 * steps;
      break;
    default:
      break;
  }

  // Module-level loopback (completed -> ready_to_start) penalty
  if (fromStatus === 'completed') {
    scoreDelta -= 50;
    penaltyDelta += 50;
  }

  if (scoreDelta !== 0 || bonusDelta !== 0 || penaltyDelta !== 0) {
    await pool.query(
      `UPDATE module_velocity_metrics
       SET velocity_score = velocity_score + $1::int,
           velocity_bonus = velocity_bonus + $2::int,
           velocity_penalty = velocity_penalty + $3::int
       WHERE fk_mvm_module = $4`,
      [Math.round(scoreDelta), Math.round(bonusDelta), Math.round(penaltyDelta), moduleId]
    );
  }

  return { scoreDelta, bonusDelta, penaltyDelta };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Get all velocity steps for all modules in a project, grouped by module.
 */
export async function getProjectVelocity(
  projectId: string
): Promise<{
  modules: { moduleId: string; moduleName: string; projectName: string; steps: ModuleVelocityRecord[] }[];
  metrics: velocityModel.ModuleMetrics[];
}> {
  const rows = await velocityModel.findProjectVelocity(projectId);

  const moduleMap = new Map<
    string,
    { moduleId: string; moduleName: string; projectName: string; steps: ModuleVelocityRecord[] }
  >();

  for (const row of rows) {
    let entry = moduleMap.get(row.fk_mv_module);
    if (!entry) {
      entry = {
        moduleId: row.fk_mv_module,
        moduleName: row.module_name,
        projectName: row.project_name,
        steps: [],
      };
      moduleMap.set(row.fk_mv_module, entry);
    }
    entry.steps.push(row);
  }

  const moduleIds = Array.from(moduleMap.keys());
  const metrics = await velocityModel.findModuleMetrics(moduleIds);

  return { modules: Array.from(moduleMap.values()), metrics };
}

/**
 * Get the 8 velocity steps for a single module.
 */
export async function getModuleSteps(
  moduleId: string
): Promise<ModuleVelocityRecord[]> {
  return velocityModel.findModuleSteps(moduleId);
}

/**
 * Make a move (state transition) on a velocity step.
 * Uses a database transaction to ensure atomicity.
 */
export async function makeMove(
  moduleId: string,
  stepName: string,
  body: {
    status: string;
    actor?: string;
    content?: string;
    contentJson?: Record<string, unknown>;
    attachments?: unknown[];
  },
  userId?: string,
  apiKeyId?: string
): Promise<{ step: ModuleVelocityRecord; turn: VelocityTurnRecord }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the step row
    const step = await velocityModel.findStepByModuleAndName(moduleId, stepName, client);
    if (!step) {
      throw AppError.notFound('Velocity step not found for this module');
    }

    const fromStatus = step.status;
    const toStatus = body.status;

    // Validate transition
    const allowed = VALID_TRANSITIONS[fromStatus];
    if (!allowed || !allowed.includes(toStatus)) {
      throw AppError.badRequest(
        `Invalid transition from '${fromStatus}' to '${toStatus}'`
      );
    }

    // Determine action
    const action = deriveAction(fromStatus, toStatus);

    // Determine actor for the step's current_actor field
    const actor = body.actor || (toStatus.startsWith('ai_') ? 'ai' : 'human');

    // ── Governance: AI Authority Gate ──
    // If step requires human approval, AI cannot approve (move to completed)
    if (step.requires_human_approval && toStatus === 'completed' && actor === 'ai') {
      throw AppError.badRequest(
        `Step '${stepName}' requires human approval. AI cannot complete this step directly.`
      );
    }

    // ── Governance: AI Recommendation Check ──
    // If step requires AI recommendation, flag if human approves without AI review
    // We check if the last review was by AI — if not, this is a misalignment
    let isAligned = true;
    if (step.requires_ai_recommendation && toStatus === 'completed' && actor === 'human') {
      // Check if AI has reviewed this step (any ai_review turn exists for current cycle)
      const aiReviewCheck = await client.query(
        `SELECT 1 FROM velocity_turn
         WHERE fk_turn_module_velocity = $1
           AND turn_actor = 'ai'
           AND turn_action IN ('review', 'approve')
           AND created_at > COALESCE($2::timestamptz, '1970-01-01'::timestamptz)
         LIMIT 1`,
        [step.pk_module_velocity, step.started_at]
      );
      if (aiReviewCheck.rows.length === 0) {
        isAligned = false;
        // Don't block — but flag it and reduce points
      }
    }

    // ── Governance: Alignment tracking ──
    // Approval after both actors have participated = alignment
    // Approval by only one actor = misalignment
    if (toStatus === 'completed') {
      const turnActors = await client.query(
        `SELECT DISTINCT turn_actor FROM velocity_turn
         WHERE fk_turn_module_velocity = $1
           AND turn_action IN ('review', 'approve', 'start')
           AND created_at > COALESCE($2::timestamptz, '1970-01-01'::timestamptz)`,
        [step.pk_module_velocity, step.started_at]
      );
      const actors = turnActors.rows.map((r: { turn_actor: string }) => r.turn_actor);
      isAligned = actors.includes('ai') && actors.includes('human');
    }

    // Calculate loop count: increment when rejecting (review → working)
    let loopCount = step.loop_count;
    if (action === 'reject') {
      loopCount += 1;
    }

    // Calculate timestamps
    let startedAt = step.started_at;
    let completedAt = step.completed_at;
    if (!startedAt && toStatus !== 'not_started') {
      startedAt = new Date().toISOString();
    }
    if (toStatus === 'completed') {
      completedAt = new Date().toISOString();
    }

    // Look up the project ID for the turn record
    const moduleResult = await client.query<{ fk_module_project: string }>(
      'SELECT fk_module_project FROM module WHERE pk_module = $1',
      [moduleId]
    );
    if (moduleResult.rows.length === 0) {
      throw AppError.notFound('Module not found');
    }
    const projectId = moduleResult.rows[0].fk_module_project;

    // Update the step
    const updatedStep = await velocityModel.updateStep(
      step.pk_module_velocity,
      {
        status: toStatus,
        current_actor: toStatus === 'completed' ? null : actor,
        loop_count: loopCount,
        started_at: startedAt,
        completed_at: completedAt,
      },
      client
    );

    // Create the turn record
    const turn = await velocityModel.createTurn(
      {
        fk_turn_module_velocity: step.pk_module_velocity,
        fk_turn_module: moduleId,
        fk_turn_project: projectId,
        turn_actor: actor,
        turn_action: action,
        turn_from_status: fromStatus,
        turn_to_status: toStatus,
        turn_content: body.content || null,
        turn_content_json: body.contentJson || null,
        turn_attachments: body.attachments || null,
        turn_user_id: userId || null,
        turn_api_key_id: apiKeyId || null,
        turn_is_aligned: toStatus === 'completed' ? isAligned : null,
      },
      client
    );

    // Increment turn_count on the step
    await client.query(
      `UPDATE module_velocity SET turn_count = turn_count + 1 WHERE pk_module_velocity = $1`,
      [step.pk_module_velocity]
    );

    // Calculate time spent by the previous actor before this move
    // If the step had a started_at and the previous status was a working/review status,
    // accumulate time for the actor who was holding the clock
    if (step.started_at && step.current_actor) {
      const lastTurnRes = await client.query<{ created_at: string }>(
        `SELECT created_at FROM velocity_turn
         WHERE fk_turn_module_velocity = $1
         ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
        [step.pk_module_velocity]
      );
      const lastTurnTime = lastTurnRes.rows[0]?.created_at;
      if (lastTurnTime) {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(lastTurnTime).getTime()) / 1000));
        if (elapsedSeconds > 0 && elapsedSeconds < 86400 * 30) { // cap at 30 days to avoid stale data
          const timeCol = step.current_actor === 'ai' ? 'ai_time_seconds' : 'human_time_seconds';
          await client.query(
            `UPDATE module_velocity_metrics SET ${timeCol} = ${timeCol} + $1, total_turns = total_turns + 1
             WHERE fk_mvm_module = $2`,
            [elapsedSeconds, moduleId]
          );
        }
      }
    }

    // Detect module-level loopback: if a completed step is being reopened
    if (fromStatus === 'completed' && toStatus === 'ready_to_start') {
      await client.query(
        `UPDATE module_velocity_metrics SET loopback_count = loopback_count + 1 WHERE fk_mvm_module = $1`,
        [moduleId]
      );
    }

    // Update current step tracking in metrics
    await client.query(
      `UPDATE module_velocity_metrics
       SET current_step_name = $1, current_step_started_at = NOW()
       WHERE fk_mvm_module = $2`,
      [toStatus === 'completed' ? null : stepName, moduleId]
    );

    // Step progression: when completed, unlock the next step
    // "Ladder" mechanic: if completed on first cycle (zero loops) with alignment,
    // auto-advance next step to the same actor's working state instead of just ready_to_start
    if (toStatus === 'completed') {
      const nextStepOrder = step.step_order + 1;
      const isPerfectRun = loopCount === 0 && isAligned;
      const nextStatus = isPerfectRun ? (actor === 'ai' ? 'ai_working' : 'human_working') : 'ready_to_start';
      const nextActor = isPerfectRun ? actor : null;

      await client.query(
        `UPDATE module_velocity
         SET status = $3::text, current_actor = $4, started_at = CASE WHEN $3::text != 'ready_to_start' THEN NOW() ELSE NULL END, updated_at = NOW()
         WHERE fk_mv_module = $1
           AND step_order = $2
           AND status = 'not_started'`,
        [moduleId, nextStepOrder, nextStatus, nextActor]
      );

      // Award ladder bonus points for perfect run
      if (isPerfectRun) {
        pool.query(
          `UPDATE module_velocity_metrics
           SET velocity_score = velocity_score + 15, velocity_bonus = velocity_bonus + 15
           WHERE fk_mvm_module = $1`,
          [moduleId]
        ).catch(() => {});
      }
    }

    await client.query('COMMIT');

    // Fire-and-forget audit
    logAuditEvent({
      action: 'UPDATE',
      tableName: 'module_velocity',
      recordId: step.pk_module_velocity,
      userId: userId || undefined,
      newData: {
        step_name: stepName,
        from_status: fromStatus,
        to_status: toStatus,
        action,
        loop_count: loopCount,
        _apiKeyId: apiKeyId,
      },
    }).catch(() => {});

    // Apply velocity scoring (fire-and-forget, after commit)
    applyScoring(moduleId, action, fromStatus, toStatus, {
      isAligned,
      loopCount: loopCount,
    }).catch(() => {});

    // Award user points for velocity actions (fire-and-forget)
    //
    // ANTI-GAMING: If a step has loop_count > 0, it was previously completed then
    // sent back. Re-completing awards only 10 pts (recovery credit), not the full 100.
    // This prevents the exploit: lose 50 on send-back, gain 100 on re-complete = net +50.
    // Correct behavior: lose 50, gain 10 = net -40. Rework always costs points.
    //
    // Points go to the HUMAN who made the move. API key users get points to the key owner.
    // On step completion, BOTH the worker and the reviewer get points.
    const pointsUserId = userId || undefined;
    if (pointsUserId) {
      import('./leaderboard.service').then(({ awardPoints }) => {
        pool.query('SELECT fk_module_project FROM module WHERE pk_module = $1', [moduleId])
          .then(async (modRes) => {
            const projectId = modRes.rows[0]?.fk_module_project;
            const sn = step.step_name;
            const isRework = (step.loop_count || 0) > 0;

            if (toStatus === 'completed') {
              if (isRework) {
                // Re-completion after send-back: small recovery credit only
                awardPoints({ userId: pointsUserId, points: 10, source: 'velocity_step', description: `Re-completed ${sn} (rework, loop ${step.loop_count})`, projectId, moduleId, stepName: sn });
                // No worker bonus, no alignment bonus on rework — the penalty already applied
              } else {
                // First-time completion: full points
                awardPoints({ userId: pointsUserId, points: 100, source: 'velocity_step', description: `Approved & completed ${sn}`, projectId, moduleId, stepName: sn });

                // Find the worker(s) who did the actual work on this step
                try {
                  const workersRes = await pool.query(
                    `SELECT DISTINCT turn_user_id FROM velocity_turn
                     WHERE fk_turn_module_velocity = $1
                       AND turn_action IN ('review', 'start')
                       AND turn_user_id IS NOT NULL
                       AND turn_user_id != $2
                       AND created_at > COALESCE($3::timestamptz, '1970-01-01'::timestamptz)`,
                    [step.pk_module_velocity, pointsUserId, step.started_at]
                  );
                  for (const w of workersRes.rows) {
                    awardPoints({ userId: w.turn_user_id, points: 50, source: 'velocity_bonus', description: `Contributed to ${sn} (worker)`, projectId, moduleId, stepName: sn });
                  }
                } catch { /* ignore */ }

                // Alignment bonus
                if (isAligned) {
                  awardPoints({ userId: pointsUserId, points: 25, source: 'velocity_bonus', description: `Alignment bonus on ${sn}`, projectId, moduleId, stepName: sn });
                }
              }
            } else if (action === 'review' && !isRework) {
              // Submit for review — only on first pass, not rework
              awardPoints({ userId: pointsUserId, points: 20, source: 'velocity_bonus', description: `Submitted ${sn} for review`, projectId, moduleId, stepName: sn });
            } else if (action === 'start' && fromStatus === 'not_started') {
              // Only first start from not_started
              awardPoints({ userId: pointsUserId, points: 10, source: 'velocity_bonus', description: `Initiated ${sn}`, projectId, moduleId, stepName: sn });
            } else if (action === 'reject') {
              awardPoints({ userId: pointsUserId, points: -30, source: 'velocity_penalty', description: `Rejection on ${sn} (quality gate)`, projectId, moduleId, stepName: sn });
            } else if (action === 'block') {
              awardPoints({ userId: pointsUserId, points: -10, source: 'velocity_penalty', description: `Blocked: ${sn}`, projectId, moduleId, stepName: sn });
            }
          }).catch(() => {});
      }).catch(() => {});
    }

    // Update alignment/misalignment counts on completion
    if (toStatus === 'completed') {
      const alignCol = isAligned ? 'alignment_count' : 'misalignment_count';
      pool.query(
        `UPDATE module_velocity_metrics SET ${alignCol} = ${alignCol} + 1 WHERE fk_mvm_module = $1`,
        [moduleId]
      ).catch(() => {});
    }

    // Handle blocked_since tracking
    if (toStatus === 'blocked') {
      pool.query(
        `UPDATE module_velocity SET blocked_reason = $1, blocked_since = NOW() WHERE pk_module_velocity = $2`,
        [body.content || null, step.pk_module_velocity]
      ).catch(() => {});
    } else if (fromStatus === 'blocked') {
      pool.query(
        `UPDATE module_velocity SET blocked_reason = NULL, blocked_since = NULL WHERE pk_module_velocity = $1`,
        [step.pk_module_velocity]
      ).catch(() => {});
    }

    // Broadcast move event to all connected SSE clients. projectId is included
    // so clients can correlate against their loaded board state (important for
    // cloned projects, where parent and child share names but not IDs).
    velocityStreamManager.broadcast('move', {
      projectId,
      moduleId,
      stepName,
      fromStatus,
      toStatus,
      action,
      actor,
      loopCount,
      isAligned,
      turn,
      updatedStep,
    });
    logger.info('velocity move broadcast', { projectId, moduleId, stepName, fromStatus, toStatus });

    return { step: updatedStep, turn };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Add a note to a velocity step without changing status.
 */
export async function addNote(
  moduleId: string,
  stepName: string,
  body: {
    content: string;
    actor?: string;
    contentJson?: Record<string, unknown>;
    attachments?: unknown[];
  },
  userId?: string,
  apiKeyId?: string
): Promise<VelocityTurnRecord> {
  const step = await velocityModel.findStepByModuleAndName(moduleId, stepName);
  if (!step) {
    throw AppError.notFound('Velocity step not found for this module');
  }

  // Look up the project ID
  const moduleResult = await pool.query<{ fk_module_project: string }>(
    'SELECT fk_module_project FROM module WHERE pk_module = $1',
    [moduleId]
  );
  if (moduleResult.rows.length === 0) {
    throw AppError.notFound('Module not found');
  }
  const projectId = moduleResult.rows[0].fk_module_project;

  const turn = await velocityModel.createTurn({
    fk_turn_module_velocity: step.pk_module_velocity,
    fk_turn_module: moduleId,
    fk_turn_project: projectId,
    turn_actor: body.actor || 'human',
    turn_action: 'note',
    turn_from_status: step.status,
    turn_to_status: step.status,
    turn_content: body.content,
    turn_content_json: body.contentJson || null,
    turn_attachments: body.attachments || null,
    turn_user_id: userId || null,
    turn_api_key_id: apiKeyId || null,
  });

  // Broadcast note event to all connected SSE clients. projectId is
  // included so project-scoped subscribers (Layer 3) get filtered correctly.
  velocityStreamManager.broadcast('note', {
    projectId,
    moduleId,
    stepName,
    turn,
  });

  return turn;
}

/**
 * Get paginated turns for a specific step.
 */
export async function getStepTurns(
  moduleId: string,
  stepName: string,
  page: number,
  limit: number
): Promise<{
  data: VelocityTurnRecord[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const step = await velocityModel.findStepByModuleAndName(moduleId, stepName);
  if (!step) {
    throw AppError.notFound('Velocity step not found for this module');
  }

  const [data, total] = await Promise.all([
    velocityModel.findTurnsByStep(step.pk_module_velocity, page, limit),
    velocityModel.countTurnsByStep(step.pk_module_velocity),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    data,
    pagination: { page, limit, total, totalPages },
  };
}

/**
 * Get paginated turns for all steps of a module.
 */
export async function getModuleTurns(
  moduleId: string,
  page: number,
  limit: number
): Promise<{
  data: VelocityTurnRecord[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const [data, total] = await Promise.all([
    velocityModel.findTurnsByModule(moduleId, page, limit),
    velocityModel.countTurnsByModule(moduleId),
  ]);

  const totalPages = Math.ceil(total / limit) || 1;

  return {
    data,
    pagination: { page, limit, total, totalPages },
  };
}

/**
 * Send a module back to an earlier step.
 * Resets the target step to ready_to_start and marks all steps after it as not_started.
 * Increments the module-level loopback counter.
 */
export async function sendBackToStep(
  moduleId: string,
  targetStepName: string,
  body: { content?: string; actor?: string },
  userId?: string,
  apiKeyId?: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get all steps for this module
    const allSteps = await velocityModel.findModuleSteps(moduleId);
    if (allSteps.length === 0) throw AppError.notFound('No velocity steps for this module');

    const targetStep = allSteps.find(s => s.step_name === targetStepName);
    if (!targetStep) throw AppError.notFound(`Step '${targetStepName}' not found`);

    // Check if any step that would be reset is locked (locked steps can't be undone)
    const lockedStep = allSteps.find(s => s.step_order >= targetStep.step_order && s.is_locked);
    if (lockedStep) {
      throw AppError.badRequest(`Cannot send back — step '${lockedStep.step_name}' is locked. Unlock it first.`);
    }

    // Find the current active step (highest step_order that isn't not_started)
    const currentStep = [...allSteps].reverse().find(s => s.status !== 'not_started');
    if (!currentStep) throw AppError.badRequest('No active steps to send back from');
    if (targetStep.step_order >= currentStep.step_order) {
      throw AppError.badRequest('Target step must be earlier than the current active step');
    }

    // Look up project ID
    const modRes = await client.query<{ fk_module_project: string }>(
      'SELECT fk_module_project FROM module WHERE pk_module = $1', [moduleId]
    );
    const projectId = modRes.rows[0]?.fk_module_project;
    if (!projectId) throw AppError.notFound('Module not found');

    const actor = body.actor || 'human';

    // Reset target step to ready_to_start
    await client.query(
      `UPDATE module_velocity SET status = 'ready_to_start', current_actor = NULL, completed_at = NULL, updated_at = NOW()
       WHERE fk_mv_module = $1 AND step_name = $2`,
      [moduleId, targetStepName]
    );

    // Reset all steps AFTER the target step to not_started
    await client.query(
      `UPDATE module_velocity SET status = 'not_started', current_actor = NULL, completed_at = NULL, updated_at = NOW()
       WHERE fk_mv_module = $1 AND step_order > $2`,
      [moduleId, targetStep.step_order]
    );

    // Create a turn record on the current step documenting the send-back
    await velocityModel.createTurn({
      fk_turn_module_velocity: currentStep.pk_module_velocity,
      fk_turn_module: moduleId,
      fk_turn_project: projectId,
      turn_actor: actor,
      turn_action: 'send_back',
      turn_from_status: currentStep.status,
      turn_to_status: 'not_started',
      turn_content: body.content || `Sent back to ${targetStepName}`,
      turn_content_json: { target_step: targetStepName, from_step: currentStep.step_name },
      turn_attachments: null,
      turn_user_id: userId || null,
      turn_api_key_id: apiKeyId || null,
    }, client);

    // Increment module-level loopback counter
    await client.query(
      `UPDATE module_velocity_metrics SET loopback_count = loopback_count + 1 WHERE fk_mvm_module = $1`,
      [moduleId]
    );

    await client.query('COMMIT');

    logAuditEvent({
      action: 'UPDATE',
      tableName: 'module_velocity',
      recordId: moduleId,
      userId: userId || undefined,
      newData: { action: 'send_back', from_step: currentStep.step_name, to_step: targetStepName },
    }).catch(() => {});

    // Calculate how many steps were reset (penalty scales with distance)
    const stepsBack = currentStep.step_order - targetStep.step_order;

    // Apply send-back scoring penalty: -50 per step sent back (fire-and-forget)
    applyScoring(moduleId, 'send_back', currentStep.status, 'not_started', { stepsBack }).catch(() => {});

    // User points penalty: -50 × number of steps sent back
    if (userId) {
      const penalty = -50 * stepsBack;
      import('./leaderboard.service').then(({ awardPoints }) => {
        awardPoints({ userId, points: penalty, source: 'velocity_penalty',
          description: `Send-back ${stepsBack} step${stepsBack > 1 ? 's' : ''}: ${currentStep.step_name} → ${targetStepName}`,
          projectId, moduleId });
      }).catch(() => {});
    }

    // Broadcast send_back event to all connected SSE clients
    velocityStreamManager.broadcast('send_back', {
      projectId,
      moduleId,
      targetStepName,
      actor: body.actor || 'human',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lock or unlock a velocity step to prevent/allow send-back resets.
 */
export async function setStepLock(
  moduleId: string,
  stepName: string,
  locked: boolean,
  userId?: string,
): Promise<ModuleVelocityRecord> {
  const step = await velocityModel.findStepByModuleAndName(moduleId, stepName);
  if (!step) throw AppError.notFound('Velocity step not found');

  const result = await velocityModel.updateStep(step.pk_module_velocity, { is_locked: locked });

  logAuditEvent({
    action: 'UPDATE',
    tableName: 'module_velocity',
    recordId: step.pk_module_velocity,
    userId: userId || undefined,
    newData: { step_name: stepName, is_locked: locked },
  }).catch(() => {});

  // Resolve project for the project-scoped subscription filter.
  const projectRow = await pool.query<{ fk_module_project: string }>(
    'SELECT fk_module_project FROM module WHERE pk_module = $1',
    [moduleId]
  );
  const projectId = projectRow.rows[0]?.fk_module_project;

  // Broadcast lock event to all connected SSE clients
  velocityStreamManager.broadcast('lock', {
    projectId,
    moduleId,
    stepName,
    locked,
  });

  return result;
}

/**
 * Dashboard: all projects, modules, and their velocity step statuses + metrics.
 */
export async function getDashboard(): Promise<{
  steps: ModuleVelocityWithMeta[];
  metrics: velocityModel.ModuleMetrics[];
}> {
  const steps = await velocityModel.findDashboard();
  const moduleIds = [...new Set(steps.map(s => s.fk_mv_module))];
  const metrics = await velocityModel.findModuleMetrics(moduleIds);
  return { steps, metrics };
}
