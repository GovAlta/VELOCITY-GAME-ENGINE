import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import * as velocityService from '../services/velocity.service';
import { sendSuccess, sendPaginated } from '../utils/response';
import { velocityStreamManager } from '../sse/velocity-stream';
import { env } from '../config/environment';
import { memoryPressure } from '../utils/memory-pressure';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /velocity
 * Dashboard — all projects/modules with velocity step statuses.
 */
export async function dashboard(_req: Request, res: Response): Promise<void> {
  const data = await velocityService.getDashboard();
  sendSuccess(res, data);
}

/**
 * GET /velocity/projects/:projectId
 * Get all velocity steps grouped by module for a project.
 */
export async function getProjectVelocity(req: Request, res: Response): Promise<void> {
  const projectId = req.params.projectId as string;
  const data = await velocityService.getProjectVelocity(projectId);
  sendSuccess(res, data);
}

/**
 * GET /velocity/modules/:moduleId
 * Get the 8 velocity steps for a single module.
 */
export async function getModuleSteps(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const data = await velocityService.getModuleSteps(moduleId);
  sendSuccess(res, data);
}

/**
 * PUT /velocity/modules/:moduleId/steps/:stepName
 * Make a move (state transition) on a velocity step.
 */
export async function makeMove(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const stepName = req.params.stepName as string;
  const userId = req.user?.id;
  const apiKeyId = (req as any)._apiKeyId;
  const result = await velocityService.makeMove(
    moduleId,
    stepName,
    req.body,
    userId,
    apiKeyId
  );
  sendSuccess(res, result);
}

/**
 * POST /velocity/modules/:moduleId/steps/:stepName/turns
 * Add a note to a velocity step without changing status.
 */
export async function addNote(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const stepName = req.params.stepName as string;
  const userId = req.user?.id;
  const apiKeyId = (req as any)._apiKeyId;
  const turn = await velocityService.addNote(
    moduleId,
    stepName,
    req.body,
    userId,
    apiKeyId
  );
  sendSuccess(res, turn, 201);
}

/**
 * GET /velocity/modules/:moduleId/steps/:stepName/turns
 * Get paginated turns for a specific step.
 */
export async function getStepTurns(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const stepName = req.params.stepName as string;
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const result = await velocityService.getStepTurns(moduleId, stepName, page, limit);
  sendPaginated(res, result.data, result.pagination);
}

/**
 * GET /velocity/modules/:moduleId/turns
 * Get paginated turns for all steps of a module.
 */
export async function getModuleTurns(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 20;
  const result = await velocityService.getModuleTurns(moduleId, page, limit);
  sendPaginated(res, result.data, result.pagination);
}

/**
 * POST /velocity/modules/:moduleId/send-back
 * Send a module back to an earlier step, resetting later steps.
 */
/**
 * PUT /velocity/modules/:moduleId/steps/:stepName/lock
 * Lock or unlock a step.
 */
export async function toggleLock(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const stepName = req.params.stepName as string;
  const userId = req.user?.id;
  const locked = req.body.locked === true;
  const result = await velocityService.setStepLock(moduleId, stepName, locked, userId);
  sendSuccess(res, result);
}

/**
 * GET /velocity/stream
 * SSE stream — broadcasts all velocity events to connected clients.
 */
