# How Velo Audits Work

Velo can audit a project in seconds by connecting to where the project's artifacts live — GitHub repositories, SharePoint document libraries — and using AI to read, understand, and assess what it finds. This document explains how that works.

---

## The Problem

A project manager asks: *"Is this project actually on track?"*

Traditionally, answering that question means reading dozens of documents, checking multiple repositories, cross-referencing status reports, and hoping nothing was missed. It takes hours or days. By the time you have an answer, it's already outdated.

Velo solves this by automating the entire process. It connects directly to the source of truth, reads the actual files, and uses AI to produce a structured assessment — typically in under 60 seconds.

---

## Three Types of Audit

Velo has three audit systems, each designed for a different purpose:

### 1. Quick Audit (Git Metadata)

**What it does:** Pulls commit history, pull requests, and branch information from a GitHub repository and analyzes the activity patterns.

**What it tells you:** How active is the codebase? Who's contributing? Are PRs being reviewed? Is the main branch healthy?

**Speed:** 5-15 seconds.

**How it works:**
1. Connects to GitHub's API and pulls recent commits, PRs, and branches
2. Sends this metadata to an AI model (Claude, Gemini, or Grok — your choice)
3. The AI analyzes patterns: commit frequency, PR merge times, contributor spread, branch hygiene
4. Returns a structured report with scores and findings

This is useful for a quick pulse check on development activity.

### 2. Deep Audit (Code Analysis)

**What it does:** Actually reads the source code files in a repository and produces a comprehensive production-readiness assessment.

**What it tells you:** Is this code well-written? Are there security vulnerabilities? Are tests adequate? Is it ready for production?

**Speed:** 30-90 seconds depending on repository size.

This is Velo's most powerful audit type. It uses a **5-phase pipeline** described in detail below.

### 3. SharePoint Content Audit

**What it does:** Reads the documents stored in a project's SharePoint folders and assesses completeness against the project's module structure.

**What it tells you:** Are the right documents in the right places? Are requirements defined? Is there an architecture document? Are sign-offs present? Is anything stale or missing?

**Speed:** 20-60 seconds depending on file count.

This also uses a 5-phase pipeline, adapted for document repositories instead of code.

---

## The 5-Phase Pipeline (Deep Audit)

This is the core of Velo's audit intelligence. Each phase feeds into the next, progressively narrowing focus from "everything" to "what matters most."

### Phase 1: Discovery

**Goal:** Get a complete picture of what exists.

The system connects to the GitHub repository and asks: *"What files are in this project?"*

It uses GitHub's Trees API to get a recursive listing of every file in the repository — names, paths, and sizes. This is a single API call that returns the entire file tree.

The system then filters out noise:
- Binary files (images, fonts, compiled code)
- Generated files (node_modules, build output, lock files)
- Cache directories and IDE configuration

**Output:** A clean list of source files. For example, a typical web application might have 2,000 total files but only 300 meaningful source files after filtering.

**Why this matters:** Without this step, the AI would waste time reading lock files and compiled JavaScript. Discovery ensures we only look at files that contain actual project decisions.

### Phase 2: Selection

**Goal:** Choose the most important files to read in detail.

This is where AI judgment first comes in. The system sends the entire file tree (names and sizes, not contents) to an AI model and asks:

> *"You're auditing this repository for production readiness. Here are 300 files. Choose the most important ones to read — up to 200. Prioritize configuration, routes, services, tests, security middleware, and documentation."*

The AI returns a ranked list of files to examine, along with its reasoning.

As a safety net, the system also runs a **heuristic fallback** — a rules-based scorer that prioritizes files based on their path and name. Files with "controller," "auth," "test," "config," or "migration" in their path score highest. If the AI's selection is too small, the heuristic fills in the gaps.

**Output:** A curated list of ~100-200 files that represent the most important parts of the codebase.

**Why this matters:** Reading every file in a large repository would be slow, expensive, and produce a noisy report. Selection focuses the audit on what actually determines production readiness.

