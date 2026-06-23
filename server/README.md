# Velo Server

Express.js + TypeScript + PostgreSQL API backend for the Velo AI project tracker.

Tracks technology projects across an organization's ministries/departments with real-time human-AI collaboration via the Velocity game engine, deep code/content auditing, SharePoint document management, and GitHub integration.

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- A Google and/or Microsoft OAuth app (for SSO)

### Install

```bash
cd app/server
npm install
```

### Environment

```bash
cp .env.example .env
# Edit .env with your database URL, OAuth credentials, etc.
```

### Generate JWT Keys

```bash
npm run generate-keys
# Creates RSA key pairs in server/keys/ for access and refresh tokens
```

### Migrate

```bash
npm run db:migrate
# Runs all 53 migrations in order
```

### Seed (optional)

```bash
npm run db:seed
```

### Run

```bash
npm run dev          # Development (tsx watch, auto-reload)
npm run build        # Compile TypeScript
npm start            # Production (NODE_ENV=production, serves client/dist)
```

---

## Architecture

```
routes/          Route definitions, parameter validation
middleware/      Auth, CSRF, rate limiting, RBAC guards, Helmet, CORS
controllers/     Request handling, input mapping (camelCase -> snake_case)
services/        Business logic, external API calls, LLM orchestration
models/          Database queries (raw SQL via pg), transaction helpers
config/          Environment validation (Zod), auth config, DB pool
validators/      Zod schemas for all request inputs
sse/             Server-Sent Events emitters (velocity, deep-audit, sharepoint-audit)
scripts/         CLI tools (migrate, rollback, seed, set-role, generate-keys)
utils/           Shared helpers (logger, crypto, export formatters)
types/           TypeScript type definitions
```

Request flow: `route -> middleware -> controller -> service -> model -> PostgreSQL`

All request bodies use **camelCase**. All responses use **snake_case** (DB column names). Controllers handle the mapping.

---

## Authentication & Authorization

### SSO (Browser Sessions)

Two OAuth 2.0 providers via Passport:

- **Google**: `GET /api/v1/auth/google` -> Google consent -> callback -> set cookies
- **Microsoft**: `GET /api/v1/auth/microsoft` -> Azure AD consent -> callback -> set cookies

On success, the server issues:
- `access_token` cookie (RS256 JWT, 15min)
- `refresh_token` cookie (RS256 JWT, 7d, httpOnly)

Token refresh: `POST /api/v1/auth/refresh` rotates both tokens.

### CSRF Protection

Double-submit cookie pattern:
1. `GET /api/v1/auth/csrf` returns a CSRF token
2. Include `X-CSRF-Token` header on all write requests (POST/PUT/PATCH/DELETE)
3. Server validates HMAC signature using `CSRF_SECRET`

### API Keys

For programmatic access (CI/CD, AI agents, scripts):
- Generate via `POST /api/v1/api-keys` (full key shown once)
- Keys use `velo_` prefix, stored as SHA-256 hash
- Pass as `X-API-Key: velo_xxx` or `Authorization: Bearer velo_xxx`
- No CSRF required for API key auth
- Actions attributed to the key owner in the audit log

### JWT Details

- Algorithm: RS256 (RSA 2048-bit)
- Access token: 15min default (`JWT_ACCESS_EXPIRES_IN`)
- Refresh token: 7d default (`JWT_REFRESH_EXPIRES_IN`)
- Dev mode: warns if PEM keys are missing (falls back to HMAC)
- Prod mode: requires all four PEM keys or files in `server/keys/`

---

## Role System

Users can hold multiple roles simultaneously. The admin role implicitly grants all permissions.