export async function stream(req: Request, res: Response): Promise<void> {
  // Capture identity early so we can both enforce concurrency caps and
  // include it in connect/disconnect logs. apiKeyAuth (mounted in app.ts
  // before /velocity/*) populates req.user + _apiKeyId when an API key is
  // present; for browser EventSource (no custom headers), neither is set
  // and we fall back to IP + User-Agent.
  const apiKeyId = (req as any)._apiKeyId as string | undefined;
  const userId = req.user?.id;
  const ip = req.ip;
  const authSource = apiKeyId ? 'api_key' : 'anonymous';

  // ── Memory-pressure shed ───────────────────────────────────
  // The shedder samples heap every few seconds. When AMBER or worse we
  // refuse new SSE streams entirely so the broadcast set stops growing
  // while the runtime recovers. Existing streams continue. Clients see
  // 503 with Retry-After so well-behaved listeners back off without
  // spinning.
  if (memoryPressure.isAmberOrWorse()) {
    logger.warn('Velocity SSE connection rejected (memory pressure)', {
      pressureState: memoryPressure.getState(),
      pct: memoryPressure.getLastSample().pct,
      ip,
      apiKeyId,
      userId,
    });
    res.setHeader('Retry-After', '30');
    res.status(503).json({
      success: false,
      error: {
        code: 'SSE_BACKPRESSURE',
        message: 'Server is shedding load. Retry shortly.',
      },
    });
    return;
  }

  // ── Project filter (?projects=p1,p2) ───────────────────────
  // Lets agents subscribe to a subset and skip the broadcast firehose.
  // Empty / missing => subscribe to all (legacy behavior).
  const projectsRaw = (req.query.projects as string | undefined) || '';
  const projects = new Set(
    projectsRaw.split(',').map(s => s.trim()).filter(Boolean),
  );

  // ── Per-identity concurrency cap ────────────────────────────
  // One misbehaving caller (single VM, single API key) opening 100+ SSE
  // connections was the actual cause of the recent runaway, not a server
  // leak. The cap stops that pattern at the door. A cap of 0 disables the
  // check (useful for tests / local debugging). 429 with Retry-After lets
  // well-behaved clients back off instead of hammering.
  let rejectReason: string | null = null;
  if (apiKeyId && env.SSE_MAX_PER_API_KEY > 0
      && velocityStreamManager.countByApiKey(apiKeyId) >= env.SSE_MAX_PER_API_KEY) {
    rejectReason = `api_key:${apiKeyId} reached cap (${env.SSE_MAX_PER_API_KEY})`;
  } else if (userId && env.SSE_MAX_PER_USER > 0
      && velocityStreamManager.countByUser(userId) >= env.SSE_MAX_PER_USER) {
    rejectReason = `user:${userId} reached cap (${env.SSE_MAX_PER_USER})`;
  } else if (!apiKeyId && !userId && ip && env.SSE_MAX_PER_IP > 0
      && velocityStreamManager.countByIp(ip) >= env.SSE_MAX_PER_IP) {
    rejectReason = `ip:${ip} reached cap (${env.SSE_MAX_PER_IP})`;
  }
  if (rejectReason) {
    logger.warn('Velocity SSE connection rejected (cap)', {
      reason: rejectReason,
      ip,
      apiKeyId,
      userId,
    });
    res.setHeader('Retry-After', '60');
    res.status(429).json({
      success: false,
      error: {
        code: 'SSE_CONCURRENCY_LIMIT',
        message: 'Too many concurrent SSE connections for this identity. ' +
                 'Close existing connections or retry later.',
      },
    });
    return;
  }

  // Set SSE response headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Flush headers immediately
  res.flushHeaders();

  const meta = {
    ip,
    userAgent: (req.headers['user-agent'] as string) || undefined,
    userId,
    userEmail: req.user?.email,
    apiKeyId,
    authSource: authSource as 'api_key' | 'anonymous',
    projects,
  };

  // Send initial connection event with current client count
  res.write(`event: connected\ndata: ${JSON.stringify({ clients: velocityStreamManager.getClientCount() + 1 })}\n\n`);

  // Register this client with the velocity stream manager
  velocityStreamManager.addClient(res, meta);

  // Heartbeat every 15s keeps reverse-proxy idle timers happy AND will
  // eventually surface a dead peer once the OS send buffer fills. The TCP
  // keepalive above is the faster, more reliable detector — this is the
  // fallback that also serves to nudge intermediaries.
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeatInterval);
    velocityStreamManager.removeClient(res);
  };

  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`:heartbeat\n\n`);
    } catch {
      cleanup();
    }
  }, 15000);

  // Listen on both req and res close — req.close is the conventional Express
  // hook, res.close is fired by Node when the underlying socket goes away
  // (more reliable behind reverse proxies). Either path triggers the same
  // idempotent cleanup.
  req.on('close', cleanup);
  res.on('close', cleanup);
}

export async function sendBack(req: Request, res: Response): Promise<void> {
  const moduleId = req.params.moduleId as string;
  const userId = req.user?.id;
  const apiKeyId = (req as any)._apiKeyId;
  await velocityService.sendBackToStep(moduleId, req.body.targetStep, req.body, userId, apiKeyId);
  sendSuccess(res, { message: `Module sent back to ${req.body.targetStep}` });
}

/**
 * GET /velocity/guide
 * Download the gameplay guide + API spec as a .md file.
 */
/**
 * GET /velocity/claude-md
 * Download the CLAUDE.md AI agent instructions file.
 */