### Phase 3: Loading

**Goal:** Read the actual content of the selected files.

The system downloads each selected file from GitHub in parallel batches (5 files at a time) and accumulates the content. Each file is capped at 50KB to avoid loading generated or minified files that happen to be in the source tree.

The system tracks total content loaded and stops if it exceeds the configured limit (default: 500KB of source code). This prevents runaway costs on very large repositories.

Failed file loads are retried once and then skipped — a single broken file shouldn't block the entire audit.

**Output:** The actual source code of 100-200 key files, ready for analysis.

**Why this matters:** The AI needs to read real code to assess quality, security, and completeness. There's no shortcut — you have to look at the actual implementation.

### Phase 4: Analysis (Batched)

**Goal:** Have the AI read and evaluate the code.

This is the most computationally intensive phase. The loaded files are split into batches of roughly 80,000 tokens each (about 20-40 files per batch, depending on file size). Each batch is sent to the AI with a structured prompt:

> *"Analyze these files for: code quality, test coverage, security posture, code completeness, documentation quality, and production readiness. Score each 0-100. List specific findings with severity, evidence, and affected files."*

The AI reads each file, understands the patterns and relationships, and produces a detailed assessment with numeric scores and specific findings. For example:

- **Critical:** "SQL queries in `user.model.ts` use string concatenation instead of parameterized queries — SQL injection risk" (security, lines 45-52)
- **Warning:** "No rate limiting on `/api/v1/auth/login` endpoint" (security, auth.routes.ts)
- **Info:** "Consider adding request ID propagation for distributed tracing" (production-readiness)

If a batch fails (AI timeout, rate limit), the system retries with exponential backoff. If it still fails, that batch is marked with a warning and the audit continues with the remaining batches.

**Output:** Multiple batch results, each containing scores and findings for its subset of files.

**Why this matters:** Splitting into batches allows the system to analyze large codebases that wouldn't fit in a single AI context window. Each batch gets thorough attention.

### Phase 5: Consolidation

**Goal:** Merge all batch results into a single, coherent report.

The system sends all batch results back to the AI with a consolidation prompt:

> *"You analyzed 150 files across 4 batches. Here are the results. Produce a final consolidated report: merge scores (weighted average), deduplicate findings, and provide an executive summary, recommendations, and an overall production readiness score."*

The AI merges overlapping findings, resolves score discrepancies between batches, and produces the final structured report containing:

- **Overall Score** (0-100): A single number summarizing production readiness
- **Category Scores**: Code quality, test coverage, security, completeness, documentation, production readiness
- **Findings**: Every issue found, categorized and severity-ranked
- **Recommendations**: Organized as must-fix, should-fix, and nice-to-have
- **Tech Stack Detection**: Languages, frameworks, test tools, and dependencies identified
- **Executive Summary**: A 3-5 paragraph narrative assessment
- **Completion Estimate**: AI's assessment of actual completion percentage vs. what's reported

**Output:** A structured JSON report that powers Velo's audit dashboard.

---

## The SharePoint Audit Pipeline

The SharePoint audit follows the same 5-phase structure, adapted for documents instead of code:

| Phase | GitHub Deep Audit | SharePoint Content Audit |
|-------|-------------------|--------------------------|
| **Discovery** | GitHub Trees API lists all files | Graph API lists files in all tracked folders |
| **Selection** | AI picks key source files | Priority scoring: requirements, architecture, plans rank highest |
| **Loading** | Download file contents via GitHub REST API | Download file contents via Graph API |
| **Analysis** | AI evaluates code quality, security, tests | AI evaluates document completeness per module/step |
| **Consolidation** | Merge batch scores into final report | Produce module completeness matrix + artifact gap analysis |

The SharePoint audit adds project context that the GitHub audit doesn't have — it knows about the project's modules and velocity steps, so it can assess whether each module has the right documents in the right folders.

---

