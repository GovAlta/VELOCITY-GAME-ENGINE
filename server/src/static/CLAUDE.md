# CLAUDE.md — Velo AI Agent Instructions

You are an AI agent working with the **Velo** platform — an AI project tracking and delivery intelligence system.

This document is **prescriptive guidance**: workflow patterns, game rules, multi-step recipes, behavioral expectations, and error-handling strategy. It deliberately does NOT enumerate every endpoint — that's openapi's job.

---

> ## 📡 Live endpoint reference: `GET /api/v1/docs`
>
> The canonical, always-current OpenAPI 3.0 spec — every path, method,
> parameter, request/response schema, error code — is served at
> `$VELO_BASE_URL/api/v1/docs`. Fetch it once at startup and whenever you
> need to look up an endpoint shape. The spec follows the deployed engine,
> so it cannot drift from reality.
>
> This file (`/api/v1/velocity/claude-md`) carries what openapi structurally
> can't: workflow patterns, game mechanics, behavioral rules, multi-step
> recipes, strategy. It changes rarely.

---

## Authentication

All Velo operations require a single API key, sent as `X-API-Key: velo_xxx` on every request. No GitHub PAT or SharePoint token needed — the Velo server injects user-saved GitHub credentials and system-level Microsoft Graph credentials transparently.

Base URL: `https://your-velo-instance/api/v1`

---

## Your Workflow

A project contains **modules**. Each module has its own 8-step **velocity board**. SharePoint folders mirror the hierarchy: `/Project/Module/StepName/`. GitHub repos are linked at the project level.

Typical agent loop:

1. **Survey** — find steps assigned to AI: `GET /velocity` → filter `status="ai_working"`
2. **Read** — turn history for the step before you act: `GET /velocity/modules/{moduleId}/steps/{stepName}/turns`
3. **Understand** — pull SharePoint artifacts for context
4. **Work** — produce code, documents, analyses
5. **Deliver** — upload artifacts to SharePoint, commit code to GitHub
6. **Advance** — make a velocity move to hand off for review
7. **Repeat** — monitor the SSE stream for new assignments

---

## 1. Projects

Read details with `GET /projects/{projectId}`. The response carries modules, links, budgets, leads, applications, contracts, **collaboration state** (`project_revision`, `project_is_locked`, `fk_project_parent`, `project_clone_disabled`), and **ownership**.

**Always check what you can do before writing:**

```bash
curl -H "X-API-Key: $KEY" $BASE/projects/{projectId}/permissions
```

The response is a single object with every `canX` boolean: `canRead`, `canWriteProject`, `canMakeVelocityMoves`, `canManageMembers`, `canRename`, `canToggleLock`, `canTogglePolicy`, `canClone`. **Branch on these instead of trying writes and reacting to 403s.**

GitHub repos are listed in `project.links[]` with `link_type: "github"`. Always check existing links before creating a new repo — one may already be linked.

---

## 1A. Cloning, Clusters, Membership (v5.1)

### The model in one sentence

A project may be **cloned** (single level) so multiple people/agents can take it on independently in parallel. Each clone is a fully separate project with its own velocity board, members, audit trail, and SharePoint folders. The parent + all clones form a **cluster** (linked by `fk_project_parent`).

### Clone semantics

`POST /projects/{id}/clone` returns a fresh clone. What's copied: project metadata, modules (fresh UUIDs trigger auto-creating new `module_velocity` rows), `project_link` (default ON), `project_budget` (default OFF). What's reset: status → `discovery`, percent_complete → 0, dates → null, audit/turn/update history → fresh.

The **cloner becomes the sole owner of the clone** automatically (no extra `POST /members` needed). SharePoint folder hierarchy auto-provisions for the clone.

**Errors:** `403 CLONE_DISABLED` (admin policy), `422 CLONE_OF_CLONE` (single-level only).

### Clusters

`GET /projects/{id}/cluster` returns parent + all clones, with each clone's owner, lock state, and progress. Pass a clone's UUID; the API resolves up to the parent and returns the cluster from there.

### Membership — open vs claimed

A project with **zero active members** is **open**: any runner+ may edit. The first `POST /members` (or auto-bootstrap from `POST /clone`) **claims** the project — from then on only members may edit.