| Role | Permissions |
|------|-------------|
| `user` | **Read-only viewer** — can see projects, dashboards, velocity board, and data but cannot modify anything |
| `runner` | **Can DO work** — velocity game (moves, notes, lock, send-back), SharePoint (upload, download, delete, rename, AI process), Git (extract, commit, PR, branch), run audits (all types), step artifacts, PAT management |
| `project_lead` | **Can SET UP work** — create/edit/delete projects, modules, budgets, leads, links, Applications & Contracts (CMDB), person management, canvas layout + everything runner can do |
| `admin` | **System administration** — user management, role assignment, settings, account enable/disable + everything project_lead can do |

Assign roles via the admin UI or CLI:

```bash
npm run set-role -- <email> <role>
```

---

## API Overview

Base URL: `/api/v1`

### Auth
- `GET /auth/google` | `GET /auth/microsoft` -- SSO login
- `GET /auth/csrf` -- Get CSRF token
- `GET /auth/me` -- Current user profile
- `POST /auth/refresh` -- Rotate tokens
- `POST /auth/logout` -- Revoke session

### Projects
- `GET|POST /projects` -- List (paginated, filterable) / Create
- `GET|PUT|DELETE /projects/:id` -- Read / Update / Soft-delete
- `POST /projects/:id/merge` -- Merge two projects (transfers all sub-resources)

### Modules
- `GET|POST /projects/:id/modules` -- List / Create
- `PUT|DELETE /projects/:id/modules/:moduleId` -- Update / Soft-delete
- Module links: `GET|POST|DELETE /projects/:id/modules/:moduleId/links`

### Budgets
- `GET|POST /projects/:id/budgets` -- List / Add budget line
- `PUT|DELETE /projects/:id/budgets/:budgetId` -- Update / Remove

### Project Links
- `GET|POST /projects/:id/links` -- List / Add external link
- `DELETE /projects/:id/links/:linkId` -- Remove

### Updates
- `GET|POST /projects/:id/updates` -- List (filterable by type) / Post
- `DELETE /projects/:id/updates/:updateId` -- Remove (audit-logged)

### Team / Leads
- `GET|POST /projects/:id/leads` -- List / Add team member
- `PUT|DELETE /projects/:id/leads/:leadId` -- Update / Remove

### Velocity (Human-AI Collaboration)
- `GET /velocity` -- Dashboard heatmap (all projects)
- `GET /velocity/stream` -- SSE stream for real-time board sync
- `GET /velocity/projects/:projectId` -- Project velocity overview
- `GET /velocity/modules/:moduleId` -- Module's 8 steps
- `PUT /velocity/modules/:moduleId/steps/:stepName` -- Make a move (chess clock)
- `GET|POST /velocity/modules/:moduleId/steps/:stepName/turns` -- Turn history / Add note
- `POST /velocity/modules/:moduleId/send-back` -- Send module to earlier step
- `PUT /velocity/modules/:moduleId/steps/:stepName/lock` -- Lock/unlock step
- `GET /velocity/guide` -- Download gameplay guide (Markdown)

### Audits
- `GET|POST /projects/:id/audits` -- List / Run audit (git, jira, confluence, sharepoint, web, manual)
- `GET|DELETE /projects/:id/audits/:auditId` -- Detail / Soft-delete (own only)
- `GET /projects/:id/audits/:auditId/export/json|md|docx` -- Export
- `POST /projects/:id/audits/:auditId/analyze` -- LLM analysis (Claude, Gemini, Grok)

### Deep Audits
- `POST /projects/:id/deep-audit` -- Run multi-phase deep code audit
- `GET /projects/:id/deep-audit/:auditId/stream` -- SSE progress stream
- `GET /projects/:id/deep-audit/:auditId/status` -- Poll status

### Git Integration
- `POST /git/repos` -- Create GitHub repository (org auto-injected from Settings)
- `POST /git/repos/:owner/:repo/commits/batch` -- **Batch commit** — push multiple files in one commit (PREFERRED)
- `POST /git/extract` -- Extract repo analytics (commits, PRs, contributors)
- `GET /git/repos/:owner/:repo/analytics` -- Cached analytics
- `GET /git/repos/:owner/:repo/files` -- Browse repo files
- `POST /git/repos/:owner/:repo/commits` -- Commit a file
- `POST /git/repos/:owner/:repo/pulls` -- Create pull request
- `POST /git/repos/:owner/:repo/branches` -- Create branch

