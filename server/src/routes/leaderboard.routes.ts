import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { csrf } from '../middleware/csrf';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/response';
import { AppError } from '../utils/app-error';
import * as leaderboardService from '../services/leaderboard.service';
import * as challengeService from '../services/challenge.service';
import * as reaperService from '../services/reaper.service';

const router = Router();

// ═══ Leaderboard ═══

/**
 * GET /leaderboard
 * Public leaderboard — any authenticated user can view. Returns ALL
 * active users by default so cheaters with deeply negative totals (post-
 * Reaper) remain visible at the bottom; pass ?limit=N to cap the result.
 */
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const raw = parseInt(String(req.query.limit || ''), 10);
  // Unbounded by default; sane upper-cap to prevent pathological queries.
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 10000) : 10000;
  const period = (req.query.period || 'all') as 'month' | 'year' | 'all';
  const leaderboard = await leaderboardService.getLeaderboard(limit, period);
  sendSuccess(res, leaderboard);
}));

/**
 * GET /leaderboard/me
 * Get current user's points and rank.
 */
router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const points = await leaderboardService.getUserPoints(userId);
  const history = await leaderboardService.getUserPointHistory(userId, 20);
  sendSuccess(res, { totalPoints: points, recentHistory: history });
}));

/**
 * GET /leaderboard/user/:userId/history
 * Get point history for a specific user.
 */
router.get('/user/:userId/history', authenticate, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 200);
  const history = await leaderboardService.getUserPointHistory(req.params.userId as string, limit);
  sendSuccess(res, history);
}));

/**
 * POST /leaderboard/refresh
 * Refresh the materialized leaderboard view (admin only).
 */
router.post('/refresh', authenticate, authorize('admin'), csrf, asyncHandler(async (_req, res) => {
  await leaderboardService.refreshLeaderboard();
  sendSuccess(res, { message: 'Leaderboard refreshed' });
}));

/**
 * POST /leaderboard/reaper/run
 * Run a full audit for cheating patterns (admin only). Detects speed-running,
 * no-artifact completions, no-collaboration completions, blank modules, and
 * project-module overflow; inverts the offender's points by inserting paired
 * cheating_penalty rows. Idempotent — re-running only appends new findings.
 * Refreshes the leaderboard view before returning.
 */
router.post('/reaper/run', authenticate, authorize('admin'), csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const report = await reaperService.runReaper(userId);
  sendSuccess(res, report);
}));

/**
 * POST /leaderboard/redemption/run
 * Run a redemption pass (admin only). For every user whose current total
 * is negative, inserts a positive `redemption` user_points row exactly
 * large enough to bring them to zero. cheating_violation history is
 * preserved — the Skull badge and violation count remain on the board.
 * Idempotent: a second run with no remaining negative users is a no-op.
 */
router.post('/redemption/run', authenticate, authorize('admin'), csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const report = await reaperService.runRedemption(userId);
  sendSuccess(res, report);
}));

/**
 * GET /leaderboard/violations
 * List all detected cheating violations (admin only). Joins user names and
 * scope (project / module / step) so the admin UI can render a forensic trail.
 */
router.get('/violations', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 1000);
  const violations = await leaderboardService.listViolations(limit);
  sendSuccess(res, violations);
}));

/**
 * GET /leaderboard/user/:userId/violations
 * Per-user violation breakdown — summary by rule type plus a few example
 * rows per rule. Public to authenticated users (matches the public Skull
 * badge and violation count already shown on the leaderboard).
 */
router.get('/user/:userId/violations', authenticate, asyncHandler(async (req, res) => {
  const result = await leaderboardService.listUserViolations(req.params.userId as string);
  sendSuccess(res, result);
}));

/**
 * GET /leaderboard/project/:projectId/contributors
 * All contributors to a project with point breakdown.
 */
router.get('/project/:projectId/contributors', authenticate, asyncHandler(async (req, res) => {
  const contributors = await leaderboardService.getProjectContributors(req.params.projectId as string);
  sendSuccess(res, contributors);
}));