**Errors:** `403 NOT_A_MEMBER`, `403 OWNER_REQUIRED`, `409 LAST_OWNER` (can't demote/remove the last owner while collaborators remain — promote someone else first or use `transfer-ownership`), `409` (user is already a member).

### Member roles

| Role | Capabilities |
|------|-------------|
| `owner` | Add/remove members, change roles, transfer ownership, lock, rename version, complete challenges, delete project |
| `collaborator` | Edit (when unlocked), make velocity moves, create modules/budgets/links, run audits |

### Project lock

For focused work (long audit, large migration), acquire the lock to make every other write fail `423 PROJECT_LOCKED` for everyone except yourself. **Owner-only to acquire.** Admins can force-unlock (writes an audit entry).

**Errors:** `409 ALREADY_LOCKED`, `403 LOCK_OWNED_BY_OTHER` (when not admin and not the locker), `423 PROJECT_LOCKED` (returned by any write attempt when locked by someone else).

### Clone-policy (admin only)

Admins can disable cloning of a specific project via `PATCH /projects/{id}/clone-policy`. Existing clones unaffected. **Admins are NOT exempt** — to clone a disabled project, re-enable, clone, then re-disable.

---

## 1B. Multi-Agent Concurrency: `If-Match` + `Idempotency-Key`

When multiple agents may operate on the same project or velocity step, **always include both headers** on writes. Without them, your writes silently last-win over a concurrent agent's work.

### Optimistic concurrency — `If-Match` (mandatory for safe agents)

Every project response carries `project_revision`; every velocity step response carries `step_revision`. Both auto-bump on every UPDATE via DB triggers.

Send the value you read back as `If-Match` on writes. If another actor committed in between, you get **412 PRECONDITION_FAILED** with the current revision in `details[0].message`. Refetch and decide whether your intent still applies.

`If-Match` is wired on every project-scoped write (projects, modules, budgets, links, leads, updates, members, lock, clone-policy, version-label) and on every velocity move/note/lock route.

### Idempotency — `Idempotency-Key` (mandatory for retried writes)

Send a fresh UUID per **intended action** (not per HTTP attempt). On retry, re-send the same UUID with the same body — the server replays the cached response (cached for **24 hours**) with header `Idempotency-Replayed: true`. Different body with same UUID returns **422 IDEMPOTENCY_KEY_REUSED**.

Wired on: every velocity move/note/send-back, every project write route.

### Golden recipe — chess-clock move with both headers

```bash
MID="..."   # module UUID
STEP="architecture"
KEY_UUID=$(uuidgen)   # generate ONCE per logical action

# 1. Read the module — pick the step's current revision
RESP=$(curl -s -H "X-API-Key: $KEY" $BASE/velocity/modules/$MID)
REV=$(echo "$RESP" | jq -r --arg s "$STEP" '.data.steps[] | select(.step_name==$s) | .step_revision')

# 2. Make the move with both headers
curl -X PUT -H "X-API-Key: $KEY" \
     -H "If-Match: $REV" \
     -H "Idempotency-Key: $KEY_UUID" \
     -H "Content-Type: application/json" \
     $BASE/velocity/modules/$MID/steps/$STEP \
     -d '{"status":"human_review","actor":"ai","content":"Architecture complete."}'

# 3. On network failure or 5xx, retry with the SAME KEY_UUID — server replays.
```

Race outcome: if a parallel agent committed first, your `If-Match` fails with `412`. Refetch, decide whether intent still applies, retry with a **fresh** `Idempotency-Key` (intent changed).

---

## 2. The Velocity Game

### The 8 steps (in order)

1. **Requirements** — what is being built and why
2. **Planning** — tasks, dependencies, NFR coverage map
3. **Architecture** — system design + ADRs
4. **Prototyping** — tracer-bullet proof of concept
5. **Development** — full implementation
6. **User Testing** — functional + non-functional verification
7. **User Acceptance** — stakeholder sign-off
8. **Deployment** — release to production

### Status states

| Status | Meaning |
|---|---|
| `not_started` | Cell not opened |
| `ready_to_start` | Cell open, awaiting pickup |
| `ai_working` | AI agent has the clock |
| `human_working` | Human has the clock |
| `ai_review` | AI is reviewing work |
| `human_review` | Human is reviewing work |
| `completed` | Approved, step done |
| `blocked` | External impediment (penalty applies) |
| `hand_raised` | Help/attention requested (no penalty) |

### Valid transitions

```
not_started     → ready_to_start                       (open the cell)
                | hand_raised | blocked                (universal — see below)
ready_to_start  → ai_working | human_working
                | hand_raised | blocked
ai_working      → ai_review | human_review
                | human_working      (lateral handoff, no work judged)
                | ready_to_start     (rewind — nothing actually started)
                | hand_raised | blocked
human_working   → ai_review | human_review
                | ai_working         (lateral handoff)
                | ready_to_start     (rewind)
                | hand_raised | blocked
ai_review       → ai_working | human_working | completed
                | hand_raised | blocked
human_review    → ai_working | human_working | completed
                | hand_raised | blocked
blocked         → ready_to_start | ai_working | human_working | hand_raised
hand_raised     → ai_working | human_working | ai_review | human_review | blocked
completed       → ready_to_start (reopens the step)
                | hand_raised | blocked   (flag rework needed)
```

**`hand_raised` and `blocked` are universally available from every other state.** Always reachable. Use `hand_raised` when you need attention or a decision (no penalty, treated as a pause); use `blocked` when there's a concrete external impediment requiring rework (penalty applies, but the signal is worthwhile).

Lateral handoff (`ai_working ↔ human_working`) and rewind (`*_working → ready_to_start`) record the turn as `turn_action = 'pass'`. They let you re-route a step without polluting the audit log with a fake review or block turn.

### Membership applies to every velocity write

**Velocity writes require project membership.** Claimed project (≥1 member) → non-members get `403 NOT_A_MEMBER`. Open project (no members) → any runner+ may write. **Admin role does not bypass** — admins must add themselves as a member to play.

### Errors specific to velocity writes

- `403 NOT_A_MEMBER` — claimed project, you're not a member; skip the event
- `423 PROJECT_LOCKED` — someone else holds the project lock; wait for `lock_released` SSE
- `412 PRECONDITION_FAILED` — stale `If-Match`; refetch and retry
- `400 INVALID_TRANSITION` — your `toStatus` isn't reachable from current state
- `422 IDEMPOTENCY_KEY_REUSED` — replay attempted with different body
- `422 SCORING_GOVERNANCE` — step requires human approval and AI tried to complete it

### Read turn history before acting

```bash
# Single step
curl -H "X-API-Key: $KEY" $BASE/velocity/modules/$MID/steps/$STEP/turns

# Whole module, paginated — survey activity across all 8 steps
curl -H "X-API-Key: $KEY" "$BASE/velocity/modules/$MID/turns?page=1&limit=20"
```

**Always read the prior turn's content before moving.** The human left instructions for you.

### Make a move

See § 1B for the complete chess-clock pattern (`If-Match` + `Idempotency-Key`). The move body shape:

```json
{
  "status": "human_review",
  "actor": "ai",
  "content": "Architecture complete. See attached system diagram.",
  "attachments": [
    { "filename": "architecture.md", "url": "https://sharepoint-url/..." }
  ]
}
```

### Send-back (cross-step rework)

`POST /velocity/modules/{moduleId}/send-back` with `{ targetStep, content, actor }` resets target step to `ready_to_start` and all intermediate steps to `not_started`. **The most expensive action — use sparingly.** Loops the affected steps; -50 points.

### Scoring (collaboration quality)

| Event | Points |
|---|---|
| Step completed (approved by review) | +10 |
| Perfect run (zero loops on the step) | +15 bonus |
| Aligned approval (both human and AI participated) | bonus |
| Misaligned approval (one actor only) | reduced |
| `*_review → *_working` (rejected back) | −30, loop count +1 |
| `completed → ready_to_start` (send-back) | −50 |
| `blocked` entered | penalty |
| `hand_raised` entered | no penalty |

Points distribute across contributors per module: see `GET /leaderboard/module/{moduleId}/contributors`.

---

## 3. SharePoint workflow

SharePoint is the document repository — where artifacts (requirements docs, architecture diagrams, test plans, sign-offs) live. The Velo server handles all Microsoft Graph auth transparently.

### Folder ID conventions

- **`pk_sharepoint_folder`** (UUID) — the DB-tracked folder for a project, module, or step. Use these for the `/folders/{folderId}/...` endpoints.
- **Graph `driveItem` ID** — for browsing into subfolders not tracked in the DB. Use these for the `/items/{spItemId}/...` endpoints.

The hierarchy auto-provisions on project create/clone:
`Velo Projects/{ProjectName (last4uuid)}/{ModuleName (last4uuid)}/{stepName}/`

### Upload an artifact to a velocity step

The most common SharePoint action — auto-creates the step folder if missing:

```bash
curl -X POST -H "X-API-Key: $KEY" \
  -F "file=@/path/to/architecture.md" \
  $BASE/sharepoint/modules/{moduleId}/steps/{stepName}/artifacts
```

Then include the resulting `webUrl` in your velocity-move `attachments`.

### Create file from typed content (blank-file)

For text content you generate inline (markdown, JSON, code), skip the multipart upload:

```bash
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  $BASE/sharepoint/folders/{folderId}/blank-file \
  -d '{"filename": "notes.md", "content": "# Notes\n..."}'
```

Filename rejects SharePoint-illegal characters (`" * : < > ? / \ |`), control chars, `.`, `..`, and trailing dot/space. Max 250 MB.

### Update an existing file in place

Edit content without losing the driveItem ID or version history:

```bash
curl -X PUT -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  $BASE/sharepoint/files/{itemId}/content \
  -d '{"content": "# Revised notes\n..."}'
```

### AI shadow files

After any upload, the AI queue automatically generates a markdown "shadow" of binary documents (PDF page OCR, DOCX/PPTX extraction) prefixed `__AI__`. Use shadows for content analysis — they're text-searchable while the originals are binary.

Monitor progress via SSE events: `sharepoint_ai_job_started`, `sharepoint_ai_shadow_created`, `sharepoint_ai_job_failed`, `sharepoint_ai_sub_progress`.

For list/download/rename/move/search/ZIP-import/ZIP-export and AI-queue management, see openapi at `/api/v1/docs`.

---

## 4. GitHub workflow

The Velo server injects a project lead's saved GitHub PAT on every Git API call — you never see or handle credentials. Use Velo's Git endpoints, not the GitHub API directly.

### Discover the linked repo

```bash
# project.links[] contains { link_type: "github", link_url: "https://github.com/Org/Repo", ... }
curl -H "X-API-Key: $KEY" $BASE/projects/{projectId}
```

Always check existing links before creating a new repo with `POST /git/repos`.

### Batch commits (PREFERRED for development)

When you implement a feature, push all the files in **one commit**, not many small commits:

```bash
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  $BASE/git/repos/{owner}/{repo}/commits/batch \
  -d '{
    "branch": "feature/auth",
    "message": "Add JWT authentication with refresh rotation",
    "files": [
      { "path": "src/middleware/jwt.ts", "content": "..." },
      { "path": "src/routes/auth.ts",   "content": "..." }
    ]
  }'
```

For single-file commits, PRs, branches, file reads, and analytics, see openapi.

---

## 5. Audits

Audits are read-only quality checks against a project's code, configuration, or content. Each audit returns a structured report and can be exported (JSON / Markdown / DOCX) and pushed to SharePoint for human review.

| Audit type | Endpoint | When to run |
|---|---|---|
| **Git audit** | `POST /projects/:id/audits` (`source: "git"`) | After step 5 (Development) |
| **Deep code audit** | `POST /projects/:id/deep-audit` | After step 5; long-running, has SSE progress stream |
| **SharePoint content audit** | `POST /sharepoint/projects/:projectId/audit` | After steps 1-3 (Requirements / Planning / Architecture) |

Deep audits have a live progress stream at `GET /projects/:id/deep-audit/:auditId/stream` and one-shot status at `GET /projects/:id/deep-audit/:auditId/status`. Run LLM analysis on an existing audit with `POST /projects/:id/audits/:auditId/analyze`. Exports: `GET /projects/:id/audits/:auditId/export/{json|md|docx}`.

See openapi for full endpoint shapes.

---

## 6. Real-Time Monitoring (SSE)

Subscribe to the velocity event stream to react to board changes in real-time:

```bash
curl -N -H "X-API-Key: $KEY" $BASE/velocity/stream
```

Or in JavaScript:

```javascript
const evtSource = new EventSource(`${BASE}/velocity/stream`);

// Velocity board
evtSource.addEventListener('connected',  (e) => { /* { clients } */ });
evtSource.addEventListener('clients',    (e) => { /* { count } */ });
evtSource.addEventListener('move',       (e) => { /* { projectId, moduleId, stepName, fromStatus, toStatus, action, actor, updatedStep, turn } */ });
evtSource.addEventListener('note',       (e) => { /* { moduleId, stepName, turn } */ });
evtSource.addEventListener('send_back',  (e) => { /* { moduleId, targetStepName, actor } */ });
evtSource.addEventListener('lock',       (e) => { /* { moduleId, stepName, locked } */ });

// Project / module lifecycle
evtSource.addEventListener('project_created', (e) => {});
evtSource.addEventListener('project_updated', (e) => {});
evtSource.addEventListener('project_deleted', (e) => {});
evtSource.addEventListener('module_created',  (e) => {});
evtSource.addEventListener('module_updated',  (e) => {});
evtSource.addEventListener('module_deleted',  (e) => {});

// Collaboration (v5.0)
evtSource.addEventListener('member_added',          (e) => {});
evtSource.addEventListener('member_removed',        (e) => {});
evtSource.addEventListener('member_role_changed',   (e) => {});
evtSource.addEventListener('ownership_transferred', (e) => {});
evtSource.addEventListener('version_created',       (e) => {});
evtSource.addEventListener('version_renamed',       (e) => {});
evtSource.addEventListener('lock_acquired',         (e) => {});
evtSource.addEventListener('lock_released',         (e) => {});
evtSource.addEventListener('clone_policy_changed',  (e) => {});

// SharePoint
evtSource.addEventListener('sharepoint_folders_created',   (e) => { /* { projectId, foldersCreated, autoProvisioned: true } */ });
evtSource.addEventListener('sharepoint_file_uploaded',     (e) => {});
evtSource.addEventListener('sharepoint_file_updated',      (e) => {});
evtSource.addEventListener('sharepoint_file_deleted',      (e) => {});
evtSource.addEventListener('sharepoint_folder_deleted',    (e) => {});
evtSource.addEventListener('sharepoint_subfolder_created', (e) => {});
evtSource.addEventListener('sharepoint_item_renamed',      (e) => {});
evtSource.addEventListener('sharepoint_item_moved',        (e) => {});
evtSource.addEventListener('sharepoint_ai_job_started',    (e) => {});
evtSource.addEventListener('sharepoint_ai_job_failed',     (e) => {});
evtSource.addEventListener('sharepoint_ai_shadow_created', (e) => {});
evtSource.addEventListener('sharepoint_ai_skipped',        (e) => {});
evtSource.addEventListener('sharepoint_ai_sub_progress',   (e) => {});
evtSource.addEventListener('sharepoint_ai_processing_all', (e) => {});

// Challenges (v5.1)
evtSource.addEventListener('challenge_accepted',      (e) => {});
evtSource.addEventListener('challenge_closed',        (e) => {});
evtSource.addEventListener('challenge_winner_picked', (e) => {});
```

A 30-second heartbeat (`:heartbeat`) keeps connections alive. On disconnect, the EventSource auto-reconnects — your handlers should be **idempotent under replay**.

### Filter to your project

The stream is global by design (one subscription captures every project's events). Filter client-side on `data.projectId`. **Important:** acting on a move from a project you're not a member of will be blocked at the API with `403 NOT_A_MEMBER`; ignore those events.

### Admin SSE diagnostics

Admins debugging connection counts can pull a snapshot grouped by api_key / user / IP:

```bash
curl -H "X-API-Key: $ADMIN_KEY" $BASE/admin/sse-sessions
```

Returns `{ total, byAuth, byApiKey, byUser, byIp, sessions }` — top callers sorted descending by count. Admin role required.

---

## 7. Leaderboard & Points

Points are awarded for every velocity action and distributed across contributors. The leaderboard tracks contributions across projects and challenges.

| What you can query | Endpoint |
|---|---|
| Global leaderboard | `GET /leaderboard?period={month|year|all}` |
| Your own points | `GET /leaderboard/me` |
| Your history | `GET /leaderboard/user/{userId}/history` |
| Per-project contributors | `GET /leaderboard/project/{projectId}/contributors` |
| Per-module contributors | `GET /leaderboard/module/{moduleId}/contributors` |

### How points are shared

A step's points distribute proportionally to contributors based on `velocity_turn` rows: who started it, who reviewed, who approved. Both human and AI contributors share. See openapi for response shapes.

---

## 8. Challenges (v5.1 cloning-based flow)

A **challenge** is a project marked `project_is_challenge = true` with an optional prize. Multiple participants can **accept** the challenge — each acceptance produces a clone they work in independently. The challenge creator picks a winner, who receives the prize.

### Flow

1. **Create** — any project becomes a challenge via `is_challenge: true` on creation.
2. **Accept** — `POST /challenges/{projectId}/accept` clones the challenge for you; you become owner of the clone, work the velocity board there.
3. **Close to new acceptances** — creator/admin calls `POST /challenges/{projectId}/close` when judging starts (existing acceptances continue).
4. **Pick winner** — creator/admin calls `POST /challenges/{projectId}/pick-winner` with `{ winnerProjectId, pointsAwarded }`.

For listing, single-challenge detail, and legacy single-claimer endpoints (`/claim`, `/complete`, `/unclaim`), see openapi.

---

## 9. AI Agent Strategy

1. **Read before you write.** Always call GET on the turn history before making a move. Understand what the human asked for, what evidence was provided, and what previous reviewers flagged.
2. **Evidence wins approvals.** Every move should include attachments — links to documents, code, diagrams, test results. Moves without evidence get rejected, costing loop points.
3. **Post progress updates.** For long tasks, use `POST .../turns` to share intermediate progress. This keeps the human informed and prevents premature send-backs.
4. **Respect the state machine.** Only valid transitions are allowed (see § 2). Don't try to skip from `not_started` to `completed`.
5. **Send-backs are nuclear.** Use only when the issue is fundamental (wrong requirements, flawed architecture). For minor issues, reject and loop within the current step instead.
6. **Check permissions before acting.** `GET /projects/{id}/permissions` returns `canMakeVelocityMoves` — the cheap pre-flight that prevents wasted moves on projects you don't belong to.
7. **Use `If-Match` + `Idempotency-Key` on every write.** Always. See § 1B.

---

## Complete Example: Working a Step End-to-End

```bash
# 1. Find your work
curl -H "X-API-Key: $KEY" $BASE/velocity | jq '.data.steps[] | select(.status == "ai_working")'
# → { moduleId, stepName, stepRevision, ... }

MODULE_ID="..."  STEP="architecture"

# 2. Confirm you can act on this project (membership / lock pre-flight)
PERMS=$(curl -s -H "X-API-Key: $KEY" $BASE/projects/{projectId}/permissions)
echo "$PERMS" | jq '.data.canMakeVelocityMoves'   # → true

# 3. Read turn history — what does the human want?
curl -H "X-API-Key: $KEY" $BASE/velocity/modules/$MODULE_ID/steps/$STEP/turns

# 4. Pull existing artifacts for context
curl -H "X-API-Key: $KEY" $BASE/sharepoint/modules/$MODULE_ID/steps/requirements/artifacts

# 5. Do the work (write architecture.md, draw the diagram, etc.)

# 6. Upload your deliverable to SharePoint
curl -X POST -H "X-API-Key: $KEY" \
  -F "file=@architecture.md" \
  $BASE/sharepoint/modules/$MODULE_ID/steps/$STEP/artifacts
# → { webUrl }

# 7. Read the current step_revision before moving
RESP=$(curl -s -H "X-API-Key: $KEY" $BASE/velocity/modules/$MODULE_ID)
REV=$(echo "$RESP" | jq -r --arg s "$STEP" '.data.steps[] | select(.step_name==$s) | .step_revision')

# 8. Make the move — hand off to human for review (both safety headers!)
KEY_UUID=$(uuidgen)
curl -X PUT -H "X-API-Key: $KEY" \
  -H "If-Match: $REV" \
  -H "Idempotency-Key: $KEY_UUID" \
  -H "Content-Type: application/json" \
  $BASE/velocity/modules/$MODULE_ID/steps/$STEP \
  -d '{
    "status": "human_review",
    "actor": "ai",
    "content": "Architecture complete. Component diagram + ADRs uploaded. Ready for review.",
    "attachments": [{ "filename": "architecture.md", "url": "https://sharepoint/..." }]
  }'

# 9. Subscribe to SSE for the human's approval/rejection
curl -N -H "X-API-Key: $KEY" $BASE/velocity/stream | grep --line-buffered "move"
```

---

*Generated by Velo — Project Tool for AI.*
*For the live endpoint catalog, fetch `GET /api/v1/docs`.*
