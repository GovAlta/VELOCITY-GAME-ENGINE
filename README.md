# Velo — AI Project Velocity Tracker

Velo (short for Velocity) is a full-stack platform for tracking software projects and measuring delivery velocity. It treats delivery as a game: a chess-clock, eight-step board moves work from intake to deployment, with human and AI players taking turns, complexity-weighted scoring, a leaderboard, and time-boxed challenges. Every operation is exposed over an API with an OpenAPI specification, so AI agents are first-class participants alongside the Vue 3 web client.

This README doubles as the architecture and feature specification: use the table of contents below for the system design, database schema, API, security model, and instructions for running it locally.

> Part of [The Velocity White Papers](https://thevelocitywhitepapers.com), an open collection on building software in the AI era. The delivery-measurement approach behind this tool is described in [The AI Factory: Measuring Project Delivery](https://thevelocitywhitepapers.com/paper/k3tc3).

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Database Schema](#3-database-schema)
4. [API Design](#4-api-design)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Frontend Views & Features](#6-frontend-views--features)
7. [Project Management Core](#7-project-management-core)
8. [Velocity Engine](#8-velocity-engine)
9. [Project Audits & Deep Audit](#9-project-audits--deep-audit)
10. [SharePoint Integration](#10-sharepoint-integration)
11. [GitHub Integration](#11-github-integration)
12. [AI Processing Pipeline](#12-ai-processing-pipeline)
13. [Leaderboard & Challenges](#13-leaderboard--challenges)
14. [Project Collaboration (Membership, Cloning, Lock)](#14-project-collaboration)
15. [Agent Concurrency (Revisions & Idempotency)](#15-agent-concurrency)
16. [Visualization Engine](#16-visualization-engine)
17. [Risk Assessment](#17-risk-assessment)
18. [Immutable Audit Log](#18-immutable-audit-log)
19. [AI Chat (Multi-Provider)](#19-ai-chat-multi-provider)
20. [Notifications](#20-notifications)
21. [Security](#21-security)
22. [Infrastructure & Operations](#22-infrastructure--operations)
23. [Functional Requirements](#23-functional-requirements)
24. [Non-Functional Requirements](#24-non-functional-requirements)
25. [Running the Application](#25-running-the-application)

---

## 1. Executive Summary

Velo is a full-stack project management and delivery intelligence platform that tracks technology projects, applications, and contracts across an organization. It exposes every operation via API so both human users (via the Vue 3 frontend) and AI agents (via API keys + OpenAPI spec) can create, read, update, and audit project artifacts.

Velo extends a base portal scaffold with project-domain features:

- **Project tracking:** Gantt charts, risk heatmaps, dependency canvas, team management, multi-fiscal-year budgets, fuzzy-match duplicate detection, immutable audit trail
- **CMDB & Contracts:** Application registry, contract/vendor management with expiry tracking, project↔application/contract linking
- **Velocity Engine:** Chess-clock 8-step state machine for human-AI collaboration with scoring, alignment tracking, raise-hand, send-back, step locks, and complexity-weighted points
- **Deep Audits:** Multi-phase LLM-driven audits of GitHub repositories and SharePoint document libraries
- **AI Processing Pipeline:** Background queue that converts PDFs, images, DOCX, PPTX, and XLSX into AI-ready Markdown shadow files using vision providers (Claude, Gemini)
- **Gamification:** Leaderboard built on a per-user point ledger, plus mini-project Challenges with claim/complete/unclaim flows and speed bonuses
- **Multi-Provider AI Chat:** WebSocket streaming chat across OpenAI, Claude, Gemini, and Grok

The application is self-referential by design: it tracks AI-built projects and exposes APIs so those AI agents can push status updates and velocity moves back into Velo.

---

## 2. System Architecture

### 2.1 Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend Framework** | Vue 3 + TypeScript | ^3.5 |
| **Build Tool** | Vite | ^7 |
| **UI Framework** | PrimeVue (Aura theme) | ^4.x |
| **CSS** | Tailwind CSS | ^4.x |
| **State Management** | Pinia | ^3 |
| **Charts** | Chart.js + vue-chartjs | ^4 / ^5 |
| **Graph Visualization** | @vue-flow/core | ^1.x |
| **Maps** | Leaflet + @vue-leaflet/vue-leaflet | ^1.x / ^0.x |
| **Forms** | FormKit | ^1.x |
| **HTTP Client** | Axios | ^1.x |
| **XSS Protection** | DOMPurify | ^3.x |
| **Backend** | Express.js + TypeScript | ^4.x |
| **Database** | PostgreSQL (pg, pgcrypto) | ^8.x |
| **Authentication** | Passport.js (Google OAuth 2.0, Microsoft OIDC) | ^0.7 |
| **JWT** | jsonwebtoken (RS256) | ^9 |
| **WebSocket** | Socket.io | ^4 |
| **SSE** | Native Express + Node streams | — |
| **Validation** | Zod (server), AJV (form schemas) | ^3 / ^8 |
| **Logging** | Winston | ^3 |
| **Security** | Helmet, CORS, express-rate-limit, double-submit CSRF | various |
| **File Upload** | Multer (memory + disk-streaming) | ^2 |
| **PDF Processing** | pdf-lib | latest |
| **DOCX Processing** | Mammoth + Sharp (image fallback) | latest |
| **XLSX/PPTX** | ExcelJS, pizzip + xml2js | latest |
| **ZIP** | yauzl, archiver | latest |
| **GitHub** | Octokit + raw fetch | latest |
| **Microsoft Graph** | @azure/identity + @microsoft/microsoft-graph-client | latest |
| **Encryption** | AES-256-GCM (Node `crypto`) | builtin |
| **Compression** | compression (gzip/brotli, excludes SSE) | ^1 |
| **API Spec** | OpenAPI 3.0.3 | — |

### 2.2 Project Structure

```
velo/app/
├── package.json                         # Root: install:all, dev:all, build, db:migrate
├── eslint.security-scan.config.mjs      # ESLint security rules
├── docs/                                # Internal architecture docs (e.g. AI-PROCESSING.md)
├── client/                              # Vue 3 + PrimeVue frontend
│   ├── public/                          # Static assets, PWA icons
│   ├── tests/
│   │   ├── security/                    # XSS, CSRF, RBAC, session tests
│   │   └── unit/                        # Component + composable tests
│   ├── src/
│   │   ├── assets/                      # Images, fonts
│   │   ├── components/                  # ErrorBoundary, MapView, layout, projects, pwa
│   │   ├── composables/                 # useFetch, useTheme, useNotifications, usePwa
│   │   ├── data/                        # Static fallback (projects.json)
│   │   ├── lib/                         # api.ts (Axios), sanitize.ts (DOMPurify), chartUtils.ts
│   │   ├── router/                      # Vue Router (~20 routes)
│   │   ├── stores/                      # auth.ts, projects.ts (Pinia)
│   │   └── views/                       # Route view components
│   ├── vite.config.ts
│   └── tsconfig.json
└── server/                              # Express + TypeScript backend
    ├── migrations/                      # 60 idempotent SQL migrations
    ├── seeds/                           # Seed data
    ├── keys/                            # RSA key pairs (gitignored)
    ├── openapi.yaml                     # Full OpenAPI 3.0 spec (v3.0.0)
    ├── .env.example                     # All environment variables
    └── src/
        ├── config/                      # database.ts, environment.ts (Zod), auth.ts (Passport)
        ├── controllers/                 # ~21 controllers
        ├── models/                      # Parameterized SQL models (one per table)
        ├── services/                    # Business logic + AI providers
        │   └── ai-providers/            # openai, claude, gemini, grok + factory
        ├── routes/                      # ~27 route files
        ├── validators/                  # Zod validator files
        ├── middleware/                  # auth, api-key-auth, csrf, rate-limit, validate, error-handler, correlation-id, authorize
        ├── utils/                       # logger, tokens, errors, audit, encryption, Graph helpers
        ├── types/                       # TypeScript definition files
        ├── websocket/                   # ai-chat.handler.ts, index.ts
        ├── sse/                         # notification-stream, velocity-stream, deep-audit-stream, sharepoint-audit-stream
        ├── scripts/                     # generate-keys, generate-secrets, migrate, rollback, seed, set-role
        ├── __tests__/                   # Jest/Vitest server tests (incl. e2e)
        ├── app.ts                       # Express app configuration
        └── server.ts                    # HTTP + WebSocket server entry
```

### 2.3 Data Flow

1. **Initial seed:** Project, application, contract, and ministry data is seeded into PostgreSQL via the `npm run db:seed` script. Re-runs are idempotent.
2. **Runtime:** Frontend fetches from API (`/api/v1/*`) via Axios with automatic CSRF token injection; falls back to static `projects.json` if the API is unreachable.
3. **Dual-mode access:** Browser users authenticate via Google/Microsoft SSO (cookie + CSRF); AI agents authenticate via API keys (`X-API-Key` or `Authorization: Bearer`).
4. **Real-time:** WebSocket (Socket.io) for AI chat streaming; SSE for notification delivery, velocity board updates, deep-audit progress, and SharePoint audit progress.
5. **Audit trail:** Every mutation is logged to an immutable `audit_log` table with auth-source attribution (`session` vs `api_key` plus the API key ID).

### 2.4 Middleware Stack (Order)

1. Trust proxy (reverse-proxy support)
2. Helmet (CSP, HSTS, Permissions-Policy)
3. Compression (gzip/brotli; excluded for SSE)
4. Static file serving (when `SERVE_CLIENT=true`)
5. CORS (multiple origins supported)
6. Global API rate limiter (200 req / 15 min)
7. Content-Type validation (415 on unexpected types)
8. Body parsing (JSON 1 MB, URL-encoded 1 MB)
9. Cookie parser
10. Correlation ID middleware (UUID v4 per request)
11. Request logging (Winston, warn on >1 s)
12. Passport JWT initialization
13. Route handlers
14. SPA fallback (non-API GET → `index.html`)
15. Global error handler

---

## 3. Database Schema

### 3.1 Migrations (68 Total — through `068_redemption`)

Migrations are numbered, idempotent, and applied in order via `npm run db:migrate`. Grouped by domain:

#### Platform foundation (001–018)

| # | Migration | Purpose |
|---|-----------|---------|
| 001 | extensions_and_functions | `uuid-ossp`, `pgcrypto`, `pg_trgm`, `set_updated_at()` trigger |
| 002 | user_account | Users with SSO provider IDs and primary role |
| 003 | refresh_token | JWT refresh-token hashes with expiry/revocation |
| 004 | audit_log | Immutable mutation log |
| 005 | resource_item | Content resources (articles, guides) |
| 006 | resource_update | Version history for resources |
| 007 | service_category | Service catalog categories |
| 008 | service_catalogue | Service catalog entries |
| 009 | service_location | Physical service locations |
| 010 | form_definition | Dynamic JSON Schema form definitions |
| 011 | form_submission | User form submissions with status workflow |
| 012 | file_attachment | Uploaded file metadata |
| 013 | notification_subscription | User notification preferences |
| 014 | notification_message | Notification content |
| 015 | notification_delivery | Per-user delivery tracking |
| 016 | ai_conversation | AI chat conversation records |
| 017 | ai_message | Individual AI chat messages |
| 018 | rename_audit_columns | Column rename cleanup |

#### Project domain (019–033)

| # | Migration | Purpose |
|---|-----------|---------|
| 019 | ministry | Ministry/department codes |
| 020 | project | Main project table with all metadata |
| 021 | project_lead | Team-member assignments (many-to-many) |
| 022 | project_budget | Multi-fiscal-year budget lines |
| 023 | project_link | External resource links per project |
| 024 | module | Milestones/deliverables within projects |
| 025 | module_link | External resource links per module |
| 026 | project_update | Time-stamped status updates |
| 027 | api_key | User-level API keys (SHA-256 hashed) |
| 028 | project_duplicate | Fuzzy-match duplicate pairs |
| 029 | person | Unique individuals pool |
| 030 | person_github | GitHub handle + email fields on `person` |
| 031 | project_code | Legacy project codes (PRJ-xxxx) |
| 032 | project_dependency_and_positions | Project↔project links + canvas x/y coordinates |
| 033 | performance_indexes | 11 targeted indexes for query optimization |

#### CMDB & Contracts (034–038)

| # | Migration | Purpose |
|---|-----------|---------|
| 034 | application | CMDB application inventory |
| 035 | contract | Contracts and contingent labour |
| 036 | project_application_contract | Junction tables linking projects/modules to apps and contracts |
| 037 | mission_critical | Boolean flag on projects and modules |
| 038 | contract_relationship_types | Contract-specific relationship type constraints |

#### Velocity Engine (039–046, 049–051)

| # | Migration | Purpose |
|---|-----------|---------|
| 039 | velocity_step | Reference table — 8 workflow steps (`requirements`→`deployment`) |
| 040 | module_velocity | State-machine row per `(module, step)`; auto-init trigger on module insert |
| 041 | velocity_turn | Chess-clock turn history (actor, action, content, attachments) |
| 042 | velocity_metrics | Per-module metrics: turns, time, loopback, current step |
| 043 | velocity_turn_send_back | Adds `send_back` action |
| 044 | velocity_step_lock | `is_locked` boolean — protects work from being reset |
| 045 | velocity_scoring | `velocity_score`, `velocity_bonus`, `velocity_penalty` columns |
| 046 | velocity_governance | `requires_human_approval`, `requires_ai_recommendation`, `step_weight`, blocked-escalation, alignment tracking, outcome score |
| 049 | module_complexity | `module_complexity` SMALLINT 1–3 |
| 050 | module_complexity_float | Re-types `module_complexity` to NUMERIC(4,2) range 0–10 |
| 051 | raise_hand_status | Adds `hand_raised` status + `raise_hand`/`lower_hand` turn actions |

#### Deep Audit & GitHub (047, 048, 056, 058)

| # | Migration | Purpose |
|---|-----------|---------|
| 047 | user_pat_and_audit | Encrypted GitHub PAT (`user_github_pat_encrypted`, `user_github_pat_iv`) + universal `project_audit` table |
| 048 | deep_audit_source | Adds `deep-audit` to allowed `audit_source` values |
| 056 | github_domain | `user_github_domain` (default `github.com`) |
| 058 | github_org | `user_github_org` — auto-injected into repo creation |

#### SharePoint & AI Processing (052, 059)

| # | Migration | Purpose |
|---|-----------|---------|
| 052 | sharepoint_folders | `sharepoint_folder` (project/module/step/audit folder mapping) + adds `sharepoint`/`sharepoint-content` to `audit_source` |
| 059 | ai_processing_jobs | `ai_processing_job` (parent: queued → processing → merging → completed/failed/skipped) and `ai_processing_sub_job` (PDF page, DOCX/PPTX image, XLSX sheet) |

#### Roles & Users (053–055)

| # | Migration | Purpose |
|---|-----------|---------|
| 053 | user_roles | `user_role` junction table for multi-role; migrates existing roles |
| 054 | preregister_users | Allows pre-registering users before first SSO login (nullable `sso_provider_*`) |
| 055 | unique_indexes_exclude_deleted | Replaces email/Google/Microsoft unique constraints with partial indexes that exclude soft-deleted rows |

#### Gamification (057)

| # | Migration | Purpose |
|---|-----------|---------|
| 057 | challenges_and_leaderboard | Adds `is_challenge`/`challenge_*` fields to `project`, creates `user_points` ledger and `leaderboard` materialized view |

#### Collaboration & Concurrency (060–062, v5.0)

| # | Migration | Purpose |
|---|-----------|---------|
| 060 | collaboration | Lineage cols on `project` (`fk_project_parent`, `project_cloned_from_name`, `project_version_label`, `project_cloned_at`, `project_cloned_by`); lock cols (`project_is_locked`, `project_locked_by`, `project_locked_at`, `project_lock_reason`) with consistency CHECK; clone-policy cols (`project_clone_disabled`, `project_clone_disabled_by`/`_at`/`_reason`) with CHECK; new `project_member` table (junction with `member_role` ∈ {owner, collaborator}, soft-deactivation, last-owner protection) |
| 061 | revisions_and_idempotency | `project.project_revision` + `module_velocity.step_revision` counters; `velocity_idempotency` table for keyed retry caching with 24-hour TTL |
| 062 | revision_triggers | BEFORE-UPDATE triggers `bump_project_revision` and `bump_step_revision` that auto-increment counters on every UPDATE — service code never has to remember |

#### Challenges (063, v5.1)

| # | Migration | Purpose |
|---|-----------|---------|
| 063 | challenge_acceptance | Adds challenge management metadata to `project`: `challenge_max_acceptances` (NULL = unlimited; integer = first-come, first-served cap), `challenge_closed_at`, `challenge_winner_project` (FK), `challenge_winner_narrative`, `challenge_winner_picked_at`/`_by`. CHECK constraint `chk_challenge_max_acceptances_positive` ensures cap is ≥ 1 when set. |

### 3.2 Core Tables — Platform Foundation

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `user_account` | Authenticated users | `user_email_address`, `user_display_name`, `google_id`, `microsoft_id`, `user_role_name` (legacy primary), `avatar_url`, `is_active`, `is_deleted`, `user_github_pat_encrypted`/`_iv`, `user_github_domain`, `user_github_org` |
| `user_role` | Multi-role junction | `fk_ur_user`, `role_name` ∈ {`user`, `project_lead`, `runner`, `admin`}, `granted_by`, `granted_at` |
| `refresh_token` | JWT refresh tokens | `token_hash`, `fk_user`, `expires_at`, `is_revoked` |
| `audit_log` | Immutable mutation log | `audit_action`, `audit_table_name`, `audit_record_id`, `audit_old_data` (JSONB), `audit_new_data` (JSONB), `fk_audit_user` |
| `resource_item` | Content articles | `resource_title`, `resource_summary`, `resource_content`, `resource_status`, `resource_category`, `resource_region`, `resource_tags` |
| `service_category` / `service_catalogue` / `service_location` | Service catalog | as documented in migrations 007–009 |
| `form_definition` / `form_submission` / `file_attachment` | Dynamic forms | JSON Schema definitions, AJV-validated submissions, file attachments |
| `notification_subscription` / `notification_message` / `notification_delivery` | Notifications | Subscription types: `resource`, `region`, `broadcast` |
| `ai_conversation` / `ai_message` | AI chat history | Per-user conversation persistence with token counting |

### 3.3 Core Tables — Project Domain

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `ministry` | Ministry/department reference codes | `ministry_code`, `ministry_name`, `ministry_abbreviation` |
| `project` | All tracked projects | name, description, status, code, ministry FK, start/end dates, % complete, priority, scope, category, demand number, branch, risk, go-live date type, ministry priority, canvas x/y, mission-critical flag, **challenge fields** (see below), `is_deleted` |
| `module` | Milestones within projects | name, description, status, % complete, dates, sort order, plan, progress, blockers, canvas x/y, project FK, `module_complexity` NUMERIC(0–10), `is_deleted` |
| `project_budget` | Multi-FY budget lines | fiscal year, funding source, money type, amount, spent, notes |
| `project_link` / `module_link` | External resource links | type, URL, label, description |
| `project_lead` | Team assignments | project FK, person FK, role, primary flag, FTE flag, organization |
| `person` | Pool of unique individuals | display name, email, GitHub handle, FTE flag, organization, notes |
| `project_update` | Status-update log | type, title, content, JSON content, source, project FK, optional module FK, user FK |
| `project_duplicate` | Fuzzy-match pairs | similarity score, exact-match flag, ordered project IDs |
| `project_dependency` | Project↔project links | from/to FKs, dependency type, label, notes |
| `api_key` | User-level API keys | name, SHA-256 hash, prefix, user FK, expires_at, last_used_at, revoked flag |
| `application` | CMDB inventory | applicationId, name, description, owner, status, environment, URL, notes |
| `contract` | Contracts/contingent labour | contract number, vendor, dates, value, status, notes |
| `project_application` / `project_contract` | Project↔resource junctions | project FK, resource FK, optional module FK, relationship type, notes |

### 3.4 Core Tables — Velocity Engine

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `velocity_step` | Reference table | `step_name` PK, `step_label`, `step_order` (1–8) |
| `module_velocity` | Per-step state machine | `fk_mv_module`, `step_name`, `step_order`, `status`, `current_actor`, `loop_count`, `turn_count`, `is_locked`, `requires_human_approval`, `requires_ai_recommendation`, `step_weight` (1–3), `blocked_reason`, `blocked_since`, `started_at`, `completed_at` |
| `velocity_turn` | Chess-clock history | actor, action, from/to status, content, JSON content, attachments, user FK, API key FK, alignment flag |
| `module_velocity_metrics` | Per-module roll-up | `loopback_count`, `total_turns`, `ai_time_seconds`, `human_time_seconds`, `current_step_name`/`_started_at`, `velocity_score`, `velocity_bonus`, `velocity_penalty`, `alignment_count`, `misalignment_count`, `outcome_score` (1–5) |

### 3.5 Core Tables — Audits, SharePoint, AI Processing

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `project_audit` | Universal audit results | source ∈ {git, jira, confluence, sharepoint, sharepoint-content, web, manual, ai_analysis, deep-audit}, source URL/ref, title, summary, status, JSONB payload, AI provider/model/analysis/score (0–100), creator, soft-delete |
| `sharepoint_folder` | SP folder mapping | site/drive/folder IDs, folder path, web URL, type ∈ {project, module, step, audit}, sync_status, last_synced_at; FK to project (req), module (opt), velocity step (opt) |
| `ai_processing_job` | Parent: one per source file | SP folder/item IDs, filename, file_type, status, vision provider/model, retry count, error message, shadow item ID/URL, source cTag, sub-job counters, timestamps |
| `ai_processing_sub_job` | Vision API call | parent FK, sub_type ∈ {pdf_page, docx_text/image, pptx_text/image, image, xlsx}, sequence number, status, retry count, result_markdown, input MIME/size, vision provider/model |

### 3.6 Core Tables — Gamification

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `project` (challenge fields) | Mini-projects with bonus points | **Definition:** `project_is_challenge`, `challenge_points`, `challenge_max_days`, `challenge_difficulty` ∈ {easy, medium, hard, expert}. **Multi-acceptance (v5.1):** `challenge_max_acceptances` (NULL = unlimited; integer = first-come, first-served cap). **Lifecycle:** `challenge_closed_at`, `challenge_winner_project` (FK), `challenge_winner_narrative`, `challenge_winner_picked_at` / `_by`. **Legacy single-claimer:** `challenge_claimed_by`, `challenge_claimed_at`, `challenge_completed_at` (still populated but the v5.1 cloning flow uses the parent + clone relationship instead). |
| `user_points` | Point ledger | user FK, points (signed), source ∈ {velocity_step, velocity_bonus, velocity_penalty, challenge_complete, challenge_bonus, manual}, description, optional project/module FK and step name, timestamp |
| `leaderboard` (materialized view) | Aggregated rankings | `total_points`, `velocity_points`, `challenge_points`, `bonus_points`, `penalty_points`, `modules_completed`, `challenges_completed`, `projects_touched`; refreshed via `refresh_leaderboard()` SQL function |

### 3.6.1 Core Tables — Collaboration & Concurrency (v5.0)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `project` (lineage cols) | Single-level clone parent + provenance | `fk_project_parent` (FK, ON DELETE SET NULL), `project_cloned_from_name` (snapshot survives parent deletion), `project_version_label`, `project_cloned_at`, `project_cloned_by` |
| `project` (lock cols) | Owner-acquired exclusive lock | `project_is_locked`, `project_locked_by`, `project_locked_at`, `project_lock_reason`; CHECK invariant — when locked, `_by` and `_at` MUST be set |
| `project` (clone-policy cols) | Admin-controlled clone gate | `project_clone_disabled`, `project_clone_disabled_by`, `project_clone_disabled_at`, `project_clone_disabled_reason`; CHECK invariant matching above |
| `project.project_revision` | Optimistic-concurrency counter | INT, NOT NULL, DEFAULT 1; auto-bumps via `bump_project_revision` BEFORE-UPDATE trigger |
| `project_member` | Multi-user membership junction | `fk_pm_project`, `fk_pm_user`, `member_role` ∈ {owner, collaborator}, `added_by`, `added_at`, `removed_at`, `removed_by`, `is_active`; unique partial index on active rows; soft-deactivation preserves history |
| `module_velocity.step_revision` | Per-step concurrency counter | INT, NOT NULL, DEFAULT 0; auto-bumps via `bump_step_revision` trigger |
| `velocity_idempotency` | 24-hour idempotency cache | `idempotency_key` (UUID PK), `fk_user`/`fk_api_key` (nullable), `request_method`, `request_path`, `request_hash` (SHA-256 of method+path+body), `response_status`, `response_body` (JSONB), `expires_at` (default `NOW() + 24h`); cleanup cron in `server.ts` runs hourly |

### 3.7 Enumerations

| Field | Values |
|-------|--------|
| **User Role** (`user_role.role_name`) | `user`, `project_lead`, `runner`, `admin` |
| **Member Role** (`project_member.member_role`) | `owner`, `collaborator` |
| **Project Status** | `discovery`, `requirements`, `development`, `testing`, `client_review`, `client_acceptance`, `completion`, `on_hold`, `cancelled` |
| **Module Status** | `requirements_gathering`, `building`, `client_review`, `client_sign_off`, `delivered`, `closed`, `cancelled` |
| **Velocity Step** | `requirements`, `planning`, `architecture`, `prototyping`, `development`, `user_testing`, `user_acceptance`, `deployment` |
| **Velocity Step Status** | `not_started`, `ready_to_start`, `ai_working`, `human_working`, `ai_review`, `human_review`, `completed`, `blocked`, `hand_raised` |
| **Velocity Turn Action** | `start`, `pass`, `review`, `approve`, `reject`, `complete`, `block`, `unblock`, `note`, `send_back`, `transition`, `raise_hand`, `lower_hand` |
| **Audit Source** | `git`, `jira`, `confluence`, `sharepoint`, `sharepoint-content`, `web`, `manual`, `ai_analysis`, `deep-audit` |
| **Audit Status** | `pending`, `running`, `completed`, `failed`, `stale` |
| **AI Job Status** | `queued`, `processing`, `merging`, `completed`, `failed`, `skipped` |
| **AI Sub-Job Type** | `pdf_page`, `docx_text`, `docx_image`, `pptx_text`, `pptx_image`, `image`, `xlsx` |
| **Budget Funding Source** | `TI`, `Ministry`, `Mixed`, `Federal`, `Other` |
| **Budget Money Type** | `Salary`, `Operating`, `Capital` |
| **Link Type** | `github`, `confluence`, `jira`, `sharepoint`, `other` |
| **Update Type** | `progress`, `blocker`, `plan`, `risk`, `decision`, `milestone`, `ai_summary`, `audit_result` |
| **Update Source** | `manual`, `api`, `ai_audit`, `github_webhook`, `jira_sync`, `confluence_sync` |
| **Lead Role** | `lead`, `delivery_director`, `delivery_manager`, `developer`, `business_analyst`, `qa_tester`, `designer`, `project_manager`, `product_owner`, `architect`, `data_analyst`, `devops`, `scrum_master`, `stakeholder`, `sponsor`, `team_member`, `other` |
| **Dependency Type** | `finish_to_start`, `start_to_start`, `finish_to_finish`, `start_to_finish`, `other` |
| **Go-Live Date Type** | `legislative`, `mandated`, `announced`, `objective` |
| **Application Status** | `active`, `decommissioned`, `in_development`, `on_hold` |
| **Application Environment** | `production`, `staging`, `development`, `disaster_recovery` |
| **Contract Status** | `active`, `expired`, `terminated`, `pending` |
| **App Relationship Type** | `uses`, `manages`, `replaces`, `integrates_with` |
| **Contract Relationship Type** | `funded_by`, `delivered_under`, `staffing`, `licensing`, `maintenance`, `infrastructure`, `consulting`, `other` |
| **SP Folder Type** | `project`, `module`, `step`, `audit` |
| **SP Sync Status** | `active`, `orphaned`, `error` |
| **Challenge Difficulty** | `easy`, `medium`, `hard`, `expert` |
| **Point Source** | `velocity_step`, `velocity_bonus`, `velocity_penalty`, `challenge_complete`, `challenge_bonus`, `manual` |

### 3.8 Performance Indexes (Migration 033 + per-table)

Targeted indexes include partial-on-`is_deleted=false` indexes on `project`, composite indexes on `module(project, is_deleted)`, JSONB lookups on `audit_log` for `_projectId`, descending pagination indexes, `pg_trgm` for typeahead search, and all FK-side indexes for join performance. Velocity, SharePoint, AI processing, and leaderboard tables ship their own indexes with each migration.

---

## 4. API Design

The API is fully described by `server/openapi.yaml` (v3.0.0). The spec is the source of truth — this section summarizes it.

### 4.1 Base URL & Route Mounting

All routes are mounted at `/api/v1/` with a backward-compatible alias at `/api/`.

```
/api/v1/auth                   → authRoutes
/api/v1/projects               → projectRoutes (incl. modules, budgets, links, leads, updates, audit)
/api/v1/persons                → personRoutes
/api/v1/ministries             → ministryRoutes
/api/v1/canvas                 → canvasRoutes
/api/v1/applications           → applicationRoutes (project_lead/admin only)
/api/v1/contracts              → contractRoutes (project_lead/admin only)
/api/v1/api-keys               → apiKeyRoutes
/api/v1/ai                     → aiRoutes (chat conversations + WebSocket)
/api/v1/velocity               → velocityRoutes (game engine + SSE)
/api/v1/git                    → gitRoutes (GitHub integration)
/api/v1/sharepoint             → sharepointRoutes (Graph API + AI processing)
/api/v1/users                  → userManagementRoutes (admin only)
/api/v1/settings               → settingsRoutes (PAT, GitHub URL, etc.)
/api/v1/leaderboard            → leaderboardRoutes
/api/v1/challenges             → challengesRoutes
/api/v1/notifications          → notificationRoutes (incl. SSE stream)
/api/v1/subscriptions          → subscriptionRoutes
/api/v1/resources              → resourceRoutes
/api/v1/services               → serviceRoutes
/api/v1/forms                  → formRoutes
/api/v1/submissions            → submissionRoutes
/api/v1/files                  → fileRoutes
/api/v1/admin                  → adminRoutes (admin dashboard, content CRUD)
/api/v1/landing                → landingRoutes (public landing data)
/api/v1/health                 → healthRoutes (live, ready)
/api/v1/docs                   → serves openapi.yaml
```

### 4.2 Endpoint Groups (per OpenAPI tags)

| Tag | Representative Endpoints | Notes |
|-----|--------------------------|-------|
| **Auth** | `GET /auth/{google,microsoft}`, `GET /auth/csrf`, `GET /auth/me`, `POST /auth/refresh`, `POST /auth/logout` | SSO + CSRF + JWT refresh rotation |
| **Projects** | `GET/POST /projects`, `GET/PUT/DELETE /projects/{id}`, `POST /projects/{id}/merge` | Public list, write requires auth + (project_lead/admin or runner for limited ops) |
| **Modules** | `/projects/{id}/modules[/{moduleId}]`, `/projects/{id}/modules/{moduleId}/links[/{linkId}]` | Module CRUD + module-scoped links |
| **Budgets / Project Links / Updates / Team** | `/projects/{id}/budgets…`, `/projects/{id}/links…`, `/projects/{id}/updates…`, `/projects/{id}/leads…` | Sub-resource CRUD scoped to parent project |
| **Audit** | `GET /projects/{id}/audit` | Paginated immutable mutation log |
| **Ministries** | `GET /ministries`, `GET /ministries/{code}` | 29 ministry codes with project counts |
| **People** | `GET/POST /persons`, `GET /persons/search`, `GET/PUT/DELETE /persons/{id}`, `POST /persons/{id}/merge` | Typeahead search via `pg_trgm`; cascading rename on update |
| **Canvas** | `GET /canvas`, `POST /canvas/positions`, `POST /canvas/reset`, `GET/POST /canvas/dependencies`, `DELETE /canvas/dependencies/{id}` | Drag-position persistence + dependency CRUD |
| **API Keys** | `GET/POST /api-keys`, `DELETE /api-keys/{id}` | SHA-256 hashed; full key returned ONCE on create |
| **Applications** | `GET/POST /applications`, `GET/PUT/DELETE /applications/{id}` | Restricted to project_lead/admin |
| **Contracts** | `GET/POST /contracts`, `GET/PUT/DELETE /contracts/{id}` | Restricted to project_lead/admin; expiring-before/after filters |
| **Project Applications / Contracts** | `/projects/{id}/applications[/{linkId}]`, `/projects/{id}/contracts[/{linkId}]` | Many-to-many junctions with relationship type |
| **Velocity** | See [§ 8](#8-velocity-engine) for the full set — board, moves, turns, send-back, locks, SSE stream, gameplay guide |
| **Audits / Deep Audit** | `/projects/{id}/audits[/{auditId}]`, `/export/{json,md,docx}`, `/analyze`, `/deep-audit`, `/deep-audit/{auditId}/{stream,status}` | Multi-source audits + LLM analysis + 5-phase deep audit |
| **Git** | `/git/{repos,extract,…}` — see [§ 11](#11-github-integration) | PAT-injected GitHub operations |
| **SharePoint** | `/sharepoint/{status,projects,folders,items,files,modules,ai-queue,…}` — see [§ 10](#10-sharepoint-integration) | Graph API integration |
| **User Management** | `GET/POST /users`, `GET /users/{userId}`, `POST /users/{userId}/roles`, `DELETE /users/{userId}/roles/{role}`, `PATCH /users/{userId}/active` | Admin only; pre-register and multi-role |
| **Settings** | `PUT/DELETE /settings/pat`, `PUT /settings/github-domain`, `GET /settings/pat/status` | Per-user PAT (encrypted) and GitHub URL |
| **Leaderboard** | `GET /leaderboard[/me]`, `GET /leaderboard/user/{userId}/history`, `GET /leaderboard/{project,module}/{id}/contributors`, `POST /leaderboard/refresh` | Period filter (month/year/all); refresh materialized view |
| **Challenges** | `GET /challenges`, `POST /challenges/{projectId}/{claim,complete,unclaim}` | runner+ role for state transitions |
| **AI Chat** | WebSocket `/ai`, REST `/ai/conversations[/{id}]` | Streaming chat across 4 providers |
| **Notifications** | `GET /notifications[/unread-count]`, `PUT /{id}/read`, `GET /notifications/stream` (SSE), `POST /notifications/broadcast` | SSE stream + admin broadcast |
| **Subscriptions** | `GET/POST /subscriptions`, `DELETE /subscriptions/{id}` | Resource/region/broadcast |
| **Resources / Services / Forms / Submissions / Files** | Portal CRUD endpoints | Backed by foundation tables |
| **Admin** | `GET /admin/dashboard/stats`, content CRUD, `PUT /admin/submissions/{id}/status` | Admin dashboard support |
| **Health** | `GET /health[/live,/ready]` | Liveness + DB-readiness |

### 4.3 Response Format

**Success:**
```json
{ "success": true, "data": { } }
```

**Paginated:**
```json
{
  "success": true,
  "data": [ ],
  "pagination": { "page": 1, "limit": 20, "total": 120, "totalPages": 6 }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [{ "field": "name", "message": "Required" }],
    "url": "/api/v1/projects",
    "method": "POST",
    "timestamp": "2026-05-06T03:54:07.351Z"
  }
}
```

**Error codes:** `VALIDATION_ERROR` (422), `UNAUTHORIZED` (401), `TOKEN_EXPIRED` (401, triggers refresh), `FORBIDDEN` (403), `CSRF_MISSING`/`CSRF_MISMATCH` (403), `NOT_FOUND` (404), `UNIQUE_VIOLATION` (409), `RATE_LIMIT_EXCEEDED` (429), `CONNECTION_ERROR`/`DATABASE_UNAVAILABLE` (503), `FOREIGN_KEY_VIOLATION`/`NOT_NULL_VIOLATION` (400), `CHECK_VIOLATION` (422).

**Domain-specific error codes:**

| Code | Status | Source |
|------|--------|--------|
| `NOT_A_MEMBER` | 403 | Project is claimed; you're not a member (v5.0 Collaboration) |
| `OWNER_REQUIRED` | 403 | Action requires the `owner` member role (v5.0 Collaboration) |
| `LAST_OWNER` | 409 | Can't demote/remove the last owner while collaborators remain |
| `PROJECT_LOCKED` | 423 | Project is locked by another user |
| `ALREADY_LOCKED` | 409 | Lock-acquire when held by someone else |
| `LOCK_OWNED_BY_OTHER` | 403 | Unlock attempt on a lock you don't own (admin can `force=true`) |
| `LOCK_RACE` | 409 | Lock-acquire raced with another writer; retry |
| `CLONE_DISABLED` | 403 | Admin disabled cloning of this project |
| `CLONE_OF_CLONE` | 422 | Source already has a parent (no clones-of-clones) |
| `PRECONDITION_FAILED` | 412 | Stale `If-Match` revision (v5.0 Concurrency) |
| `IDEMPOTENCY_KEY_INVALID` | 400 | `Idempotency-Key` is not a UUID |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key used with a different request body |
| `CHALLENGE_FULL` | 409 | `challenge_max_acceptances` reached (v5.1) |
| `CHALLENGE_CLOSED` | 403 | Creator closed the challenge |
| `CHALLENGE_COMPLETED` | 403 | A winner has already been picked |
| `WINNER_ALREADY_PICKED` | 409 | Calling pick-winner twice |
| `NOT_CHALLENGE_CREATOR` | 403 | Only creator/admin can close or pick winner |
| `SSO_NOT_CONFIGURED` | 503 | OAuth provider env vars missing |
| `FILE_TOO_LARGE` | 413 | File upload exceeds the configured limit |
| `UNEXPECTED_FILE` | 400 | Multer received a file under an unexpected field name |
| `DUPLICATE_SUBSCRIPTION` | 409 | User already subscribed to this resource/region/broadcast |
| `META_SYNC_FAILED` | 500 | `/_meta/sync` introspection error (rare) |

### 4.4 Field Convention

- **Input (request bodies):** camelCase (`ministryCode`, `fiscalYear`, `fundingSource`)
- **Output (response bodies):** snake_case DB column names (`ministry_code`, `project_name`, `budget_amount`)
- **Controllers** map both directions via `mapBodyToDb()` and coerce empty strings to `null` for nullable DB columns

---

## 5. Authentication & Authorization

### 5.1 SSO Providers

| Provider | Protocol | Config Variables |
|----------|----------|------------------|
| **Google** | OAuth 2.0 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| **Microsoft** | OpenID Connect | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` |

### 5.2 Authentication Flow

1. **Login:** Client redirects to `/api/v1/auth/google` (or `/microsoft`)
2. **OAuth:** Passport handles provider redirect → callback
3. **User Resolution:** `findOrCreateUser()` checks by provider ID, then by email (cross-provider linking), creates a new record if none. **Pre-registered users** (created by an admin via `POST /users` before first sign-in) inherit their assigned roles automatically on first login.
4. **Token Issuance:** RS256 JWT access token (15 min default) + refresh token (7 d default); refresh hash stored in DB.
5. **Cookie Storage:** `access_token` + `refresh_token` set as `httpOnly`, `secure` (production), `sameSite=lax` cookies.
6. **Audit:** Logs `LOGIN` (or `LOGIN_FAILED`) event.
7. **Redirect:** Returns to frontend with success/error state.

### 5.3 Token Refresh

- 401 response with `code: TOKEN_EXPIRED` triggers the Axios interceptor.
- Concurrent requests are queued while `POST /auth/refresh` runs.
- Server verifies the refresh JWT, checks the hash against DB (not revoked, not expired).
- **Token rotation:** revokes the old refresh token, issues a new pair.
- Queued requests replay with the new access token.

### 5.4 API Key Authentication

- Generated via Settings; full key shown ONCE; SHA-256 hash stored.
- Sent via `X-API-Key: velo_xxx` or `Authorization: Bearer velo_xxx`.
- Middleware resolves key → user → roles, attaches full user context.
- CSRF is bypassed for API-key auth (no cookies involved).
- Updates `api_key_last_used_at` (fire-and-forget).
- All audit entries include `_authSource: 'api_key'` and `_apiKeyId`.
- **Role enforcement is identical** to browser sessions — an API key carries the owning user's roles.

### 5.5 Role-Based Access Control (4 Roles, Multi-Role)

The legacy 7-level hierarchy was replaced (migration 053). Users hold one or more of:

| Role | Granted Capabilities |
|------|---------------------|
| `user` | Read-only viewer — projects, dashboards, public data |
| `runner` | Can DO work — Velocity moves, SharePoint upload/download/AI process, Git operations, run audits, step artifacts |
| `project_lead` | Can SET UP work — create/edit/delete projects, modules, budgets, leads, links, Applications, Contracts, persons, canvas + everything `runner` can do |
| `admin` | System administration — user management (pre-register, role assignment, account enable/disable), settings, PAT management + everything `project_lead` can do |

**Public** (not logged in) is implicit and never stored. Admins implicitly hold all role capabilities. Multi-role: a user can be `{runner, project_lead}` simultaneously. Roles are managed via `/users/{userId}/roles` (admin only). The legacy `user_account.user_role_name` column is preserved for JWT backwards compatibility.

### 5.6 Idle Session Timeout

The frontend tracks user activity (`mousedown`, `keydown`, `touchstart`, `scroll`) and logs out after 30 minutes of inactivity, dispatching a `window.auth:expired` event.

---

## 6. Frontend Views & Features

### 6.1 Route Map

| Route | View Component | Layout | Description |
|-------|---------------|--------|-------------|
| `/` | DashboardView | default | Main dashboard with stats, charts, alerts |
| `/projects` | ProjectsCardView | default | Card/table grid with filters; create project |
| `/projects/:id` | ProjectDetailView | default | Full CRUD, sub-resources, app/contract links, risk, audits, audit log |
| `/gantt` | GanttView | default | Scrollable timeline visualization |
| `/canvas` | CanvasView | default | Vue Flow interactive dependency graph |
| `/heatmap` | HeatmapView | default | Ministry × month activity density |
| `/heatmap/:ministry` | HeatmapMinistryView | default | Per-ministry project risk drill-down |
| `/at-risk` | AtRiskView | default | Risk summary, 9-box grid, risk-sorted list |
| `/leads` | LeadsView | default | Lead analysis + people directory |
| `/velocity` | VelocityView | default | 8-step chess-clock board (multiplayer-synced) |
| `/duplicates` | DuplicatesView | default | Fuzzy-match pairs, merge, dismiss |
| `/applications` | ApplicationsView | default | CMDB application registry with searchable table, filters, CRUD |
| `/contracts` | ContractsView | default | Contracts with Gantt, table view, expiry tracking, CRUD |
| `/leaderboard` | LeaderboardView | default | Ranked points board (month/year/all-time) |
| `/challenges` | ChallengesView | default | Open/claimed/completed challenges with claim/complete actions |
| `/login` | LoginView | blank | Google/Microsoft SSO buttons |
| `/auth/callback` | AuthCallbackView | blank | OAuth redirect handler |
| `/settings` | SettingsView | default | API keys, GitHub PAT/URL, profile, docs link |
| `/admin/users` | AdminUsersView | default | Admin-only: pre-register users, manage roles, enable/disable accounts |
| `/:pathMatch(.*)*` | NotFoundPage | blank | 404 fallback |

### 6.2 Layout System

- **Default layout:** AppNavbar (sticky top) + main content + AppFooter
- **Blank layout:** Full-page (login, OAuth callback, 404)
- **AppNavbar:** Logo, primary links, dropdown menus (Insights / Resources / Game), mobile hamburger with grouped sections, user avatar/sign-out, ThemeSwitcher
- **Skip-to-main-content** accessibility link
- **Route announcer** for screen readers

### 6.3 Theming

Five themes — Light, Dark, Warm, Ocean, Forest — fully applied across every visualization. Each theme defines `series` (8 chart colors), `grid`, `tooltip`, `text`, `legend`, and `marker` colors. Charts, Gantt bars, heatmap cells, risk indicators, canvas nodes, velocity tiles, and leaderboard graphs all pull from `useTheme().chartColors`. Theme persists via localStorage. PrimeVue dark mode toggled via the HTML root class.

### 6.4 PWA Support

- **Install prompt:** `beforeinstallprompt` event → install button (`PwaInstallPrompt.vue`)
- **Service-worker updates:** Detects new versions, prompts user to refresh (`PwaUpdatePrompt.vue`)
- **Offline detection:** Tracks `offlineReady` state via `usePwa()`

---

## 7. Project Management Core

### 7.1 Dashboard (`/`)

- **Hero section** with Velo branding and live counts (projects, ministries)
- **Stats cards:** Total Projects, Ministries, Projects with Timeline, Avg Completion %
- **Phase Distribution:** Doughnut chart (Chart.js, theme-aware)
- **Ministry Distribution:** Horizontal bar chart — top 12 ministries by project count
- **Upcoming Go-Lives:** Projects with end date ≥ today, phase ≠ completion, sorted ascending
- **Past-Due Alerts:** Projects with end date < today, phase ≠ completion/cancelled

### 7.2 Projects List (`/projects`)

- **FilterBar:** Global search (name, description, ministry, lead, demand #), ministry multi-select, phase multi-select, source multi-select, mission-critical toggle, clear-all, result counter
- **View toggle:** Cards vs compact table
- **Sort:** Name, Go-Live Date, Ministry, Completion %
- **Pagination:** 24 items per page
- **Card view:** Phase indicator bar, ministry/phase badges, name, description, progress bar, meta row, duplicate badge, mission-critical glass-ball icon
- **Table view:** Sortable columns — Name, Ministry, Phase, %, Go-Live, Lead, Demand #
- **Create Project:** Dialog form (name, description, ministry dropdown, status, start/end dates) → `POST /projects` → redirect to detail

### 7.3 Project Detail (`/projects/:id`)

**Inline Editing (authenticated, role-gated):** toggle edit mode for all core fields.

**Core Fields:**
- Project Code (legacy `PRJ-xxxx`, editable)
- Name, Description, Additional Info
- Ministry (dropdown of 29 codes, alphabetically ordered)
- Status, Go-Live Date Type
- Start Date, End Date (max 9999-12-31 enforced)
- % Complete, Priority, Scope, Category
- Demand Number, Branch, Risk
- Mission Critical flag

**Risk Assessment Banner:** Prominent colored banner showing risk level, explanation, actual-vs-expected progress bar, days remaining, velocity needed. Levels: On Track (green), At Risk (yellow), Behind (orange), Critical (red), Past Due (red badge), Completed (green badge). See [§ 15](#15-risk-assessment).

**Sub-resource Panels:**

| Panel | CRUD | Fields |
|-------|------|--------|
| **Modules** | Full | Name, description, status, dates, % complete, plan, progress, blockers, **complexity (0–10)** |
| **Budgets** | Full | Fiscal year, funding source, money type, amount, spent, notes |
| **External Links** | Add/Delete | Type, URL, label, description (per project AND per module) |
| **Team** | Full | Person (typeahead from pool), role (17 values), primary flag, FTE/contractor, organization |
| **Updates** | Add/Delete | Type, title, content; speech-to-text dictation (`webkitSpeechRecognition`, `en-CA`, continuous mode, append) |
| **Applications (CMDB)** | Add/Remove | Link an application with relationship type and description |
| **Contracts** | Add/Remove | Link a contract with relationship type and description |
| **Project Audits** | Run/Export/Analyze | See [§ 9](#9-project-audits--deep-audit) |

**Audit Log Panel:** "Load History" → paginated, immutable mutation log (action, table, timestamp, user, JSON diff). Prev/next pagination, 30 per page.

**Actions:** Edit → Save (inline), soft-delete (confirmation), redirect on delete.

### 7.4 Duplicate Detection (`/duplicates`)

- Fuzzy-match pairs (Levenshtein ≥ 75 % similarity)
- Sorted by similarity descending
- Exact-match vs fuzzy-match badges
- **Directional merge:** Left-arrow (keep left) / Right-arrow (keep right). Merge transfers all sub-resources (leads, budgets, links, modules, updates, application/contract links, dependencies), soft-deletes the victim
- **"Not a duplicate"** dismiss removes the pair
- Confirmation dialog before merge

### 7.5 People & Leads (`/leads`)

Two view modes:

1. **By Project Lead:** Groups projects by lead name; expandable rows with project list; sort by count/name/avg completion; shows ministries, at-risk count, past-due count.
2. **People Directory:** Paginated table (30/page); search (debounced 300 ms); FTE/contractor filter; full CRUD (name, email, GitHub handle, organization, FTE flag, notes); delete with confirmation; **merge** (search → select survivor → confirm → transfers assignments, deletes victim).

---

## 8. Velocity Engine

The Velocity Engine is a chess-clock collaboration system between humans and AI agents. Each module passes through 8 well-defined steps; turns are recorded as moves, the board updates in real time over SSE, and points are awarded based on alignment, complexity, and outcomes.

### 8.1 The 8 Velocity Steps

| Order | Step | Default Governance |
|-------|------|--------------------|
| 1 | `requirements` | Requires human approval |
| 2 | `planning` | — |
| 3 | `architecture` | Requires AI recommendation |
| 4 | `prototyping` | — |
| 5 | `development` | Requires AI recommendation |
| 6 | `user_testing` | Requires human approval |
| 7 | `user_acceptance` | Requires human approval |
| 8 | `deployment` | — |

When a module is created, a database trigger inserts one `module_velocity` row per step (status `not_started`).

### 8.2 Step Status Machine

```
not_started → ready_to_start → ai_working ⇄ human_review → completed
                            ↘ human_working ⇄ ai_review ↗
                                          ↘ blocked / hand_raised
```

| Status | Meaning |
|--------|---------|
| `not_started` | Default; no work begun |
| `ready_to_start` | Previous step completed; can begin |
| `ai_working` | AI agent has the clock |
| `human_working` | Human has the clock |
| `ai_review` | AI is reviewing human work |
| `human_review` | Human is reviewing AI work |
| `completed` | Step done; auto-advances next step to `ready_to_start` |
| `blocked` | Hard impediment (red ring; `-10` penalty trigger) |
| `hand_raised` | Soft signal — needs help (yellow pulsing ring; **0 penalty**) |

A `loop_count` increments when a review status reverts to a working status (rejection). A module-level `loopback_count` increments on `send_back`.

### 8.3 Turns (Chess Clock History)

Every status change, note, or hand-raise is appended to `velocity_turn` with: actor (`human`/`ai`), action, from/to status, content + JSON, attachments, user/API-key attribution, and an alignment flag indicating whether both actors participated before completion.

**Turn actions:** `start`, `pass`, `review`, `approve`, `reject`, `complete`, `block`, `unblock`, `note`, `send_back`, `transition`, `raise_hand`, `lower_hand`.

### 8.4 Send-Back

`POST /velocity/modules/{moduleId}/send-back` resets the target step to `ready_to_start` and all later **unlocked** steps to `not_started`. The module-level `loopback_count` increments. Used when a downstream step (e.g., User Testing) discovers an issue requiring a return to an earlier phase. The target step must be earlier than the current active step.

### 8.5 Step Locks

`PUT /velocity/modules/{moduleId}/steps/{stepName}/lock` toggles `is_locked`. Locked steps are protected from being reset by send-back operations.

### 8.6 Governance & Alignment

- `requires_human_approval`: AI cannot self-approve; human sign-off required to mark `completed`.
- `requires_ai_recommendation`: human approval without prior AI review is recorded as misalignment.
- `turn_is_aligned` (per turn) and `alignment_count`/`misalignment_count` (per module) track collaborative balance.

### 8.7 Scoring (Points & Penalties)

`module_velocity_metrics` columns:

| Column | Meaning |
|--------|---------|
| `velocity_score` | Net (bonus − penalty) |
| `velocity_bonus` | Forward-progress points (alignment, completion) |
| `velocity_penalty` | Loopbacks, rejects, blocked time |
| `total_turns` | Sum of turn counts across all 8 steps |
| `loopback_count` | Send-back occurrences |
| `ai_time_seconds` / `human_time_seconds` | Cumulative actor time across steps |
| `outcome_score` | Stakeholder satisfaction 1–5, set on deployment |

Step-level `step_weight` (1=simple, 2=standard, 3=complex) and module-level `module_complexity` (NUMERIC 0–10) multiply scoring. Per-event point ledger entries are written to `user_points` (see [§ 13](#13-leaderboard--challenges)).

### 8.8 Real-Time Sync (`/velocity/stream`)

SSE stream broadcasting board events to all connected clients (humans + AI agents):

- `connected`, `clients` (count joined/left)
- `move` (status change incl. raise_hand / blocked)
- `note` (turn added without status change)
- `send_back`
- `lock`
- `project_created`, `project_updated`, `project_deleted`
- `module_created`, `module_updated`, `module_deleted`

Heartbeat every 30 s. Multiple humans + AI agents watch the same board simultaneously.

### 8.9 Velocity API Surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/velocity` | Dashboard data (all projects/modules/steps for heatmap) |
| GET | `/velocity/projects/{projectId}` | Modules + step status for a project |
| GET | `/velocity/modules/{moduleId}` | All 8 step rows for a module |
| PUT | `/velocity/modules/{moduleId}/steps/{stepName}` | Make a move (transition step status) |
| GET / POST | `/velocity/modules/{moduleId}/steps/{stepName}/turns` | List turns / add a note |
| GET | `/velocity/modules/{moduleId}/turns` | Module-wide turn history |
| POST | `/velocity/modules/{moduleId}/send-back` | Send module back to an earlier step |
| PUT | `/velocity/modules/{moduleId}/steps/{stepName}/lock` | Lock/unlock a step |
| GET | `/velocity/stream` | SSE real-time board |
| GET | `/velocity/guide` | Download Markdown gameplay guide |

### 8.10 Velocity UI (`/velocity`)

- Multi-project board: rows = modules, columns = the 8 steps
- Tile colors per status; pulsing rings for `hand_raised` (yellow) and `blocked` (red)
- Hover/click to inspect turns, attachments, and metrics
- Move dialog with attachments and content editor (supports AI-agent attribution via API keys)
- Live clients counter; events animate in via SSE without polling

---

## 9. Project Audits & Deep Audit

### 9.1 Universal `project_audit` Table

A single source-agnostic audit table holds results from any audit source:

```
audit_source ∈ {git, jira, confluence, sharepoint, sharepoint-content, web, manual, ai_analysis, deep-audit}
audit_status ∈ {pending, running, completed, failed, stale}
audit_data: JSONB payload (varies by source)
audit_ai_provider / audit_ai_model / audit_ai_analysis / audit_ai_score (0–100)
```

### 9.2 Project Audit API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/projects/{id}/audits` | Paginated list (filter by `source`) |
| POST | `/projects/{id}/audits` | Run an audit (`{ source, sourceUrl, moduleId? }`) |
| GET | `/projects/{id}/audits/{auditId}` | Audit detail with AI analysis |
| DELETE | `/projects/{id}/audits/{auditId}` | Soft-delete (own audits only) |
| GET | `/projects/{id}/audits/{auditId}/export/{json,md,docx}` | Download as JSON, Markdown, or DOCX (Arial, styled, color-coded) |
| POST | `/projects/{id}/audits/{auditId}/analyze` | Run LLM analysis (`provider ∈ {claude, gemini, grok}`, optional custom `prompt`) |

LLM analysis returns a structured payload:

```json
{
  "overallScore": 0-100,
  "completionEstimate": 0-100,
  "findings": [{ "category", "severity": "info|warning|critical", "description", "evidence" }],
  "recommendations": ["..."],
  "summary": "..."
}
```

### 9.3 Deep Audit (5-Phase LLM Pipeline)

`POST /projects/{id}/deep-audit` triggers a multi-phase audit of a GitHub repository:

1. **Discovery** — full file-tree scan via the GitHub Trees API
2. **Selection** — AI selects up to `maxFiles` files most relevant for production-readiness audit
3. **Loading** — fetches selected file contents within the `maxContentKB` budget
4. **Analysis** — batched LLM analysis of code quality, tests, security, completeness
5. **Consolidation** — merges batch results into a final report

Returns immediately with a running audit record. Progress streamed via SSE:

| Path | Purpose |
|------|---------|
| `GET /projects/{id}/deep-audit/{auditId}/stream` | SSE progress (`phase`, `progress`, `complete`, `error`) |
| `GET /projects/{id}/deep-audit/{auditId}/status` | Current phase + progress |

Defaults: `maxFiles=200` (10–500), `maxContentKB=500` (100–2000), `provider=claude`. PAT injected automatically from user's saved Settings; falls back to system-level `GITHUB_PAT`.

### 9.4 SharePoint Deep Content Audit

`POST /sharepoint/projects/{projectId}/audit` mirrors the GitHub deep audit against a project's SharePoint folder structure:

1. **Discovery** — enumerate all SharePoint folders/files
2. **Selection** — prioritize files by name, type, and folder (requirements, architecture, plans rank highest)
3. **Loading** — read content of top-ranked files (text-based, capped at `maxContentKB`/file)
4. **Analysis** — LLM analyzes content against project metadata, module structure, and per-step completeness
5. **Consolidation** — saves structured results: module completeness, key artifacts, recommendations

Defaults: `maxFiles=100`, `maxContentKB=300`. Returns 202 immediately; processes asynchronously with SSE progress events. Export the report back to SharePoint via `POST /sharepoint/projects/{projectId}/audit/{auditId}/export`.

---

## 10. SharePoint Integration

Velo integrates with Microsoft Graph (Sites.Selected app permission) to manage project artifacts in SharePoint Online.

### 10.1 Configuration

| Env Variable | Purpose |
|--------------|---------|
| `SHAREPOINT_APPLICATION_CLIENT_ID` | Entra app registration client ID |
| `SHAREPOINT_APPLICATION_CLIENT_SECRET` | Entra app secret |
| `SHAREPOINT_APPLICATION_TENANT_ID` | Entra tenant ID |
| `SHAREPOINT_SITE_URL` | Target SP site (with `Sites.Selected` granted) |

### 10.2 Folder Hierarchy

When a project's folder structure is created (`POST /sharepoint/projects/{projectId}/folders`), Velo provisions:

```
/Velo Projects/{ProjectName}/
/Velo Projects/{ProjectName}/Audits/
/Velo Projects/{ProjectName}/{ModuleName}/
/Velo Projects/{ProjectName}/{ModuleName}/{StepName}/   ← one per velocity step
```

The `sharepoint_folder` table records `folder_type ∈ {project, module, step, audit}`, the SharePoint site/drive/folder IDs, the folder path, the web URL, and the sync status. Provisioning is idempotent.

### 10.2.1 Auto-provisioning (v5.1)

The folder hierarchy is now provisioned **automatically** at three lifecycle points — no manual "Create Folders" click required:

| Trigger | What gets provisioned |
|---------|----------------------|
| `POST /projects` | Project root + `/Audits` + `/Requirements` |
| `POST /projects/:id/modules` | The new module's folder + its 8 velocity-step subfolders (idempotent, parent re-checked) |
| `POST /projects/:id/clone` | Full hierarchy for the clone (its own modules + step folders) |

All auto-provisioning is **fire-and-forget** — failures are logged at WARN and never block the originating create response. A `sharepoint_folders_created` SSE event is broadcast with `autoProvisioned: true` when the folders land, so the SharePoint panel UI refreshes without user action. The manual `POST /sharepoint/projects/:projectId/folders` endpoint is still available for re-provisioning after an out-of-band SharePoint deletion.

### 10.3 SharePoint API Surface

| Group | Endpoints |
|-------|-----------|
| **Status** | `GET /sharepoint/status` (configured + reachable + IDs) |
| **Project Folders** | `POST/GET /sharepoint/projects/{projectId}/folders` |
| **Folder Files** | `GET/POST /sharepoint/folders/{folderId}/files` (upload max 50 MB; auto-enqueues AI processing) |
| **Item Children** | `GET /sharepoint/items/{itemId}/children` (browse arbitrary subfolders directly via Graph) |
| **Item Subfolder / Files** | `POST /sharepoint/items/{itemId}/{subfolder,files}` |
| **File Operations** | `GET /sharepoint/files/{itemId}/{download,metadata}`, `PATCH /sharepoint/files/{itemId}/{rename,move}`, `DELETE /sharepoint/files/{itemId}` |
| **Velocity Step Artifacts** | `GET/POST /sharepoint/modules/{moduleId}/steps/{stepName}/artifacts` (auto-creates folder hierarchy) |
| **Deep Content Audit** | `POST /sharepoint/projects/{projectId}/audit`, export to SP |
| **Search** | `GET /sharepoint/search?q=` |
| **Folder Management** | `DELETE /sharepoint/folders/{folderId}/folder`, `POST /sharepoint/folders/{folderId}/subfolder` |
| **ZIP Import / Export** | `POST /sharepoint/folders/{folderId}/import-zip` (50 MB), `POST /sharepoint/items/{itemId}/import-zip` (2 GB disk-streamed), `GET /sharepoint/folders/{folderId}/export-zip` |
| **AI Processing** | See [§ 12](#12-ai-processing-pipeline) |

### 10.4 Inline File Preview

`GET /sharepoint/files/{itemId}/download?inline=true` serves safe MIME types (PDF, images, plain text) inline with a strict Content-Security-Policy header — the default is attachment download for everything else.

### 10.5 Role Restrictions

All write operations (upload, delete, rename, move, create subfolder, import-zip, run audit, export, AI process, retry) require `runner`, `project_lead`, or `admin`. Read operations are open to authenticated users.

---

## 11. GitHub Integration

Velo integrates with GitHub via Octokit using each user's encrypted Personal Access Token. The `git.service` injects the PAT and the configured org automatically — API consumers never pass tokens in request bodies.

### 11.1 PAT Storage & GitHub URL

| Endpoint | Purpose |
|----------|---------|
| `PUT /settings/pat` | Save PAT (AES-256-GCM encrypted in `user_github_pat_encrypted` + IV) |
| `DELETE /settings/pat` | Clear saved PAT |
| `GET /settings/pat/status` | Returns `configured` and whether a system-level `GITHUB_PAT` exists |
| `PUT /settings/github-domain` | Accepts a full GitHub URL (e.g. `https://github.com/MyOrg`); auto-extracts `domain` and `org` and saves both |

If a user has no PAT, the system falls back to the env-level `GITHUB_PAT` for read operations.

### 11.2 Git API Surface

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/git/repos` | Create a repo (defaults to private; auto-injects org from settings) |
| POST | `/git/extract` | Trigger repository extraction (commits, PRs, branches, contributor analytics); stores result as a `project_audit` |
| GET | `/git/repos/{owner}/{repo}/analytics` | Cached analytics for a repository |
| GET | `/git/repos/{owner}/{repo}/files?path=&branch=` | List files in a directory (proxies GitHub Contents API) |
| POST | `/git/repos/{owner}/{repo}/commits` | Commit a single file |
| POST | `/git/repos/{owner}/{repo}/commits/batch` | **PREFERRED:** atomic multi-file commit using the Git Trees API |
| POST | `/git/repos/{owner}/{repo}/pulls` | Create a pull request |
| POST | `/git/repos/{owner}/{repo}/branches` | Create a branch from a source branch |

Repo-creation convention: `VELO-{ProjectName}-{last4uuid}`.

---

## 12. AI Processing Pipeline

When a file is uploaded to SharePoint (single upload, ZIP import, step artifact, API), Velo enqueues an AI shadow-processing job that converts the source into a Markdown shadow file (prefixed `__AI__`). This makes documents AI-readable for downstream chat, audits, and analysis.

### 12.1 Supported Inputs

| File Type | Strategy |
|-----------|----------|
| **PDF** | `pdf-lib` splits the document into single-page PDFs; vision API (Gemini or Claude) OCRs each page in parallel |
| **DOCX** | Mammoth converts to Markdown; embedded images are extracted and sent to vision; falls back to AI vision if mostly images |
| **PPTX** | `pizzip + xml2js` extracts slide text; per-slide images sent to vision |
| **XLSX / CSV** | ExcelJS converts each sheet into a Markdown table |
| **Images** | Sent directly to vision (no decomposition) |

### 12.2 State Machine

`ai_processing_job` (parent, one per source file):

```
queued → processing → merging → completed
                           ↘ failed
                           ↘ skipped
```

Source files unchanged since last processing (matched on `cTag`) are skipped. `ai_processing_sub_job` rows track each vision API call (PDF page, DOCX/PPTX image, XLSX sheet) and are merged after all complete. Retry with exponential backoff (`max_retries=3`).

A unique partial index prevents double-enqueuing (only one active job per SharePoint item allowed in `queued`/`processing`/`merging`).

### 12.3 Queue API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/sharepoint/ai-queue` | Pending + processing counts and item list |
| GET | `/sharepoint/ai-queue/jobs?folderId=` | Recent jobs (active + last 24 h) with sub-jobs |
| POST | `/sharepoint/ai-queue/jobs/{jobId}/retry` | Clear sub-jobs and requeue (runner+) |
| POST | `/sharepoint/files/{itemId}/process` | Process a single file (runner+) |
| POST | `/sharepoint/folders/{folderId}/process-all` | Process all eligible files in a folder (runner+) |
| GET | `/sharepoint/folders/{folderId}/ai-status` | Single Graph call returning staleness report (total, upToDate, stale, missing) |

### 12.4 Vision Providers

The factory in `services/ai-providers/` selects between `claude.provider.ts` and `gemini.provider.ts` for vision; the request can override via `?provider=gemini|claude`. AI chat additionally supports `openai.provider.ts` and `grok.provider.ts`.

---

## 13. Leaderboard & Challenges

### 13.1 Point Ledger (`user_points`)

Every points event is recorded for auditability:

| Source | Earned When |
|--------|-------------|
| `velocity_step` | Completing a velocity step |
| `velocity_bonus` | Alignment, perfect-run, approval bonuses |
| `velocity_penalty` | Rejection, send-back, blocked penalties (negative points) |
| `challenge_complete` | Completing a challenge |
| `challenge_bonus` | Speed bonus (within `challenge_max_days`) |
| `manual` | Admin-granted points |

Each row stores user FK, signed `points`, source, description, optional project/module FK and step name, and a timestamp. `created_at DESC` is indexed for fast history retrieval.

### 13.2 Materialized Leaderboard

The `leaderboard` materialized view aggregates per-user totals (`total_points`, `velocity_points`, `challenge_points`, `bonus_points`, `penalty_points`, `modules_completed`, `challenges_completed`, `projects_touched`). Refresh it concurrently via the `refresh_leaderboard()` SQL function or `POST /leaderboard/refresh` (admin only).

### 13.3 Leaderboard API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/leaderboard?period={month,year,all}&limit=` | Ranked entries |
| GET | `/leaderboard/me` | Current user's points + last 20 events |
| GET | `/leaderboard/user/{userId}/history` | Full point audit trail |
| GET | `/leaderboard/project/{projectId}/contributors` | Contributors with totals, actions, modules touched |
| GET | `/leaderboard/module/{moduleId}/contributors` | Per-step contributor history |
| POST | `/leaderboard/refresh` | Refresh the materialized view (admin only) |

### 13.4 Challenges

Challenges are projects flagged `is_challenge=true` with metadata: `challenge_points`, `challenge_max_days`, `challenge_difficulty` (easy/medium/hard/expert).

**Cloning-based acceptance (v5.1):** Accepting a challenge **clones the parent project** (using the same single-level cloning machinery from § 14). Each accepter gets their own independent attempt with their own velocity board, members, and progress. The challenge creator (or an admin) closes the challenge and picks a winner from the acceptances; points are awarded to the winning clone's active owner(s), split equally when multiple co-owners exist.

| Field | Purpose |
|-------|---------|
| `challenge_max_acceptances` | Cap on the number of clones (`NULL` = unlimited; integer = first-come, first-served) |
| `challenge_closed_at` | Set when the creator closes the challenge; flips `project_clone_disabled = true` |
| `challenge_winner_project` | FK to the winning clone (or the parent itself if no clones) |
| `challenge_winner_narrative` | Optional explanation shown alongside the winner |
| `challenge_winner_picked_at` / `_by` | Audit attribution |

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/challenges?status=&difficulty=` | any | List parent challenges (`status` ∈ open / claimed / closed / completed / all) — acceptance counts decorated |
| GET | `/challenges/{projectId}` | any | Single challenge with its acceptances (clones) |
| POST | `/challenges/{projectId}/accept` | runner+ | Clone the challenge; idempotent per user |
| POST | `/challenges/{projectId}/close` | creator/admin | Block further acceptances; existing clones may still complete |
| POST | `/challenges/{projectId}/pick-winner` | creator/admin | Pick winning clone; awards points + records narrative |
| POST | `/challenges/{projectId}/claim` | runner+ | (Legacy) single-claimer flow |
| POST | `/challenges/{projectId}/complete` | runner+ | (Legacy) single-claimer completion |
| POST | `/challenges/{projectId}/unclaim` | runner+ | (Legacy) abandon |

Errors: `403 CHALLENGE_CLOSED`, `403 CHALLENGE_COMPLETED`, `403 NOT_CHALLENGE_CREATOR`, `409 CHALLENGE_FULL`, `409 WINNER_ALREADY_PICKED`, `422 CLONE_OF_CLONE`.

The `/challenges` UI shows acceptance progress (e.g. "3 / 5 spots taken" or "3 acceptances · unlimited"), an Accept button per challenge, creator-only Close and Pick-Winner controls, and the winner with narrative once picked.

---

## 14. Project Collaboration

Multi-user / multi-agent collaboration for projects (added in v5.0). Combines four mechanisms — **membership**, **cloning**, **locking**, and **admin clone-policy** — that together let humans and AI agents work on the same project (or compete in parallel on cloned versions) without colliding.

### 14.1 Open vs claimed projects

A project is **open** when it has zero active members — any user with `runner`, `project_lead`, or `admin` role may edit it. (This is the legacy behavior.) The first user to call `POST /projects/{id}/members` with their own ID **direct-claims** the project — they become the inaugural owner. From that point on, the project is **claimed**: only its members (and admins) may edit it.

The unified write gate (`utils/project-permissions.ts → requireProjectWrite`) sits in front of every project-scoped write endpoint. It checks system role, membership, and lock state in one call and returns one of:

| Code | Meaning |
|------|---------|
| `403 NOT_A_MEMBER` | Project is claimed; you're not a member |
| `403 OWNER_REQUIRED` | Action requires the `owner` member role |
| `423 PROJECT_LOCKED` | Project is locked by another user |
| `403 FORBIDDEN` | Some other gate failed (typically system-role) |

### 14.2 Member roles

Two roles, stored in the `project_member` junction table (one row per `(project, user)`, soft-deactivated on removal so the historical record survives):

| Role | Capabilities |
|------|-------------|
| `owner` | Add/remove members, change roles, transfer ownership, lock, rename version label, complete challenges, delete the project |
| `collaborator` | Edit (when unlocked), make velocity moves, create modules/budgets/links, run audits |

**Last-owner protection:** demoting or removing the last owner returns `409 LAST_OWNER` if any collaborators remain. The last owner can leave only when no other members are present (which makes the project open again).

### 14.3 Cloning

Any user with `runner+` may clone a top-level project via `POST /projects/{id}/clone`. Cloning is **single-level** — clones cannot themselves be cloned (`422 CLONE_OF_CLONE`).

What's copied to the clone:

| Copied | Reset |
|--------|-------|
| Project metadata (name, description, ministry, priority, scope, branch, risk, demand #, mission-critical, challenge fields) | `status=discovery`, `percent_complete=0`, dates `null`, all challenge claim/completion fields |
| Modules (each with new UUID; trigger inits fresh `module_velocity` rows) | Module status, percent, dates |
| `project_link` rows (default ON, `copyLinks=true`) | — |
| `project_budget` rows (optional, `copyBudgets=false`) | `budget_spent` reset to 0 |
| — | members (clone starts with cloner only as owner) |
| — | velocity_turn, module_velocity_metrics, project_audit, project_update, project_lead, sharepoint_folder |

**Provenance:** `fk_project_parent` references the source. `project_cloned_from_name` snapshots the parent name at clone time so lineage survives parent deletion (`fk_project_parent` becomes `null` on parent delete via `ON DELETE SET NULL`).

**Auto-suffixing:** clones inherit the parent's `project_code` with `-vN` appended (`PRJ-0042` → `PRJ-0042-v1`, `-v2`…). Cloners may set `versionLabel` ("CGI alt approach"); owners may rename later via `PUT /projects/{id}/version-label`.

### 14.4 Cluster query

`GET /projects/{id}/cluster` returns the parent + all clones (resolves up to the parent first if `id` is a clone). Every entry includes lock state, percent complete, primary owner, active member count. The `/projects/:id/cluster` UI route renders this as a side-by-side table for quick comparison.

`GET /projects/{id}/versions` returns the same data as a flat list.

### 14.5 Project lock

Any owner may acquire a lock with `POST /projects/{id}/lock` (optional reason). While locked, only the locker (and admins) may mutate the project, its modules, sub-resources, or velocity board. `POST /projects/{id}/unlock` releases the lock; admins may pass `force=true` to release someone else's lock — doing so writes a `project_update` of type `decision` so the original locker sees the override on their next visit.

Lock acquisition is idempotent for self (re-acquiring updates the reason). Acquiring a lock held by another user returns `409 ALREADY_LOCKED`.

### 14.6 Admin clone-policy

`PATCH /projects/{id}/clone-policy` (admin-only) toggles `project_clone_disabled`. When `true`, every clone attempt — **including admins'** — returns `403 CLONE_DISABLED`. To clone a disabled project, the admin must re-enable, clone, then re-disable. Existing clones are unaffected. The admin's reason is stored in `project_clone_disabled_reason` and surfaced in the UI.

### 14.7 Permission introspection

`GET /projects/{id}/permissions` returns a `ProjectPermissions` object — the single source of truth the UI uses to render correct gates: `canRead`, `canWriteProject`, `canMakeVelocityMoves`, `canManageMembers`, `canRename`, `canToggleLock`, `canTogglePolicy`, `canClone`, plus the underlying state (`isOpen`, `isClaimed`, `isLocked`, `lockedBy`, `isMember`, `isOwner`, `isAdmin`, `cloneDisabled`).

### 14.8 SSE event additions

Eight new events broadcast on `/velocity/stream` for spectator UIs:

| Event | Payload (selected) |
|-------|-------------------|
| `member_added` | `projectId`, `userId`, `userDisplayName`, `role`, `addedBy` |
| `member_removed` | `projectId`, `userId`, `userDisplayName`, `role`, `removedBy` |
| `member_role_changed` | `projectId`, `userId`, `fromRole`, `toRole`, `changedBy` |
| `ownership_transferred` | `projectId`, `fromUserId`, `toUserId`, `transferredBy` |
| `version_created` | `projectId` (the clone), `parentId`, `projectName`, `versionLabel`, `clonedBy` |
| `version_renamed` | `projectId`, `versionLabel`, `renamedBy` |
| `lock_acquired` / `lock_released` | `projectId`, `lockedBy`/`releasedBy`, `forceReleased` (admin), `previousLocker` |
| `clone_policy_changed` | `projectId`, `disabled`, `reason`, `by` |

### 14.9 API surface (collaboration)

| Method | Path | Auth |
|--------|------|------|
| POST | `/projects/{id}/clone` | runner+ |
| GET | `/projects/{id}/cluster` | public |
| GET | `/projects/{id}/versions` | public |
| PUT | `/projects/{id}/version-label` | owner |
| POST | `/projects/{id}/lock` | owner |
| POST | `/projects/{id}/unlock` | owner (own) or admin (`force=true`) |
| GET | `/projects/{id}/members` | public |
| GET | `/projects/{id}/members/history` | authenticated |
| POST | `/projects/{id}/members` | owner (or self-add on open project) |
| PATCH | `/projects/{id}/members/{membershipId}` | owner |
| DELETE | `/projects/{id}/members/{membershipId}` | owner (or self-remove) |
| POST | `/projects/{id}/transfer-ownership` | owner |
| PATCH | `/projects/{id}/clone-policy` | admin |
| GET | `/projects/{id}/permissions` | authenticated |
| GET | `/users/lookup?q=&limit=` | authenticated (any role) |

All endpoints accept API-key auth — agents call them identically to humans. Audit log distinguishes via `_authSource` and `_apiKeyId` so you can always tell which actions came from a browser session vs. an agent operating with a key.

### 14.10 UI

- `ProjectDetailView` — lock banner, admin clone-policy toggle, version-label inline edit, clone button, cluster button, members panel
- `ProjectMembersPanel.vue` — list with avatars, add (typeahead via `/users/lookup`), remove, role change, transfer ownership
- `ProjectLockBanner.vue` — lock state + reason + locker + own-release / admin-force-unlock controls
- `CloneProjectDialog.vue` — version label, copy-links / copy-budgets toggles
- `VersionsBadge.vue` — small pill with cluster size + dropdown of sibling versions
- `AdminClonePolicyToggle.vue` — admin-only inline section with reason field
- `ClusterView.vue` (route `/projects/:id/cluster`) — side-by-side table of all versions in lineage
- `VelocityView.vue` — board groups by parent; cluster header rows are collapsible when ≥3 versions

---

## 15. Agent Concurrency

Multi-agent racing on the same project or velocity step is made safe by two cooperative HTTP-header mechanisms (added in v5.0). Both are **advisory** — clients that don't opt in still work, just with last-write-wins risk.

### 15.1 Optimistic concurrency: `If-Match`

| Resource | Counter | Trigger |
|----------|---------|---------|
| Project (and all sub-resource writes scoped to it) | `project.project_revision` | Auto-bumps on every UPDATE via `bump_project_revision` BEFORE-UPDATE trigger |
| Velocity step | `module_velocity.step_revision` | Auto-bumps via `bump_step_revision` trigger |

Both are **integers, monotonic**, and incremented **regardless** of what the SQL UPDATE statement supplies for them — the trigger overwrites NEW with `OLD + 1`. Service code never has to remember to bump.

Every project response and every velocity step response surfaces the current value (the columns ride along on the existing `SELECT *`).

Clients send `If-Match: <revision>` on writes:

```http
PUT /api/v1/projects/abc      If-Match: 7
→ 200  (revision bumps to 8)
```

```http
PUT /api/v1/projects/abc      If-Match: 7
→ 412 PRECONDITION_FAILED
{ "details": [{ "field": "currentRevision", "message": "9" }] }
```

The losing client refetches and decides whether the new state still allows their intent.

The `If-Match` middleware is wired on every project-scoped write route (`PUT /projects/{id}`, sub-resource POST/PUT/DELETE, `/lock`, `/unlock`, `/version-label`, `/members…`, `/clone-policy`) and on every velocity move/note/lock route (`PUT /velocity/modules/{moduleId}/steps/{stepName}`, `POST .../turns`, `PUT .../lock`).

### 15.2 Idempotency: `Idempotency-Key`

Agents include `Idempotency-Key: <uuid>` on any non-`GET` request. The server stores `(key, fk_user, fk_api_key, request_method, request_path, request_hash, response_status, response_body, expires_at)` in `velocity_idempotency` (24-hour TTL).

Behavior:

- **First request, key never seen** → forward to handler; capture the response on its way out via wrapped `res.json`; cache only `2xx` responses; return as normal.
- **Replay with same key + same body hash** → return the cached response with header `Idempotency-Replayed: true`.
- **Same key, different body hash** → `422 IDEMPOTENCY_KEY_REUSED`. (Different intent — the agent must use a fresh key.)
- **Invalid key format** → `400 IDEMPOTENCY_KEY_INVALID` (must be a UUID).

Cleanup runs hourly from `server.ts` via `cleanupExpiredIdempotency()` — deletes rows past `expires_at`.

The middleware is wired on every velocity move/note/send-back route and every project write route.

### 15.3 Combining the two

The combination is what makes agents safe in practice:

```
Agent intends: "complete architecture step on module abc"
1. GET  /api/v1/velocity/modules/abc                → step_revision: 7
2. PUT  /api/v1/velocity/modules/abc/steps/architecture
        If-Match: 7
        Idempotency-Key: 0c9f...                    → 200 step_revision: 8
3. (network blip — agent retries the same request)
        Idempotency-Key: 0c9f...                    → 200 (replayed; Idempotency-Replayed: true)
4. (parallel agent did a write meanwhile, revision now 9)
        Different agent retries with new intent, fresh key
        If-Match: 8                                  → 412 PRECONDITION_FAILED currentRevision=9
```

Optimistic concurrency catches **conflicting writes**; idempotency keys catch **duplicate retries**. Together they make agent racing deterministic without server-side leases (which were considered and deferred — current mechanism is sufficient for typical workloads and adds zero blocking).

### 15.4 Storage

`velocity_idempotency` columns:

| Column | Type | Purpose |
|--------|------|---------|
| `idempotency_key` | UUID PK | Client-supplied UUID |
| `fk_user` / `fk_api_key` | UUID, nullable | Attribution; `ON DELETE SET NULL` so user/key removal doesn't orphan-fail |
| `request_method` / `request_path` | VARCHAR | Logged for debugging |
| `request_hash` | VARCHAR(64) | SHA-256 of `METHOD path \n JSON.stringify(body)` |
| `response_status` / `response_body` | INT / JSONB | Cached payload |
| `created_at` / `expires_at` | TIMESTAMPTZ | Default `NOW() + INTERVAL '24 hours'` |

Indexes: `expires_at` (drain), `(fk_user, created_at DESC)` (per-user dashboard).

---

## 16. Visualization Engine

### 14.1 Gantt Chart (`/gantt`)

- Horizontal timeline with **zoom** (24–200 px per month)
- Scroll controls (left/right buttons)
- Fixed left column: project names (clickable → detail)
- Year/month headers
- Bars: start → end date, colored by phase (theme-aware)
- Progress overlay: darker fill = % complete
- **Today marker:** red vertical line
- Only shows projects with both dates defined
- FilterBar integration (search, ministry, phase, source, mission-critical)

### 14.2 Canvas / Dependency Graph (`/canvas`)

Built with `@vue-flow/core`:

- **Project nodes:** white cards, colored borders by risk status (green→amber→orange→red)
- **Module nodes:** smaller child cards, colored by module status
- **Dependency edges:** animated arrows colored by type (FS=indigo, SS=cyan, FF=amber, SF=orange, Other=gray); labeled
- **Project↔module edges:** light gray connectors

**Interactions:**

- Drag any node → position tracked in memory
- **Save Layout** → batch `POST /canvas/positions`
- **Reset Layout** → clears saved positions, auto-layout
- Click project → focus mode (hides everything else, shows linked items only)
- Ministry filter (MultiSelect)
- Show/hide modules toggle
- **Link Projects** dialog: select two projects, dependency type, label, notes
- MiniMap, Controls (zoom in/out/fit), background grid
- Legend bar at bottom

### 14.3 Ministry Heatmap (`/heatmap`)

- **Group by:** Ministry (default), Phase, Go-Live Type
- **Grid:** group rows × month columns
- **Cell color intensity:** active project count for that group/month
- Hover tooltip with project names; click opens modal with full list
- Sortable rows; clickable ministry names → drill down

### 14.4 Ministry Drill-Down (`/heatmap/:ministry`)

- **Grid:** project names × month columns
- **Cell color:** danger gradient (green→yellow→orange→red) based on delivery risk + deadline proximity
- **Cell value:** % complete
- **Current month:** highlighted in blue
- Risk badge per project on left
- Hover tooltips: expected vs actual %, days to deadline, danger level
- Click cell/project name → detail

### 14.5 At-Risk Dashboard (`/at-risk`)

- Risk summary cards: Critical, Past Due, Behind, At Risk, On Track, Completed, No Data
- 9-box grid: ministry rows × risk-level columns; cell intensity = project count; click opens modal
- Full project list sorted by risk severity; actual-vs-expected progress bars; days remaining/overdue; velocity ratio
- Filters: ministry, risk level, search

### 14.6 Velocity Heatmap (`/velocity`)

See [§ 8.10](#810-velocity-ui-velocity).

---

## 17. Risk Assessment

`assessRisk()` (exported from the projects store) is shared across all views.

| Risk Level | Condition | Color |
|------------|-----------|-------|
| `completed` | % = 100 | Green |
| `on-track` | gap ≤ 5 % | Green |
| `at-risk` | gap ≤ 20 % | Yellow |
| `behind` | gap ≤ 40 % | Orange |
| `critical` | gap > 40 % | Red |
| `past-due` | end date passed, not complete | Red |
| `no-data` | missing dates | Gray |

Returns `{ level, label, expectedPct, actualPct, gap, daysRemaining, velocityRatio, reason }` where `expectedPct = timeElapsed / totalDuration × 100` and `gap = expectedPct − actualPct`.

---

## 18. Immutable Audit Log

### 16.1 Coverage

Every mutation across all entities is logged to `audit_log`:

| Entity | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|
| Project | ✓ | ✓ | ✓ (soft) |
| Module | ✓ (+projectId) | ✓ (+projectId) | ✓ (+projectId) |
| Budget | ✓ (+projectId) | ✓ (+projectId) | ✓ (+projectId) |
| Link | ✓ (+projectId) | — | ✓ (+projectId) |
| Lead | ✓ (+projectId) | — | ✓ (+projectId) |
| Update | ✓ (+projectId) | — | ✓ (+projectId) |
| Module Link | ✓ (+moduleId) | — | ✓ (+moduleId) |
| API Key | ✓ | — | ✓ |
| Person | ✓ | ✓ | ✓ |
| Person Merge | — | ✓ | — |
| Dependency | ✓ | — | ✓ |
| Application | ✓ | ✓ | ✓ (soft) |
| Contract | ✓ | ✓ | ✓ (soft) |
| Project↔App / ↔Contract Link | ✓ | — | ✓ |
| Velocity Move / Note / Send-Back / Lock | ✓ | — | — |
| User Role Add / Remove | ✓ | — | ✓ |
| Auth (login / logout) | ✓ | — | — |

### 16.2 Design

- **Immutable:** no DELETE endpoint exists for `audit_log`
- **Orphan-resilient:** sub-resource entries embed `_projectId` / `_moduleId` in JSONB so they remain queryable after the sub-resource is deleted
- **Auth-attributed:** every entry includes `_authSource` (`session` | `api_key`) and `_apiKeyId`
- **Paginated:** API supports `page` / `limit`; frontend shows prev/next (30 per page)
- **JSON diff:** stores `audit_old_data` and `audit_new_data` as JSONB

---

## 19. AI Chat (Multi-Provider)

WebSocket-based (Socket.io at `/ai`) with streaming support.

| Provider | File | Notes |
|----------|------|-------|
| OpenAI | `openai.provider.ts` | Default (gpt-4o-mini) |
| Claude | `claude.provider.ts` | Anthropic API |
| Gemini | `gemini.provider.ts` | Google AI |
| Grok | `grok.provider.ts` | xAI |

A provider factory selects based on the `AI_PROVIDER` env var, overridable per request.

**Features:**

- Conversation persistence (DB-backed: `ai_conversation`, `ai_message`)
- Message-history retrieval
- Streaming responses via callback
- Rate limit: 60 messages / hour per user (env-configurable)
- Token counting per message
- Conversation title management

REST endpoints: `POST /ai/chat`, `POST /ai/analyze-image`, `GET /ai/conversations`, `DELETE /ai/conversations/{conversationId}`, `GET /ai/conversations/{conversationId}/messages`, `POST /ai/conversations/{conversationId}/generate-title`. Conversations are created implicitly on the first `/ai/chat` call (no separate POST is needed).

Vision uses are dispatched through the AI processing pipeline (see [§ 12](#12-ai-processing-pipeline)) and the deep-audit pipeline (see [§ 9.3](#93-deep-audit-5-phase-llm-pipeline)).

---

## 20. Notifications

### 18.1 Architecture

- **Subscription-based:** users subscribe by resource, region, or broadcast
- **Message → Delivery:** admins create messages; the system creates per-user delivery records
- **SSE streaming:** real-time push via Server-Sent Events (`/notifications/stream`)
- **Read tracking:** per-user read/unread with timestamps

### 18.2 Subscription Types

| Type | Target | Notification Trigger |
|------|--------|---------------------|
| `resource` | Specific resource ID | Resource updates |
| `region` | Region name | Regional announcements |
| `broadcast` | — | All announcements |

### 18.3 Broadcast Logic

- If `regionFilter`: sends to region subscribers + broadcast subscribers
- Else: sends to all active users or all broadcast subscribers
- Bulk insert with `ON CONFLICT DO NOTHING` for deduplication

---

## 21. Security

### 19.1 Security Headers (Helmet)

- **CSP:** allows Google Fonts, Adobe Typekit, inline styles (PrimeVue), self + data: for images
- **HSTS:** Strict-Transport-Security
- **Permissions-Policy:** disables camera, microphone, geolocation, payment, etc.
- **X-Frame-Options DENY**, **X-Content-Type-Options nosniff**, **Referrer-Policy**

### 19.2 CSRF Protection

- **Pattern:** stateless double-submit cookie with HMAC verification
- **Flow:** client gets token from `GET /auth/csrf` → sends in `X-CSRF-Token` header on mutations
- **Validation:** timing-safe comparison of header vs httpOnly `csrf_token` cookie
- **Bypass:** API-key auth (no cookies involved)
- **Applied to:** POST, PUT, PATCH, DELETE

### 19.3 Rate Limiting

| Limiter | Max | Window | Applied To |
|---------|-----|--------|-----------|
| API | 200 | 15 min | `/api/*` |
| Auth | 30 | 15 min | Login/SSO |
| AI | 60 | 1 hour | AI chat + processing endpoints |

Memory-based per-process. Returns 429 with `Retry-After` header.

### 19.4 Input Validation

- **Zod** schemas on all request bodies (server-side)
- **AJV** for dynamic-form submissions (JSON Schema validation)
- **SQL-injection prevention:** all queries parameterized (`$1`, `$2`, …)
- **Sort-column whitelisting:** only allowed column names accepted in `ORDER BY`
- **URL validation:** link URLs must use `http:` or `https:` (rejects `javascript:` etc.)
- **Date validation:** max 9999-12-31 enforced client + server
- **XSS:** DOMPurify on the frontend; Helmet CSP on the server
- **Inline content:** SharePoint inline preview restricted to safe MIME types with strict CSP
- **Content-Type validation:** 415 on unexpected request types

### 19.5 Cookie Configuration

- `httpOnly: true`
- `secure: true` in production
- `sameSite: 'lax'`

### 19.6 Secrets Encryption

- **GitHub PATs** encrypted at rest with AES-256-GCM (`user_github_pat_encrypted` + `user_github_pat_iv`); decrypted only when injecting into a Git API call
- **API keys** SHA-256 hashed (never stored in plaintext)
- **JWT** RS256 (asymmetric) with separate access and refresh key pairs
- **Refresh tokens** SHA-256 hashed in DB with rotation on every refresh
- **All secrets** loaded from env vars with minimum-length checks (`CSRF_SECRET ≥ 32 chars`)

### 19.7 Error Handling

- **PostgreSQL error mapping:** translates DB error codes to safe HTTP responses
- **Production mode:** strips stack traces and SQL details from client responses
- **Development mode:** passes through original messages
- **Global error handler:** catches unhandled errors at Express level

---

## 22. Infrastructure & Operations

### 20.1 Server Entry

- HTTP server wrapping Express (for Socket.io attachment)
- Tests DB connection on startup
- Default port: 3001 (dev)

### 20.2 Graceful Shutdown

Configurable timeout (`SHUTDOWN_TIMEOUT_MS`, default 30 s):

1. Close WebSocket connections
2. Close HTTP server (stop accepting new requests)
3. Close database pool
4. Process-level handlers for `unhandledRejection` and `uncaughtException`

### 20.3 Database Connection Pool

| Setting | Default | Env Var |
|---------|---------|---------|
| Max connections | 20 | `DB_POOL_MAX` |
| Idle timeout | 30 s | `DB_IDLE_TIMEOUT_MS` |
| Connection timeout | 5 s | `DB_CONNECTION_TIMEOUT_MS` |
| Statement timeout | 30 s | `DB_STATEMENT_TIMEOUT_MS` |

SSL auto-detected for remote databases (Render, `sslmode=require`).

### 20.4 Logging

- **Winston** structured logging with correlation IDs
- **Request log:** method, path, status, duration; warns on > 1 s
- **Error log:** full details server-side, sanitized for client

### 20.5 Compression

- gzip / brotli via `compression` middleware
- Excludes SSE streams

### 20.6 Static File Serving

- When `SERVE_CLIENT=true`, serves bundled frontend from `client/dist`
- SPA fallback: non-API GET routes serve `index.html` for Vue Router

### 20.7 Environment Variables (Selected)

**Core:** `PORT`, `NODE_ENV`, `DATABASE_URL`, `CORS_ORIGIN`, `SERVE_CLIENT`

**JWT (RS256):** `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_REFRESH_PRIVATE_KEY`, `JWT_REFRESH_PUBLIC_KEY`, `JWT_ACCESS_EXPIRES_IN` (15m), `JWT_REFRESH_EXPIRES_IN` (7d)

**OAuth:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`

**AI:** `AI_PROVIDER`, `AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROK_API_KEY`, `AI_MODEL`, `AI_MAX_TOKENS`

**SharePoint:** `SHAREPOINT_APPLICATION_CLIENT_ID`, `SHAREPOINT_APPLICATION_CLIENT_SECRET`, `SHAREPOINT_APPLICATION_TENANT_ID`, `SHAREPOINT_SITE_URL`

**GitHub:** `GITHUB_PAT` (system fallback)

**Encryption:** `PAT_ENCRYPTION_KEY` (32-byte for AES-256-GCM)

**Security:** `CSRF_SECRET` (≥ 32 chars)

**Rate Limiting:** `RATE_LIMIT_API_MAX`/`_WINDOW_MS`, `RATE_LIMIT_AUTH_MAX`/`_WINDOW_MS`, `RATE_LIMIT_AI_MAX`/`_WINDOW_MS`

**Body limits:** `BODY_LIMIT_JSON` (1 MB), `BODY_LIMIT_URLENCODED` (1 MB)

**Shutdown:** `SHUTDOWN_TIMEOUT_MS` (30 s)

**Client:** `VITE_API_BASE_URL` (`/api`), `VITE_APP_TITLE`

### 20.8 Scripts

| Script | Purpose |
|--------|---------|
| `npm run install:all` | Install root + server + client dependencies |
| `npm run dev:all` | Start backend and frontend together (concurrently) |
| `npm run build` | Production build (client + server) |
| `npm run start` | Run production server |
| `npm run db:migrate` | Run all idempotent SQL migrations |
| `npm run db:seed` | Seed database |
| `npm test` | Run server + client test suites |
| `server/src/scripts/generate-keys.ts` | Generate RS256 key pairs for JWT |
| `server/src/scripts/generate-secrets.ts` | Generate `CSRF_SECRET` + `PAT_ENCRYPTION_KEY` |
| `server/src/scripts/set-role.ts` | Grant/revoke a role for a user |
| `server/src/scripts/rollback.ts` | Roll back the most recent migration |

---

## 23. Functional Requirements

### FR-1 Authentication & Session

| ID | Requirement |
|----|-------------|
| FR-1.1 | Support Google OAuth 2.0 with configurable client ID/secret |
| FR-1.2 | Support Microsoft OIDC with configurable client ID/secret/tenant |
| FR-1.3 | Issue RS256 JWT access tokens (15 min default) in httpOnly cookies |
| FR-1.4 | Issue refresh tokens (7 d default) with hash stored in DB; rotate on refresh |
| FR-1.5 | Cross-link users across SSO providers by email |
| FR-1.6 | Enforce 4-role multi-role RBAC: `user`, `runner`, `project_lead`, `admin` |
| FR-1.7 | Auto-logout after 30 min of inactivity (mouse/keyboard/touch/scroll) |
| FR-1.8 | Support user-generated API keys: named, SHA-256 hashed, revocable, optional expiry |
| FR-1.9 | API-key auth carries the owning user's roles (no privilege escalation) |
| FR-1.10 | Display user profile (name, email, avatar, roles) when authenticated |
| FR-1.11 | Auto-retry on 401 by refreshing the access token; queue concurrent requests |
| FR-1.12 | Admins SHALL pre-register users with assigned roles before first SSO login |
| FR-1.13 | Admins SHALL enable/disable user accounts and add/remove roles via admin UI |

### FR-2 Project Management

| ID | Requirement |
|----|-------------|
| FR-2.1 | Store projects with full metadata (name, description, code, ministry, dates, %, priority, scope, category, demand #, branch, risk, go-live type, ministry priority, mission-critical, challenge fields) |
| FR-2.2 | Create projects via dialog form (project_lead+); soft-delete (admin-recoverable) |
| FR-2.3 | Inline-edit all project fields on detail page (toggle edit mode) |
| FR-2.4 | Ministry dropdown SHALL show all configured ministries, alphabetical |
| FR-2.5 | Date inputs SHALL enforce max 9999-12-31 (client + server) |
| FR-2.6 | Projects SHALL support a legacy `project_code` (PRJ-xxxx) and UUID PK |
| FR-2.7 | Project list SHALL support pagination, search, multi-filter (ministry, phase, source, mission-critical), sort |
| FR-2.8 | Project list SHALL toggle between card view and compact table view |

### FR-3 Modules

| ID | Requirement |
|----|-------------|
| FR-3.1 | Each project SHALL have zero or more modules |
| FR-3.2 | Module status workflow: `requirements_gathering` → `building` → `client_review` → `client_sign_off` → `delivered` → `closed` → `cancelled` |
| FR-3.3 | Modules SHALL support their own external links |
| FR-3.4 | Modules SHALL track complexity (NUMERIC 0–10) which multiplies velocity scoring |
| FR-3.5 | Module CRUD dialogs SHALL validate required fields and enforce status enum |

### FR-4 Budgets, Links, Updates, Team, Persons

| ID | Requirement |
|----|-------------|
| FR-4.1 | Multi-fiscal-year budget lines with funding source, money type, amount, spent, notes; total + per-FY breakdown |
| FR-4.2 | Project + module external links with type, URL, label, description; URL must be `http(s):` |
| FR-4.3 | Status updates with type, title, content, source attribution; speech-to-text dictation (en-CA) |
| FR-4.4 | Team assignments via project_lead with 17 role values, primary flag, FTE/contractor, organization |
| FR-4.5 | Persons pool with display name, email, GitHub handle, FTE flag, organization, notes |
| FR-4.6 | Persons SHALL support pg_trgm typeahead search |
| FR-4.7 | People SHALL support directional merge transferring assignments |

### FR-5 Velocity Engine

| ID | Requirement |
|----|-------------|
| FR-5.1 | Each module SHALL auto-initialize 8 velocity step rows on creation (DB trigger) |
| FR-5.2 | Step status machine: `not_started`, `ready_to_start`, `ai_working`, `human_working`, `ai_review`, `human_review`, `completed`, `blocked`, `hand_raised` |
| FR-5.3 | Every status change/note SHALL be recorded in `velocity_turn` with actor, action, content, attachments, attribution |
| FR-5.4 | `send_back` SHALL reset target step to `ready_to_start` and unlocked later steps to `not_started`; increment `loopback_count` |
| FR-5.5 | Step locks SHALL prevent reset by send-back |
| FR-5.6 | Governance: `requires_human_approval` and `requires_ai_recommendation` flags SHALL gate completions |
| FR-5.7 | Alignment SHALL be tracked at turn and module level |
| FR-5.8 | Scoring SHALL produce per-module `velocity_score`/`bonus`/`penalty` weighted by `step_weight` and `module_complexity` |
| FR-5.9 | Hand-raise SHALL be a soft signal with zero penalty (yellow pulse); blocked SHALL be hard with penalty (red pulse) |
| FR-5.10 | The board SHALL stream changes to all clients via SSE (`connected`, `clients`, `move`, `note`, `send_back`, `lock`, `project_*`, `module_*`); 30-s heartbeat |
| FR-5.11 | A Markdown gameplay guide SHALL be downloadable at `/velocity/guide` |

### FR-6 Audits & Deep Audit

| ID | Requirement |
|----|-------------|
| FR-6.1 | Universal `project_audit` table SHALL store results from any source |
| FR-6.2 | Audits SHALL be exportable as JSON, Markdown, and DOCX |
| FR-6.3 | Audits SHALL be analyzable by LLM (Claude/Gemini/Grok) returning findings, recommendations, score, completion estimate |
| FR-6.4 | Deep-audit SHALL run 5-phase pipeline (Discovery → Selection → Loading → Analysis → Consolidation) on GitHub repos |
| FR-6.5 | Deep-audit progress SHALL stream over SSE with `phase`, `progress`, `complete`, `error` events |
| FR-6.6 | Audit deletion SHALL be restricted to the audit's creator |

### FR-7 SharePoint Integration

| ID | Requirement |
|----|-------------|
| FR-7.1 | Velo SHALL provision a standard folder hierarchy for projects: `/Velo Projects/{Project}/{Module}/{Step}/` plus `/Audits/` |
| FR-7.2 | Folder provisioning SHALL be idempotent |
| FR-7.3 | File operations (upload, download, metadata, rename, move, delete, search) SHALL proxy Microsoft Graph |
| FR-7.4 | Inline preview SHALL be restricted to safe MIME types with CSP headers |
| FR-7.5 | ZIP import SHALL recreate folder/file structure into target SharePoint folder; supports up to 2 GB via disk streaming on item-ID endpoint |
| FR-7.6 | ZIP export SHALL stream a folder + recursive contents back as a ZIP |
| FR-7.7 | All write operations SHALL require runner+ |
| FR-7.8 | A SharePoint deep content audit SHALL execute a 5-phase pipeline mirroring GitHub deep audit |

### FR-8 GitHub Integration

| ID | Requirement |
|----|-------------|
| FR-8.1 | Per-user PAT SHALL be encrypted with AES-256-GCM at rest |
| FR-8.2 | A user-saved GitHub URL SHALL be parsed to extract domain + org; org auto-injected into repo creation |
| FR-8.3 | Velo SHALL support GitHub repo create, file commit (single + batch via Trees API), branch create, PR create, file list, repo extraction (commits/PRs/branches/contributors) |
| FR-8.4 | Repository extraction results SHALL be stored as a `project_audit` record |
| FR-8.5 | When no user PAT is set, system SHALL fall back to env `GITHUB_PAT` for read operations |

### FR-9 AI Processing Pipeline

| ID | Requirement |
|----|-------------|
| FR-9.1 | Files uploaded to SharePoint SHALL auto-enqueue an AI-shadow processing job |
| FR-9.2 | Pipeline SHALL support PDF (per-page OCR), DOCX (text + image fallback), PPTX (slide text + image), XLSX/CSV (table-to-Markdown), images (vision) |
| FR-9.3 | Vision providers SHALL be Claude or Gemini (auto-detect or override) |
| FR-9.4 | Source files unchanged since last processing SHALL be skipped (cTag match) |
| FR-9.5 | Sub-jobs SHALL track each vision API call with retry (max 3) and exponential backoff |
| FR-9.6 | Only one active job per SharePoint item SHALL be allowed (unique partial index) |
| FR-9.7 | Folder staleness SHALL be reportable in a single Graph call |

### FR-10 Leaderboard & Challenges

| ID | Requirement |
|----|-------------|
| FR-10.1 | Every points event SHALL be recorded in `user_points` with source, description, optional project/module/step links |
| FR-10.2 | Leaderboard SHALL be a materialized view aggregating user totals; refreshable concurrently |
| FR-10.3 | Leaderboard API SHALL support `period ∈ {month, year, all}` and per-user/project/module breakdowns |
| FR-10.4 | Challenges SHALL be projects flagged `is_challenge=true` with point value, max-days, difficulty |
| FR-10.5 | Challenges SHALL be claim/complete/unclaim by runner+ users; speed bonus on completion within max-days |

### FR-10A Project Collaboration (v5.0)

| ID | Requirement |
|----|-------------|
| FR-10A.1 | Projects SHALL be either OPEN (no active members → any runner+ may edit) or CLAIMED (≥1 active member → only members and admins may edit) |
| FR-10A.2 | Membership SHALL be persisted in `project_member` with two roles: `owner` and `collaborator` |
| FR-10A.3 | Owners SHALL add/remove members, change roles, transfer ownership, lock the project, rename version label, complete challenges, and delete the project |
| FR-10A.4 | The system SHALL reject demoting/removing the last owner while collaborators remain (`409 LAST_OWNER`) |
| FR-10A.5 | Any user with `runner+` SHALL clone any top-level project (`POST /projects/{id}/clone`); cloning is single-level (clones cannot be cloned, `422 CLONE_OF_CLONE`) |
| FR-10A.6 | Cloning SHALL copy modules + project links by default, optionally budgets, never copy members/audit/turn history |
| FR-10A.7 | Each clone SHALL have its own velocity board, members, lock state, and audit trail |
| FR-10A.8 | `project_code` on a clone SHALL auto-suffix `-vN`; `project_version_label` SHALL be owner-renameable |
| FR-10A.9 | Provenance SHALL survive parent deletion via `project_cloned_from_name` snapshot (FK becomes null on parent delete) |
| FR-10A.10 | Owners SHALL acquire/release a project lock (`POST /lock`, `POST /unlock`); while locked, only the locker (and admins) may write |
| FR-10A.11 | Admins SHALL force-unlock with `force=true`; force-unlock SHALL write a `project_update` of type `decision` |
| FR-10A.12 | Admins SHALL toggle `project_clone_disabled` via `PATCH /clone-policy`; admins are NOT exempt from the resulting `403 CLONE_DISABLED` |
| FR-10A.13 | `GET /projects/{id}/permissions` SHALL return a single computed object covering every gate the UI needs |
| FR-10A.14 | `GET /projects/{id}/cluster` SHALL return parent + all clones for a lineage; `/projects/{id}/versions` SHALL return the same data flat |
| FR-10A.15 | `GET /users/lookup?q=&limit=` SHALL be available to any authenticated user (returns minimal info) so non-admins can find teammates |
| FR-10A.16 | The velocity board SHALL group projects by lineage; cluster headers with ≥3 versions SHALL be collapsible |
| FR-10A.17 | All collaboration endpoints SHALL accept API-key authentication identically to cookie sessions, with audit attribution preserved (`_authSource`, `_apiKeyId`) |

### FR-10B Agent Concurrency (v5.0)

| ID | Requirement |
|----|-------------|
| FR-10B.1 | `project.project_revision` and `module_velocity.step_revision` SHALL auto-increment on every UPDATE via DB triggers regardless of what the SQL UPDATE supplies |
| FR-10B.2 | Project + velocity step responses SHALL surface their revision counters (via existing `SELECT *` paths) |
| FR-10B.3 | Writes SHALL accept optional `If-Match: <revision>` header; mismatch returns `412 PRECONDITION_FAILED` with `currentRevision` in `details` |
| FR-10B.4 | `If-Match` SHALL be advisory — writes without it succeed (last-write-wins risk acknowledged) |
| FR-10B.5 | Non-`GET` writes SHALL accept optional `Idempotency-Key: <uuid>` header |
| FR-10B.6 | Cached idempotent responses SHALL be replayed for 24 hours with `Idempotency-Replayed: true` header |
| FR-10B.7 | Same key + different body hash SHALL return `422 IDEMPOTENCY_KEY_REUSED` |
| FR-10B.8 | Invalid key format SHALL return `400 IDEMPOTENCY_KEY_INVALID` |
| FR-10B.9 | Expired idempotency rows SHALL be cleaned up hourly by `server.ts` (`cleanupExpiredIdempotency()`) |

### FR-11 Risk Assessment

| ID | Requirement |
|----|-------------|
| FR-11.1 | Calculate delivery risk: `expected = elapsed/duration × 100`, `gap = expected − actual` |
| FR-11.2 | Levels: completed, on-track (≤5%), at-risk (≤20%), behind (≤40%), critical (>40%), past-due, no-data |
| FR-11.3 | Single shared `assessRisk()` function used by every view |
| FR-11.4 | Project detail SHALL show prominent risk banner with explanation, progress comparison, days remaining, velocity needed |

### FR-12 Visualizations

| ID | Requirement |
|----|-------------|
| FR-12.1 | Gantt: zoomable horizontal timeline (24–200 px/mo), today marker, phase-colored bars, progress overlay, FilterBar |
| FR-12.2 | Canvas: Vue Flow graph with risk-bordered project nodes, module child nodes, animated typed dependency edges, drag-to-reposition, save/reset, ministry filter, focus mode, MiniMap, link-projects dialog |
| FR-12.3 | Canvas positions (x, y) SHALL persist to DB per project and module |
| FR-12.4 | Heatmap (group × month) SHALL be groupable by ministry/phase/go-live type with intensity by count, modal on click, ministry drill-down |
| FR-12.5 | Ministry drill-down (project × month) SHALL color cells by danger gradient |
| FR-12.6 | At-Risk: summary cards, ministry × risk-level 9-box, risk-sorted project list |
| FR-12.7 | All visualizations SHALL be theme-aware (`useTheme().chartColors`) |
| FR-12.8 | Dashboard SHALL show phase distribution (doughnut) and ministry distribution (bar) using Chart.js |

### FR-13 Audit Trail

| ID | Requirement |
|----|-------------|
| FR-13.1 | Every mutation on every entity SHALL be logged to `audit_log` with action, table, record ID, user, old/new JSONB, timestamp |
| FR-13.2 | Audit log SHALL be immutable (no DELETE endpoint) |
| FR-13.3 | Sub-resource entries SHALL embed parent ID in JSONB for orphan resilience |
| FR-13.4 | Every entry SHALL include auth-source attribution and API key ID where applicable |
| FR-13.5 | Auth events (login, logout, role change) SHALL be audited |
| FR-13.6 | Project detail SHALL show paginated audit panel with action, table, timestamp, user, JSON diff |

### FR-14 API & AI Integration

| ID | Requirement |
|----|-------------|
| FR-14.1 | OpenAPI 3.0 spec at `/api/v1/docs` SHALL document every endpoint, schema, enum, required field, example, and both auth methods |
| FR-14.2 | All project, module, budget, link, team, update, person, canvas, application, contract, velocity, audit, git, SharePoint, leaderboard, and challenge endpoints SHALL accept API-key auth |
| FR-14.3 | API-driven changes SHALL be attributed in the audit log with auth source and key ID |
| FR-14.4 | AI chat SHALL support OpenAI, Claude, Gemini, Grok via WebSocket streaming with conversation persistence and rate limiting (60/hr default) |
| FR-14.5 | Project detail SHALL surface audit, deep-audit, and SharePoint audit actions (where the user has the required role) |

### FR-15 UI / UX

| ID | Requirement |
|----|-------------|
| FR-15.1 | Use PrimeVue (Aura) + Tailwind CSS v4 |
| FR-15.2 | Support 5 themes (light, dark, warm, ocean, forest) persisted in localStorage |
| FR-15.3 | Be responsive / mobile-friendly with hamburger nav |
| FR-15.4 | Data refreshes SHALL be optimistic (no screen blanking) |
| FR-15.5 | Support PWA: install prompt, service-worker updates, offline detection |
| FR-15.6 | 404 page SHALL show "Go Back" and "Home" buttons |
| FR-15.7 | Skip-to-main-content link and route announcer SHALL support accessibility |
| FR-15.8 | Landing dashboard SHALL show live project + ministry counts |

### FR-16 Notifications & Portal

| ID | Requirement |
|----|-------------|
| FR-16.1 | Users SHALL subscribe to notifications by resource, region, or broadcast |
| FR-16.2 | Admins SHALL broadcast notifications to all users or by region |
| FR-16.3 | Notifications SHALL deliver in real time via SSE |
| FR-16.4 | Users SHALL see unread count badge and mark notifications read |
| FR-16.5 | Backend SHALL retain portal foundations: service catalog, resource library, dynamic JSON-Schema forms (AJV), service locations, admin dashboard CRUD |

---

## 24. Non-Functional Requirements

### NFR-1 Performance

| ID | Requirement |
|----|-------------|
| NFR-1.1 | API responses SHALL complete within 200 ms for indexed/cached queries at typical load |
| NFR-1.2 | Database queries SHALL use targeted indexes incl. partials on `is_deleted=false` |
| NFR-1.3 | Project list query SHALL avoid `GROUP BY` where correlated subqueries enable index usage |
| NFR-1.4 | Frontend SHALL use optimistic UI updates |
| NFR-1.5 | Search inputs SHALL debounce at 300 ms |
| NFR-1.6 | Server SHALL gzip / brotli compress responses (excluding SSE) |
| NFR-1.7 | All list endpoints SHALL support server-side pagination |
| NFR-1.8 | Frontend routes SHALL be lazy-loaded |
| NFR-1.9 | Database connection pool SHALL be configurable |
| NFR-1.10 | AI processing SHALL run in the background (queue-based, non-blocking) |

### NFR-2 Security

| ID | Requirement |
|----|-------------|
| NFR-2.1 | All SQL queries SHALL use parameterized statements — zero dynamic SQL concatenation |
| NFR-2.2 | All write endpoints SHALL require authentication (JWT session or API key) |
| NFR-2.3 | CSRF SHALL use stateless double-submit cookie with HMAC; bypassed for API-key auth |
| NFR-2.4 | All cookies SHALL be httpOnly, secure (production), sameSite=lax |
| NFR-2.5 | Helmet SHALL enforce CSP, HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |
| NFR-2.6 | API keys SHALL be SHA-256 hashed |
| NFR-2.7 | JWT SHALL use RS256 with separate access and refresh key pairs |
| NFR-2.8 | Error responses SHALL be sanitized in production |
| NFR-2.9 | Rate limiting SHALL be enforced (API 200/15m, Auth 30/15m, AI 60/1h) |
| NFR-2.10 | All sub-resource delete/update queries SHALL verify parent resource ownership (prevent IDOR) |
| NFR-2.11 | URL inputs SHALL reject non-`http(s):` protocols |
| NFR-2.12 | Frontend SHALL sanitize HTML via DOMPurify |
| NFR-2.13 | Secrets (`.env`, `keys/*.pem`) SHALL be gitignored |
| NFR-2.14 | Sort columns SHALL be whitelisted to prevent ORDER BY injection |
| NFR-2.15 | GitHub PATs SHALL be encrypted at rest (AES-256-GCM) and decrypted only when needed |
| NFR-2.16 | SharePoint inline preview SHALL be restricted to safe MIME types and served with strict CSP |
| NFR-2.17 | API-key authentication SHALL enforce the same role restrictions as cookie auth |
| NFR-2.18 | Every project-scoped write route SHALL pass through `projectWriteGate` middleware (system role + membership + lock check) |
| NFR-2.19 | The unified gate SHALL return distinct error codes (`NOT_A_MEMBER` 403, `OWNER_REQUIRED` 403, `PROJECT_LOCKED` 423) so clients can render targeted messages |
| NFR-2.20 | `Idempotency-Key` storage SHALL NEVER cache non-`2xx` responses (failures stay non-replayable) |

### NFR-3 Reliability

| ID | Requirement |
|----|-------------|
| NFR-3.1 | Server SHALL implement graceful shutdown (close WebSocket → HTTP → DB pool within configurable timeout, default 30 s) |
| NFR-3.2 | Process SHALL handle `unhandledRejection` and `uncaughtException` with logging and graceful exit |
| NFR-3.3 | Frontend SHALL fall back to static `projects.json` if backend API is unreachable |
| NFR-3.4 | Database migrations SHALL be idempotent |
| NFR-3.5 | Token refresh SHALL use rotation to prevent replay |
| NFR-3.6 | PostgreSQL connection errors SHALL map to HTTP 503 with safe messages |
| NFR-3.7 | Global error handler SHALL catch all unhandled Express errors |
| NFR-3.8 | AI processing jobs SHALL retry with exponential backoff (max 3) |
| NFR-3.9 | Only one active AI processing job per SharePoint item SHALL be allowed (unique partial index) |
| NFR-3.10 | Revision counters SHALL be enforced by DB triggers (not application code) so service writes cannot accidentally skip the bump |
| NFR-3.11 | Idempotency cache SHALL have a 24-hour TTL with hourly cleanup; expired rows SHALL be deleted by `cleanupExpiredIdempotency()` |
| NFR-3.12 | Last-owner protection SHALL be enforced server-side; the system MUST never allow a claimed project to have zero owners while collaborators remain |

### NFR-4 Observability

| ID | Requirement |
|----|-------------|
| NFR-4.1 | Every request SHALL have a correlation ID (UUID) attached to response and logs |
| NFR-4.2 | All requests SHALL log method, path, status, duration via Winston |
| NFR-4.3 | Requests > 1 s SHALL log at WARN |
| NFR-4.4 | Health endpoints SHALL be available at `/api/v1/health/{live,ready}` |
| NFR-4.5 | Every mutation SHALL be recorded in the immutable audit log |
| NFR-4.6 | SSE streams SHALL emit heartbeats (Velocity 30 s) to keep connections alive |

### NFR-5 Scalability

| ID | Requirement |
|----|-------------|
| NFR-5.1 | System SHALL support a large estate of projects across many ministries with people, applications, and contracts |
| NFR-5.2 | All list endpoints SHALL support pagination |
| NFR-5.3 | Database pool SHALL be configurable for the deployment environment |
| NFR-5.4 | Rate limiting is memory-based per process; production with multiple replicas SHALL use a distributed store (e.g., Redis) |
| NFR-5.5 | Static frontend assets SHALL be servable independently or via the backend |
| NFR-5.6 | Leaderboard SHALL be a materialized view refreshable concurrently |

### NFR-6 Maintainability

| ID | Requirement |
|----|-------------|
| NFR-6.1 | Backend SHALL follow layered architecture: routes → controllers → services → models |
| NFR-6.2 | All input validation SHALL use Zod in the `validators/` directory |
| NFR-6.3 | DB schema SHALL be managed via numbered idempotent SQL migration files |
| NFR-6.4 | Environment configuration SHALL be Zod-validated at startup with defaults |
| NFR-6.5 | AI providers SHALL be pluggable via factory pattern |
| NFR-6.6 | Frontend SHALL use composables for cross-cutting concerns |
| NFR-6.7 | API field convention SHALL be documented (camelCase in, snake_case out) |
| NFR-6.8 | All env vars SHALL have sensible defaults for development |
| NFR-6.9 | OpenAPI 3.0 spec SHALL be the source of truth for API documentation |

### NFR-7 Accessibility

| ID | Requirement |
|----|-------------|
| NFR-7.1 | Skip-to-main-content link |
| NFR-7.2 | Route changes announced to screen readers via route announcer |
| NFR-7.3 | PrimeVue components provide built-in ARIA |
| NFR-7.4 | Color contrast ratios meet WCAG 2.1 AA across all 5 themes |

### NFR-8 Compatibility

| ID | Requirement |
|----|-------------|
| NFR-8.1 | Frontend SHALL run in modern browsers supporting ES2020+ |
| NFR-8.2 | Speech-to-text SHALL gracefully degrade (button only when `webkitSpeechRecognition` exists) |
| NFR-8.3 | PWA features SHALL gracefully degrade |
| NFR-8.4 | API SHALL maintain backward compatibility via `/api/` alias for `/api/v1/` |

---

## 25. Running the Application

```bash
cd app

# 1. Generate RSA keys for JWT (first time only)
cd server && npm run generate-keys && cd ..

# 2. Generate CSRF / encryption secrets (first time only)
cd server && npx tsx src/scripts/generate-secrets.ts && cd ..

# 3. Install dependencies
npm run install:all

# 4. Run database migrations (idempotent — 68 migrations)
npm run db:migrate

# 5. Seed database
npm run db:seed

# 6. Start both frontend and backend in development
npm run dev:all

# Or build for production
npm run build && npm run start
```

| Endpoint | URL |
|----------|-----|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3001/api/v1 |
| OpenAPI Spec | http://localhost:3001/api/v1/docs |
| Health Check | http://localhost:3001/api/v1/health |
| WebSocket (AI Chat) | ws://localhost:3001/ai |
| SSE (Velocity) | http://localhost:3001/api/v1/velocity/stream |
| SSE (Notifications) | http://localhost:3001/api/v1/notifications/stream |

### 23.1 API Key Access

All project, module, person, application, contract, canvas, ministry, velocity, audit, git, SharePoint, leaderboard, challenge, and AI endpoints support API-key authentication via:

- `Authorization: Bearer velo_xxx`
- `X-API-Key: velo_xxx`

API keys are created in the Settings view after signing in. Public GET endpoints work without authentication; write operations require either a valid API key or a JWT session with CSRF token. **Role enforcement is identical** for both auth methods.

### 23.2 First-Run Admin

Use `npx tsx src/scripts/set-role.ts <email> admin` from `server/` to grant the `admin` role to the first user after they sign in. Admins can then pre-register others via `POST /users` and grant roles via `POST /users/{userId}/roles`.

---

*This specification is synthesized from the full codebase + `server/openapi.yaml` v4.0.0 — 63 migrations, 27 route files, 22 controllers, 29 services, 11 middleware modules (incl. `project-write-gate`, `if-match`, `idempotency`), and 21 frontend routes (incl. `/projects/:id/cluster`). Reviewed 2026-05-07.*