### SharePoint Integration
- `GET /sharepoint/status` -- Connection status
- `POST|GET /sharepoint/projects/:projectId/folders` -- Create/list folder hierarchy
- `GET|POST /sharepoint/folders/:folderId/files` -- List/upload files
- `GET /sharepoint/files/:itemId/download` -- Download file
- `DELETE /sharepoint/files/:itemId` -- Delete file
- `PATCH /sharepoint/files/:itemId/rename|move` -- Rename / Move
- `GET|POST /sharepoint/modules/:moduleId/steps/:stepName/artifacts` -- Velocity step artifacts
- `POST /sharepoint/projects/:projectId/audit` -- Deep content audit
- `GET /sharepoint/search` -- Search across SharePoint

### Applications & Contracts (project_lead + admin only)
- `GET|POST /applications` -- List / Create
- `GET|PUT|DELETE /applications/:id` -- Read / Update / Soft-delete
- `GET|POST /contracts` -- List / Create
- `GET|PUT|DELETE /contracts/:id` -- Read / Update / Soft-delete
- Link to projects: `/projects/:id/applications`, `/projects/:id/contracts`

### User Management (Admin)
- `GET /users` -- List all users with roles
- `GET /users/:userId` -- User details
- `POST /users/:userId/roles` -- Add role
- `DELETE /users/:userId/roles/:role` -- Remove role
- `PATCH /users/:userId/active` -- Enable/disable account

### Other
- `GET /ministries` -- List ministries with project counts
- `GET /persons` -- People directory (paginated)
- `GET /canvas` -- Canvas data (projects + dependencies for visualization)
- `POST /canvas/positions` -- Save drag positions
- `PUT|DELETE /settings/pat` -- Manage GitHub PAT (encrypted)
- `PUT /settings/github-domain` -- Save GitHub URL (auto-extracts domain + org from URL like `https://github.com/MyOrg`)
- `GET /api-keys` -- List your API keys
- `POST /api-keys` -- Generate new API key

### Leaderboard & Points
- `GET /leaderboard?period=month|year|all` -- Ranked leaderboard (month/year/all-time)
- `GET /leaderboard/me` -- Current user's points + recent history
- `GET /leaderboard/user/:userId/history` -- Full point audit trail
- `GET /leaderboard/project/:projectId/contributors` -- Project contributors with points
- `GET /leaderboard/module/:moduleId/contributors` -- Module contributors with per-step history
- `POST /leaderboard/refresh` -- Refresh materialized view (admin)

### Challenges
- `GET /challenges?status=open|claimed|completed&difficulty=easy|medium|hard|expert` -- Challenge board
- `POST /challenges/:projectId/claim` -- Claim an open challenge
- `POST /challenges/:projectId/complete` -- Complete + earn points
- `POST /challenges/:projectId/unclaim` -- Abandon a challenge

### Health
- `GET /health` -- Basic health check
- `GET /health/ready` -- Readiness (includes DB)
- `GET /health/live` -- Liveness probe

---