/**
 * GET /leaderboard/module/:moduleId/contributors
 * All contributors to a module with per-step point history.
 */
router.get('/module/:moduleId/contributors', authenticate, asyncHandler(async (req, res) => {
  const contributors = await leaderboardService.getModuleContributors(req.params.moduleId as string);
  sendSuccess(res, contributors);
}));

// ═══ Challenges ═══

/**
 * GET /challenges
 * List all challenges with optional status filter.
 */
router.get('/challenges', authenticate, asyncHandler(async (req, res) => {
  const status = (req.query.status || undefined) as 'open' | 'claimed' | 'completed' | 'all' | undefined;
  const difficulty = (req.query.difficulty || undefined) as string | undefined;
  const challenges = await challengeService.listChallenges({ status, difficulty });
  sendSuccess(res, challenges);
}));

/**
 * POST /challenges/:projectId/claim
 * Claim an open challenge (runner+ role).
 */
router.post('/challenges/:projectId/claim', authenticate, authorize('runner'), csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const result = await challengeService.claimChallenge(req.params.projectId as string, userId);
  sendSuccess(res, result);
}));

/**
 * POST /challenges/:projectId/complete
 * Mark a challenge as completed (runner+ role). Awards points.
 */
router.post('/challenges/:projectId/complete', authenticate, authorize('runner'), csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const result = await challengeService.completeChallenge(req.params.projectId as string, userId);
  sendSuccess(res, result);
}));

/**
 * POST /challenges/:projectId/unclaim
 * Abandon a claimed challenge (runner+ role).
 */
router.post('/challenges/:projectId/unclaim', authenticate, authorize('runner'), csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  await challengeService.unclaimChallenge(req.params.projectId as string, userId);
  sendSuccess(res, { message: 'Challenge unclaimed' });
}));

// ─── v5.1: cloning-based acceptance + manage workflow ─────────────────

/**
 * GET /challenges/:projectId
 * Single challenge with its acceptances (clones) listed.
 */
router.get('/challenges/:projectId', authenticate, asyncHandler(async (req, res) => {
  const data = await challengeService.getChallengeWithAcceptances(req.params.projectId as string);
  sendSuccess(res, data);
}));

/**
 * POST /challenges/:projectId/accept
 * Clone the challenge so the user can take it on independently. Enforces
 * `challenge_max_acceptances` (first-come, first-served when set).
 * Returns the new clone's ID.
 */
router.post('/challenges/:projectId/accept', authenticate, authorize('runner', 'project_lead'), csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const result = await challengeService.acceptChallenge(
    req.params.projectId as string,
    userId,
    req.ip ?? undefined,
  );
  sendSuccess(res, result, 201);
}));

/**
 * POST /challenges/:projectId/close
 * Close the challenge — no further acceptances; existing clones may still
 * complete. Creator-only (admins can override).
 */
router.post('/challenges/:projectId/close', authenticate, csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const isAdmin = ((req.user as any)?.roles || []).includes('admin');
  const result = await challengeService.closeChallenge(
    req.params.projectId as string,
    userId,
    isAdmin,
    req.ip ?? undefined,
  );
  sendSuccess(res, result);
}));

/**
 * POST /challenges/:projectId/pick-winner
 * Pick the winning acceptance (or the parent itself if no clones), award
 * points to the winner's owners, save the optional narrative.
 * Body: { winnerProjectId: UUID, narrative?: string }
 */
router.post('/challenges/:projectId/pick-winner', authenticate, csrf, asyncHandler(async (req, res) => {
  const userId = (req.user as any)?.id as string;
  const isAdmin = ((req.user as any)?.roles || []).includes('admin');
  const { winnerProjectId, narrative } = req.body || {};
  if (!winnerProjectId || typeof winnerProjectId !== 'string') {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'winnerProjectId is required' } });
    return;
  }
  const result = await challengeService.pickChallengeWinner(
    req.params.projectId as string,
    winnerProjectId,
    typeof narrative === 'string' ? narrative.trim() || null : null,
    userId,
    isAdmin,
    req.ip ?? undefined,
  );
  sendSuccess(res, result);
}));

export default router;