export async function downloadClaudeMd(_req: Request, res: Response): Promise<void> {
  const claudeMdPath = path.resolve(__dirname, '..', 'static', 'CLAUDE.md');
  let content = '';
  try {
    content = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    content = '# CLAUDE.md\n\nFile not found. Ensure src/static/CLAUDE.md exists.';
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="CLAUDE.md"');
  res.send(content);
}

export async function downloadGuide(_req: Request, res: Response): Promise<void> {
  // Read the OpenAPI spec
  const openapiPath = path.resolve(__dirname, '..', '..', 'openapi.yaml');
  let openapiSpec = '';
  try { openapiSpec = fs.readFileSync(openapiPath, 'utf-8'); } catch { openapiSpec = '(OpenAPI spec not found)'; }

  // Extract just the velocity section from OpenAPI
  const velocitySection = openapiSpec.split('# ═══ Velocity')[1]?.split('# ═══ Health')[0] || '';

  const guide = `# Velocity — Human-AI Collaboration Gameplay Guide

> Generated from the Velo platform. This document serves as the "super prompt" for both
> human users and autonomous AI agents participating in the Velocity workflow.
>
> Provide this document to any AI agent (Claude, GPT, etc.) along with an API key
> to enable it to participate in the Velocity game.

---

## 1. What is Velocity?

Velocity is a **turn-based collaboration board game** where humans and AI agents move a module through 8 sequential squares — from Requirements to Deployment. Think of it as **Snakes & Ladders**, not chess:

- **One board per module.** Each module is its own game. You stand on one square at a time.
- **You cannot jump ahead.** You must complete each square before moving to the next.
- **Snakes pull you back.** A rejection sends you back on the current square (review loop). A send-back slides you down several squares — all intermediate work resets.
- **Ladders push you forward.** If you complete a square perfectly (zero review loops, both actors participated), the next square auto-activates — you land running instead of waiting.
- **A chess clock is running.** Every second a square is in someone's hands is tracked. The module sidebar shows cumulative AI time vs Human time — so bottlenecks are immediately visible.
- **The score measures collaboration quality.** A perfect run (all 8 squares, zero penalties, full alignment) is the highest possible score. Low scores mean miscommunication and rework. The score tells you how well the human-AI partnership is functioning.

### Core Principles
- **Sequential**: One active square per module. You cannot start square 5 until square 4 is complete.
- **Turn-based with a timer**: One actor (Human or AI) holds the clock at any time. The other waits. Time is tracked per actor — if AI averages 20 minutes per square and Human averages 2 days, the imbalance is visible.
- **Evidence-based**: Every move must include context, notes, or attachments that ground the decision. No empty moves.
- **Auditable**: Every turn is permanently recorded with actor identity (email or API key), timestamps, and status changes.
- **Scored**: Forward progress earns velocity points. Snakes (rejects, send-backs) cost points. Ladders (perfect completions) earn bonuses.

---

## 2. The 8 Steps

Every module progresses through these sequential steps:

| Step | Purpose | Expected Evidence |
|------|---------|-------------------|
| 1. Requirements | Define what needs to be built | Requirements doc, user stories, acceptance criteria |
| 2. Planning | Plan how to build it | Task breakdown, timeline, resource allocation |
| 3. Architecture | Design the technical approach | Architecture diagrams, API contracts, data models |
| 4. Prototyping | Build a proof of concept | Working prototype, screenshots, demo recording |
| 5. Development | Build the full implementation | Code commits, PRs, technical documentation |
| 6. User Testing | Validate with real users | Test results, feedback, bug reports |
| 7. User Acceptance | Get stakeholder sign-off | Sign-off document, approval email |
| 8. Deployment | Ship to production | Deployment log, monitoring dashboard, release notes |

---

## 3. Status States

| Status | Display | Who Holds the Clock | Visual |
|--------|---------|--------------------|----|
| not_started | Not Started | Nobody | Grey |
| ready_to_start | Ready | Waiting for pickup | Light Blue |
| ai_working | AI Working | AI agent | Purple (pulsing) |
| human_working | Human Working | Human user | Blue (pulsing) |
| ai_review | AI Reviewing | AI agent | Light Purple |
| human_review | Human Reviewing | Human user | Light Blue |
| completed | Completed | Signed off | Green |
| hand_raised | Hand Raised | Needs help (no penalty) | Yellow (pulsing, yellow ring) |
| blocked | Blocked | Needs attention (-10 pts) | Red (red ring) |

---

## 4. Making Moves

### The Rules of the Board

You stand on one square. You can only move within that square until it's complete, then you advance to the next.

\`\`\`
Within a square:
  not_started     → ready_to_start           (open the square)
  ready_to_start  → ai_working | human_working (pick up the work)
  *_working       → *_review                          (submit for review)
  *_working       → (other) *_working                 (HAND OFF — re-route without judgement)
  *_working       → ready_to_start                    (REWIND — nothing was actually done)
  *_review        → *_working                       (REJECT — snake! loop back, -30 points)
  *_review        → completed                        (APPROVE — advance to next square)
  any state       → hand_raised | blocked            (UNIVERSAL — always available, even from
                                                     not_started, *_review, or completed)

Between squares:
  completed       → next square opens         (normal: ready_to_start; ladder: auto-working)
  completed       → ready_to_start            (SEND BACK — snake! slide down, -50 points)

Signals:
  hand_raised     → *_working | *_review | blocked   (lower hand and resume, or escalate to blocked)
  blocked         → ready_to_start | *_working       (unblock and resume)
\`\`\`

**You cannot have multiple squares active simultaneously.** Only the current square accepts moves. The AI cannot be "working" on steps 3, 5, and 7 at the same time — that's not how this game works. One square at a time, one actor at a time.

### At Every Move, You Should:
1. **Read the previous turn's notes** — what was done? what's expected next?
2. **Do the work** — complete the task for this square
3. **Attach evidence** — link to documents, PRs, screenshots, test results, or other artifacts that prove the work is done
4. **Leave clear instructions** — tell the next actor exactly what to review or do next. Be specific. "Looks good" is not an instruction.
5. **Choose the right transition** — "Task to AI →", "Send to Human for Review", "Approve & Complete ✓"

### The Human-AI Handoff

The core interaction pattern is:
1. Human writes requirements/instructions with evidence links
2. Human tasks to AI → (AI Working)
3. AI does the work, attaches deliverables, tasks back for review → (Human Review)
4. Human reviews, either approves (advance) or rejects with specific feedback (loop back)
5. Repeat until the square is complete, then advance

Both actors can work and review — the system tracks who did what. But the highest scores come from genuine back-and-forth collaboration, not one actor doing everything.

---

## 5. Reviewing & Approving

When you're in a review state:

### Approve (→ Completed) when:
- All acceptance criteria for this step are met
- Evidence is attached and verifiable
- No blocking issues remain

### Reject (→ Working) when:
- Requirements are incomplete or incorrect
- Evidence is missing or insufficient
- Quality does not meet standards

**Every rejection increments the step's loop count and costs -30 velocity points.**

---

## 6. Snakes & Ladders

### Snakes (Things That Pull You Back)

**Small Snake — Review Rejection (-30 points)**
You're stuck on the current square. The reviewer found issues and sends work back for rework. Loop count increments. You stay on the same square for another cycle.

**Big Snake — Send-Back (-50 points)**
A later square (e.g., User Testing) discovers that earlier work was deficient. The entire module slides back to that earlier square. All intermediate squares reset to "Not Started." This is devastating and should be rare. It means foundational work wasn't solid enough.

**Blocked — Miss Your Turn (-10 points)**
Something external prevents progress. The square turns red with a red ring. Records when it was blocked and why. No one can move until it's unblocked. Use this for real impediments (missing access, dependency not ready, waiting on external team).

**Raise Hand — Ask for Help (0 points)**
You're stuck but it's not a formal blocker. The square turns yellow with a pulsing yellow ring — highly visible to all watchers. No scoring penalty. Use this when you need guidance, clarification, or a second opinion without triggering a blocker. Lower hand to resume work.

### Ladders (Things That Push You Forward)

**Perfect Run Ladder (+15 bonus, auto-advance)**
If you complete a square with:
- Zero review loops (approved first time)
- Both actors participated (alignment)

...the next square doesn't just open to "Ready to Start" — it auto-activates into the same actor's working state. You land running instead of waiting. This rewards momentum and clean handoffs.

**Alignment Ladder (+25 bonus)**
Every completion where both human and AI participated earns a +25 alignment bonus. The game rewards genuine collaboration over solo runs.

### Locking — Protecting Your Progress
Completed squares can be **locked** to prevent send-back resets from sliding past them. Think of it as putting a wall behind you — snakes can't pull you past a locked square. Only unlock deliberately if you genuinely need to revisit that work.

---

## 7. Velocity Scoring — The Scoreboard

The score measures **collaboration quality**, not speed. A perfect run means the human and AI understood each other at every handoff. A low score means miscommunication and rework.

### Points Table

| Action | Points | Type | When |
|--------|--------|------|------|
| Complete a square (first time) | +100 × weight | Forward | Square reaches "Completed" for the first time |
| **Re-complete after rework** | **+10** | Recovery | Square re-completed after a send-back (loop_count > 0) |
| Worker contribution (first time) | +50 | Bonus | Other humans who did start/review work on this square |
| Alignment bonus (first time) | +25 | Ladder | Both actors participated in this square |
| Perfect run ladder | +15 | Ladder | Zero loops + aligned → next square auto-activates |
| Submit for review (first time) | +20 | Forward | Work submitted for review (not on rework) |
| Start a square | +10 | Forward | Square opened for the first time |
| Review rejection | -30 | Snake | Reviewer rejects back to working |
| Send-back | -50 × steps back | Snake | Module slides back. Penalty scales: 3 steps back = -150 |
| Blocked | -10 | Snake | Square marked as blocked (stalled, red ring) |
| Raise Hand | 0 | Signal | Help needed but not blocked (yellow pulsing ring, no penalty) |
| Module loopback | -50 | Snake | Reopening a completed square (completed → ready_to_start) |

**Anti-gaming rule:** When a square is re-completed after rework (loop_count > 0), only +10 recovery points are awarded — not the full +100. No worker bonuses, alignment bonuses, or review submission points on rework. This ensures rework always costs net points: send-back (-50) + re-complete (+10) = **net -40**. You cannot gain unlimited points by cycling send-back → re-complete.

### Step Weight Multiplier

Each square has a complexity weight (1–3) that multiplies completion and approval points:
- **Weight 1** (Simple): completion = +100, approval = +50
- **Weight 2** (Standard): completion = +200, approval = +100
- **Weight 3** (Complex): completion = +300, approval = +150

### Perfect Game Score

For a module at weight 1 with 8 squares, all perfect:
- 8 completions: 8 × 100 = **800**
- 8 approvals: 8 × 50 = **400**
- 8 alignments: 8 × 25 = **200**
- 8 ladders: 8 × 15 = **120**
- 8 reviews: 8 × 20 = **160**
- 8 starts: 8 × 10 = **80**
- **Perfect score: 1,760 points** with zero penalties

Every rejection, send-back, or block reduces that number. Compare your module's actual score against 1,760 to see how clean your run was.

**Net velocity score = bonus - penalty.** The score tells you how well the partnership is functioning, not how fast the team is shipping.

---

## 8. Governance Rules

### AI Authority Gates

Certain steps require human sign-off and cannot be completed by AI alone:
- **Requirements** — requires human approval (AI cannot mark complete)
- **User Testing** — requires human approval
- **User Acceptance** — requires human approval

If AI attempts to complete these steps, the move is rejected with a 400 error.

### AI Recommendation Checks

Certain steps flag misalignment if a human approves without prior AI review:
- **Architecture** — requires AI recommendation before human approval
- **Development** — requires AI recommendation before human approval

If a human approves these steps without AI having reviewed them in the current cycle, the turn is flagged as misaligned (no alignment bonus, misalignment counter incremented). The approval still proceeds — it's a flag, not a block.

### Blocked Escalation

When a step is blocked:
- The reason and timestamp are recorded (\`blocked_reason\`, \`blocked_since\`)
- The -10 point penalty applies
- When unblocked, the reason and timestamp are cleared

### Step Locking

Completed steps can be locked to prevent send-back resets. Locked steps cannot be overwritten by a send-back operation.

---

## 9. For AI Agents — The Complete API Playbook

### Authentication
All write endpoints require an API key:
\`\`\`
X-API-Key: velo_your_key_here
\`\`\`

**GitHub & SharePoint credentials** are managed by the human in Velo Settings. The AI agent never needs or sees these tokens — Velo injects them automatically on every git/SharePoint API call.

### Step 1: Survey the Board
\`\`\`bash
curl -H "X-API-Key: velo_xxx" \\
  https://your-app/api/v1/velocity
\`\`\`
Returns all projects, modules, steps with statuses. Find steps where \`status = "ai_working"\` — those are assigned to you.

### Step 2: Read Your Instructions
\`\`\`bash
curl -H "X-API-Key: velo_xxx" \\
  https://your-app/api/v1/velocity/modules/{moduleId}/steps/{stepName}/turns
\`\`\`
Read the most recent turn content — the human left instructions for you.

### Step 3: Do the Work
Perform the task described in the instructions. Generate artifacts, write code, create documents.

### Step 4: Make Your Move
\`\`\`bash
curl -X PUT -H "X-API-Key: velo_xxx" -H "Content-Type: application/json" \\
  https://your-app/api/v1/velocity/modules/{moduleId}/steps/{stepName} \\
  -d '{
    "status": "human_review",
    "actor": "ai",
    "content": "Completed architecture design. Created API schema with 12 endpoints...",
    "attachments": [
      {"filename": "architecture.md", "url": "https://..."},
      {"filename": "api-schema.yaml", "url": "https://..."}
    ]
  }'
\`\`\`

### Step 5: Add Progress Notes (without changing status)
\`\`\`bash
curl -X POST -H "X-API-Key: velo_xxx" -H "Content-Type: application/json" \\
  https://your-app/api/v1/velocity/modules/{moduleId}/steps/{stepName}/turns \\
  -d '{
    "actor": "ai",
    "content": "60% complete. Working on the data model next. ETA: 2 hours."
  }'
\`\`\`

### Step 6: Review Human's Work
\`\`\`bash
# Approve
curl -X PUT -H "X-API-Key: velo_xxx" -H "Content-Type: application/json" \\
  https://your-app/api/v1/velocity/modules/{moduleId}/steps/{stepName} \\
  -d '{"status": "completed", "actor": "ai", "content": "Requirements reviewed and approved."}'

# Reject with feedback
curl -X PUT -H "X-API-Key: velo_xxx" -H "Content-Type: application/json" \\
  https://your-app/api/v1/velocity/modules/{moduleId}/steps/{stepName} \\
  -d '{"status": "human_working", "actor": "ai", "content": "Missing acceptance criteria for edge cases."}'
\`\`\`

### Step 7: Monitor via SSE
\`\`\`javascript
const evtSource = new EventSource('/api/v1/velocity/stream');
evtSource.addEventListener('move', (e) => {
  const data = JSON.parse(e.data);
  // React to board changes: data.moduleId, data.stepName, data.toStatus
});
\`\`\`

### All Velocity API Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | /velocity | Dashboard (all projects/modules/steps) |
| GET | /velocity/stream | SSE real-time event stream |
| GET | /velocity/projects/:projectId | Project velocity overview |
| GET | /velocity/modules/:moduleId | Module's 8 steps |
| PUT | /velocity/modules/:moduleId/steps/:stepName | Make a move |
| POST | /velocity/modules/:moduleId/steps/:stepName/turns | Add a note |
| GET | /velocity/modules/:moduleId/steps/:stepName/turns | Step turn history |
| GET | /velocity/modules/:moduleId/turns | Module turn history |
| POST | /velocity/modules/:moduleId/send-back | Send back to earlier step |
| PUT | /velocity/modules/:moduleId/steps/:stepName/lock | Lock/unlock a step |
| GET | /velocity/guide | Download this guide (.md) |
| POST | /git/repos | Create a GitHub repository (org optional) |
| POST | /git/repos/:owner/:repo/commits/batch | Batch commit — push multiple files in one commit (PREFERRED) |
| POST | /git/repos/:owner/:repo/commits | Create or update a single file |
| POST | /git/repos/:owner/:repo/pulls | Create a pull request |
| POST | /git/repos/:owner/:repo/branches | Create a branch |
| POST | /sharepoint/projects/:projectId/folders | Create SharePoint folder hierarchy |
| POST | /sharepoint/folders/:folderId/files | Upload file to SharePoint |
| POST | /sharepoint/modules/:moduleId/steps/:stepName/artifacts | Upload step artifact |
| GET | /leaderboard?period=month\|year\|all | Ranked leaderboard |
| GET | /leaderboard/me | Your points + history |
| GET | /leaderboard/project/:projectId/contributors | Project contributors |
| GET | /challenges?status=open\|claimed\|closed\|completed | Challenge board |
| GET | /challenges/:projectId | Single challenge with its acceptances (clones) |
| POST | /challenges/:projectId/accept | Accept a challenge by cloning it (v5.1) |
| POST | /challenges/:projectId/close | Close to new acceptances (creator/admin) |
| POST | /challenges/:projectId/pick-winner | Pick winning acceptance + award points |
| POST | /projects/:id/clone | Clone any top-level project (general-purpose) |
| GET | /projects/:id/cluster | Parent + all clones in lineage |

---

## 10. Cloning, Clusters, and Challenges (v5.1)

**Cloning is how multiple agents/people compete in parallel without colliding.**
Each clone is a fully independent project — own velocity board, members, audit trail,
SharePoint folders. Single-level only (clones can't be cloned).

- **Accept a challenge** = clone the parent challenge. Creates a new project
  with \`fk_project_parent\` set to the challenge's ID. Idempotent per user
  (re-accepting returns the existing clone).
- **\`challenge_max_acceptances\`** — \`null\` is unlimited; an integer caps it
  first-come, first-served. Returns \`409 CHALLENGE_FULL\` when full.
- **Close** stops new acceptances; existing clones can still complete.
- **Pick winner** awards \`challenge_points\` (split evenly across the winning
  clone's owners) plus a 25 % speed bonus when within \`challenge_max_days\`.
- **Velocity board grouping:** parent rows have an amber tint + 👑 + "PARENT"
  label; clones are violet-tinted with ↳ and "CLONE" + version label. The
  module rows under each get a left-border tint matching their parent group,
  so within a cluster you can see at a glance which steps belong to which
  version. Use \`fk_project_parent\` and \`pk_project\` to deduplicate (they
  share a name by default).

**SharePoint folders auto-provision** on \`POST /projects\`,
\`POST /projects/:id/modules\`, and \`POST /projects/:id/clone\`. No manual
"Create Folders" click needed — the standard hierarchy
(\`/Velo Projects/{Project}/{Module}/{Step}/\` + \`/Audits/\` + \`/Requirements/\`)
appears within seconds, and a \`sharepoint_folders_created\` SSE event with
\`autoProvisioned: true\` fires when it lands.

---

## 11. SSE Events Reference

| Event | Payload | When |
|-------|---------|------|
| connected | { clients } | On initial connection |
| clients | { count } | When anyone joins/leaves |
| move | { moduleId, stepName, fromStatus, toStatus, actor, turn } | Status change |
| note | { moduleId, stepName, turn } | Note added |
| send_back | { moduleId, targetStepName } | Module sent back |
| lock | { moduleId, stepName, locked } | Step lock toggled |
| project_created | { projectId, projectName } | New project added |
| project_updated | { projectId, projectName, status } | Project modified |
| project_deleted | { projectId, projectName } | Project removed |
| module_created | { projectId, moduleId, moduleName } | New module added |
| module_updated | { projectId, moduleId, moduleName, status } | Module modified |
| module_deleted | { projectId, moduleId, moduleName } | Module removed |
| version_created | { projectId, parentId, projectName, versionLabel, clonedBy } | A clone was made |
| version_renamed | { projectId, versionLabel, renamedBy } | Version label changed |
| member_added / member_removed / member_role_changed | { projectId, userId, role } | Membership change |
| ownership_transferred | { projectId, fromUserId, toUserId } | Ownership flip |
| lock_acquired / lock_released | { projectId, lockedBy / releasedBy, forceReleased? } | Project lock change |
| clone_policy_changed | { projectId, disabled, reason, by } | Admin toggled clone policy |
| sharepoint_folders_created | { projectId, foldersCreated, autoProvisioned } | SharePoint hierarchy provisioned |
| challenge_accepted | { projectId (clone), parentId, accepterId } | Someone accepted a challenge |
| challenge_closed | { projectId, closedBy } | Creator closed a challenge |
| challenge_winner_picked | { parentId, winnerProjectId, pointsAwarded } | Creator picked the winner |
| challenge_claimed / challenge_completed / challenge_unclaimed | { projectId, userId } | Legacy single-claimer flow |

---

## Appendix: OpenAPI Specification (Velocity Endpoints)

\`\`\`yaml
${velocitySection.trim()}
\`\`\`

---

*Generated by Velo — Project Tool for AI*
`;

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="velocity-gameplay-guide.md"');
  res.send(guide);
}