## Key npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with tsx watch (auto-reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run production build (`NODE_ENV=production`) |
| `npm test` | Run tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:migrate` | Run all pending migrations |
| `npm run db:rollback` | Roll back last migration batch |
| `npm run db:seed` | Seed the database |
| `npm run set-role` | Assign role: `npm run set-role -- user@example.com admin` |
| `npm run generate-keys` | Generate RS256 JWT key pairs in `keys/` |
| `npm run generate-secrets` | Generate/audit ALL secrets (.env + JWT keys). Use `--check` to audit, `--force` to regenerate |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Server port |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `DATABASE_URL` | **Yes** | -- | PostgreSQL connection string |
| `CORS_ORIGIN` | No | `http://localhost:5173` | Allowed CORS origin |
| `API_BASE_URL` | No | -- | Public URL for OAuth callback construction |
| `SERVE_CLIENT` | No | `false` | Serve `client/dist/` as static files |
| `JWT_PRIVATE_KEY` | Prod | -- | RS256 private key (PEM) for access tokens |
| `JWT_PUBLIC_KEY` | Prod | -- | RS256 public key (PEM) for access tokens |
| `JWT_REFRESH_PRIVATE_KEY` | Prod | -- | RS256 private key (PEM) for refresh tokens |
| `JWT_REFRESH_PUBLIC_KEY` | Prod | -- | RS256 public key (PEM) for refresh tokens |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | Access token TTL |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Refresh token TTL |
| `CSRF_SECRET` | No | dev default | HMAC secret for CSRF tokens (min 32 chars) |
| `GOOGLE_CLIENT_ID` | No | -- | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | -- | Google OAuth client secret |
| `MICROSOFT_CLIENT_ID` | No | -- | Azure AD app client ID |
| `MICROSOFT_CLIENT_SECRET` | No | -- | Azure AD app client secret |
| `MICROSOFT_TENANT_ID` | No | -- | Azure AD tenant ID |
| `ANTHROPIC_API_KEY` | No | -- | Claude API key (for audit analysis) |
| `GEMINI_API_KEY` | No | -- | Google Gemini API key (for audit analysis) |
| `XAI_API_KEY` | No | -- | Grok/xAI API key (for audit analysis) |
| `AI_PROVIDER` | No | `openai` | Default LLM provider |
| `AI_API_KEY` | No | -- | Default LLM API key |
| `AI_MODEL` | No | `gpt-4o-mini` | Default LLM model |
| `AI_MAX_TOKENS` | No | `1024` | Default max tokens for LLM responses |
| `GITHUB_PAT` | No | -- | System-level GitHub PAT (fallback). Per-user PATs, `user_github_domain`, and `user_github_org` are stored in the DB. The org is auto-extracted from the GitHub URL in Settings (e.g. `https://github.com/MyOrg` → domain=`github.com`, org=`MyOrg`). |
| `ENCRYPTION_KEY` | No | dev default | AES key for encrypting stored PATs (min 16 chars) |
| `SHAREPOINT_APPLICATION_CLIENT_ID` | No | -- | SharePoint app registration client ID |
| `SHAREPOINT_APPLICATION_CLIENT_SECRET` | No | -- | SharePoint app registration secret |
| `SHAREPOINT_APPLICATION_TENANT_ID` | No | -- | SharePoint tenant ID |
| `SHAREPOINT_SITE_URL` | No | -- | SharePoint site URL |
| `DB_POOL_MAX` | No | `20` | Max database pool connections |
| `DB_IDLE_TIMEOUT_MS` | No | `30000` | Pool idle timeout (ms) |
| `DB_CONNECTION_TIMEOUT_MS` | No | `5000` | Pool connection timeout (ms) |
| `DB_STATEMENT_TIMEOUT_MS` | No | `30000` | SQL statement timeout (ms) |
| `RATE_LIMIT_API_MAX` | No | `20000` | Max API requests per window |
| `RATE_LIMIT_API_WINDOW_MS` | No | `900000` | API rate limit window (15min) |
| `RATE_LIMIT_AUTH_MAX` | No | `3000` | Max auth requests per window |
| `RATE_LIMIT_AUTH_WINDOW_MS` | No | `900000` | Auth rate limit window (15min) |
| `RATE_LIMIT_AI_MAX` | No | `6000` | Max AI/LLM requests per window |
| `RATE_LIMIT_AI_WINDOW_MS` | No | `3600000` | AI rate limit window (1hr) |
| `BODY_LIMIT_JSON` | No | `1mb` | Max JSON request body size |
| `BODY_LIMIT_URLENCODED` | No | `1mb` | Max URL-encoded body size |
| `SHUTDOWN_TIMEOUT_MS` | No | `30000` | Graceful shutdown timeout |