## How the AI Models Are Used

Velo supports three AI providers. You choose which one to use for each audit:

| Provider | Model | Best For |
|----------|-------|----------|
| **Claude** (Anthropic) | claude-sonnet-4 | Deepest code understanding, security analysis |
| **Gemini** (Google) | gemini-2.0-flash | Fast analysis, good at pattern recognition |
| **Grok** (xAI) | grok-3-mini-fast | Quick assessments, cost-effective |

All three receive the same prompts and return the same structured JSON format. The difference is in the depth and nuance of the analysis.

The AI is asked to return **structured JSON only** — not prose. This means the results can be displayed as dashboards, charts, and filterable tables rather than walls of text. Every finding has a category, severity, title, description, evidence reference, and list of affected files.

---

## Real-Time Progress

While an audit runs, the system streams progress updates to the browser via **Server-Sent Events (SSE)**. You see each phase start and complete in real-time:

```
Discovery: Found 2,341 files, filtered to 287 source files
Selection: AI selected 185 files for analysis
Loading:   Loaded 172/185 files (487 KB), 13 skipped
Analysis:  Batch 1/3 complete (62 files) ... Batch 2/3 ... Batch 3/3
Done:      Audit complete — Overall Score: 74/100
```

This means you don't have to wait in the dark wondering if something is broken. You can watch the audit work through each phase.

---

## What Makes This Different

Traditional audit approaches have significant limitations:

**Manual audits** take days and are inconsistent. Two auditors looking at the same codebase will produce different reports.

**Static analysis tools** (SonarQube, ESLint) check syntax rules but can't understand intent. They'll catch a missing semicolon but not a broken authentication flow.

**Velo's AI audit** reads the code the way a senior developer would — understanding relationships between files, recognizing patterns, and assessing whether the implementation matches the intent. It does this in seconds instead of days, and it produces the same structured report every time.

The phased approach is what makes this practical:

1. **Discovery** avoids wasting time on irrelevant files
2. **Selection** uses AI judgment to focus on what matters
3. **Loading** with batching and retries handles real-world failures gracefully
4. **Batched analysis** works within AI context limits while covering the full codebase
5. **Consolidation** produces a single coherent report from multiple analyses

The result is a structured, evidence-backed assessment of a project's actual state — not what someone reported in a status update, but what the code and documents actually show.

---

## Output Format

Every audit produces a structured JSON result stored in the database and displayed in Velo's UI. The key sections are:

```
Overall Score:       74/100
Code Quality:        82/100
Test Coverage:       61/100
Security Posture:    78/100
Code Completeness:   69/100
Documentation:       71/100
Production Readiness: 67/100
```

Plus a list of specific findings:

```
CRITICAL  Missing CSRF protection on 3 state-changing endpoints
CRITICAL  Database credentials in environment without encryption at rest
WARNING   No integration tests for the payment processing flow
WARNING   Error responses leak stack traces in production mode
INFO      Consider adding request timeout middleware
INFO      README is outdated — references removed API endpoints
```

And actionable recommendations:

```
Must Fix:    Parameterize all SQL queries, add CSRF to POST routes
Should Fix:  Add integration tests for auth flow, configure error masking
Nice to Have: Add OpenTelemetry tracing, update API documentation
```

Audit reports can be exported as **DOCX**, **Markdown**, or **JSON**, and can be saved directly to the project's SharePoint folder for archival.

---

## Security and Privacy

- Velo never stores source code permanently. File contents are loaded into memory, sent to the AI for analysis, and discarded.
- AI API calls use the project's configured API keys. Code is sent to the selected AI provider's API (Anthropic, Google, or xAI) under their respective data handling policies.
- Audit results (scores, findings, recommendations) are stored in the database. The raw source code is not.
- GitHub access uses encrypted Personal Access Tokens (AES-256). SharePoint access uses OAuth2 client credentials.
- All audit operations require authentication and the `project_lead` or `runner` role.