---

## Database

- **Engine**: PostgreSQL 15+
- **Driver**: `pg` (node-postgres) with connection pooling
- **Migrations**: 53 sequential SQL migrations in `migrations/`, run via `npm run db:migrate`
- **Rollback**: `npm run db:rollback` reverts the last batch
- **Transactions**: Use `withTransaction(callback)` helper for multi-step operations
- **Soft deletes**: Most tables use `deleted_at` column; records are never physically removed
- **Audit log**: Immutable `audit_log` table records every INSERT, UPDATE, DELETE with old/new data, user identity, and auth source (session vs API key)

---

## Real-Time (SSE)

Three Server-Sent Events streams for live updates without polling:

| Stream | Endpoint | Events |
|--------|----------|--------|
| Velocity board | `GET /velocity/stream` | `connected`, `move`, `note`, `send_back`, `lock` |
| Deep audit progress | `GET /projects/:id/deep-audit/:auditId/stream` | `phase`, `progress`, `complete`, `error` |
| SharePoint audit | (internal, triggered during SP audit) | `phase`, `progress`, `complete`, `error` |

The Velocity stream enables multiplayer: multiple humans and AI agents can watch and interact with the same board simultaneously.

---

## External Integrations

### SharePoint (Microsoft Graph API)

- Client credentials flow (app-only, no user consent)
- Manages folder hierarchies per project/module/step
- File upload/download/rename/move/delete
- Deep content audit: reads documents, runs LLM analysis on content completeness
- Requires: `SHAREPOINT_APPLICATION_CLIENT_ID`, `SHAREPOINT_APPLICATION_CLIENT_SECRET`, `SHAREPOINT_APPLICATION_TENANT_ID`, `SHAREPOINT_SITE_URL`

### GitHub

- GraphQL API for repository analytics (commits, PRs, contributors)
- REST API for file operations (browse, commit, branch, pull request)
- Per-user PAT stored encrypted, with system-level `GITHUB_PAT` fallback
- Deep audit: scans entire repo tree, AI-selects key files, runs batched LLM analysis

### LLM Providers

Multi-provider abstraction for audit analysis:

| Provider | Env Var | Use |
|----------|---------|-----|
| Claude (Anthropic) | `ANTHROPIC_API_KEY` | Deep audits, project analysis |
| Gemini (Google) | `GEMINI_API_KEY` | Deep audits, project analysis |
| Grok (xAI) | `XAI_API_KEY` | Deep audits, project analysis |

---

## Deployment

### Docker

The server can be containerized with a standard Node.js Dockerfile. In production:

- Set `NODE_ENV=production`
- Set `SERVE_CLIENT=true` to serve the Vue client from `client/dist/`
- Provide all four JWT PEM keys as environment variables (or mount `keys/` volume)
- Set `CSRF_SECRET` and `ENCRYPTION_KEY` to strong random values

### Health Checks

| Endpoint | Purpose | Checks |
|----------|---------|--------|
| `GET /api/v1/health` | General health | Server is running |
| `GET /api/v1/health/ready` | Readiness probe | Server + database connectivity |
| `GET /api/v1/health/live` | Liveness probe | Process is alive (always 200) |

### Graceful Shutdown

On `SIGTERM` / `SIGINT`:
1. Stops accepting new connections
2. Waits for in-flight requests to complete (up to `SHUTDOWN_TIMEOUT_MS`)
3. Closes database pool
4. Exits cleanly

### Security Headers

Helmet.js applies security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.

### Rate Limiting

Three tiers via `express-rate-limit`:
- **API**: 20000 req / 15min (general endpoints)
- **Auth**: 3000 req / 15min (login, token refresh)
- **AI**: 6000 req / 1hr (LLM analysis endpoints)

All configurable via environment variables.

---

## AI File Processing Pipeline

Uploaded files (PDF, DOCX, PPTX, XLSX, images) are automatically converted to AI-readable markdown shadow files (`__AI__filename.md`) via a background processing queue.

### How It Works

1. **Upload** — file goes to SharePoint via Graph API
2. **Enqueue** — a job is created in the `ai_processing_job` table (status: `queued`)
3. **Split** — the server downloads the file, splits into sub-artifacts (PDF pages, DOCX/PPTX embedded images)
4. **Process** — each sub-artifact is sent to Claude or Gemini vision API (up to 10 concurrently)
5. **Merge** — sub-job results are assembled into a single markdown file
6. **Upload shadow** — the `__AI__filename.md` is uploaded to the same SharePoint folder as the source

### Supported Formats

| Format | Processing | Vision API |
|--------|-----------|------------|
| PDF | Split into pages via pdf-lib, each page → vision | Yes (per page) |
| DOCX | Text via mammoth + embedded images extracted | Yes (per image) |
| PPTX | Slide XML parsed via JSZip + embedded images | Yes (per image) |
| XLSX/CSV | Table extraction via ExcelJS | No |
| Images | Direct vision analysis | Yes |

Legacy `.doc` and `.ppt` are not supported — print to PDF first.

### State Machine

```
queued → processing → merging → completed
                   ↘ failed (retries up to 3×)
                   ↘ skipped (cTag unchanged)
```

Sub-jobs: `pending → processing → completed | failed`

### Key Endpoints

- `GET /sharepoint/ai-queue` — queue summary
- `GET /sharepoint/ai-queue/jobs?folderId=` — detailed jobs with sub-jobs
- `POST /sharepoint/ai-queue/jobs/:jobId/retry` — retry a failed job
- `POST /sharepoint/files/:itemId/process` — manually trigger processing
- `GET /sharepoint/folders/:folderId/ai-status` — staleness check

### Architecture: Single-Instance Design

The processing pipeline currently uses **in-process memory** to hold extracted sub-artifact buffers (PDF page buffers, extracted DOCX/PPTX images) between the split and vision API phases. The job queue itself is PostgreSQL-backed with `FOR UPDATE SKIP LOCKED`, which supports multiple server instances. However, the buffer handoff is per-process.

**Current deployment:** Single instance (Render). This works correctly — all sub-artifacts are split and processed on the same server.

**If a server restarts mid-processing:** In-memory buffers are lost. The recovery logic detects stuck jobs on startup, resets them to `queued`, and re-downloads/re-splits from SharePoint.

---

## Future Scope

### Multi-Instance Processing (Horizontal Scaling)

To run multiple server instances behind a load balancer, the in-memory buffer map needs to be replaced with shared storage. Three options evaluated:

| Option | Storage | Tradeoff |
|--------|---------|----------|
| **A. Database BYTEA column** | Add `input_data BYTEA` to `ai_processing_sub_job` | Simplest. DB temporarily holds extracted page/image buffers (~1-50MB each). Cleared after processing. Adds DB I/O but no new infrastructure. |
| **B. SharePoint temp folder** | Upload extracted artifacts to `__processing__/` folder, delete after merge | No DB bloat. Extra Graph API round-trips. Cleanup logic needed. |
| **C. Redis/S3** | Store buffers in Redis (TTL) or S3 (lifecycle policy) | Most scalable. Requires new infrastructure. |

**Recommendation:** Option A for simplicity when scaling to 2-4 instances. Option C for large-scale deployments.

### Additional Scaling Considerations

- **Rate limiter store:** Currently `express-rate-limit` MemoryStore (per-process). Replace with `rate-limit-redis` for shared counters across instances.
- **Queue polling:** Currently `setInterval(5s)` per process. With N instances, that's N×5s DB polls. Consider `pg_notify` or a distributed lock (Redlock) for event-driven draining.
- **Vision API rate limits:** Claude and Gemini have per-key rate limits. With 10 concurrent sub-jobs × N instances, you may need to coordinate via a shared semaphore or reduce per-instance concurrency.
