---
name: sync-docs
description: Audit README, openapi.yaml, CLAUDE.md, migrations, and Express routes for drift. Reports every gap with its source location and proposes patches before applying them. Use after a feature lands or when the user reports an inconsistency between code and docs.
---

# /sync-docs — drift audit + targeted fix

This skill drives `scripts/check-docs-sync.mjs` and produces actionable, file-anchored fixes for every drift it finds.

## When to invoke

- The user says "are docs in sync?", "check docs", "audit docs", or similar.
- After landing a feature that touched routes, migrations, validators, services, or the OpenAPI schema.
- When CI's `docs-sync` job fails and the user wants the agent to fix it.

## What the script checks (Tier 1 reference)

| Check | What it catches |
|-------|-----------------|
| Migration count | README "(N Total)" header + "idempotent — N migrations" disagrees with `ls migrations/*.sql` |
| Routes ⊆ OpenAPI | Every Express `router.METHOD('path')` has a matching path in `openapi.yaml` |
| OpenAPI orphans (warn) | `openapi.yaml` documents a path with no Express route |
| Doc citations | `POST /xxx` references in README/CLAUDE.md resolve to real routes |
| SSE event coverage | Every `velocityStreamManager.broadcast('xxx')` is mentioned in at least one doc |
| Error code coverage (warn) | Custom `AppError` codes are mentioned in at least one doc |
| Project columns | Columns referenced in `project.model.ts` exist in some migration |
| Version banner | README's "Aligned with openapi v X.Y.Z" matches actual `openapi.yaml: version` |

## Workflow

1. **Run the check, capture JSON:**
   ```bash
   npm run check:docs:json > /tmp/sync.json
   cat /tmp/sync.json
   ```

2. **For each issue in the JSON output:**
   - Read the source file at the location implied by the `category` and `message`.
   - Read the corresponding doc that's missing the reference.
   - Build a minimal patch (single Edit per gap; group related gaps into one Edit when in the same file).

3. **Show the user the proposed diff first.** Don't apply unless they confirm — drift fixes are usually unambiguous but sometimes the gap reveals a misnamed endpoint or genuinely missing implementation.

4. **Apply edits and re-run** to verify zero drift:
   ```bash
   npm run check:docs
   ```
   If new drift surfaced (e.g., adding a doc reference exposed a different missing entry), repeat.

5. **Stop when:** `check:docs` exits 0 with "no drift detected".

## Triage hints by category

- `migrations.readme` — only the README/CLAUDE.md numbers need updating; never touch the migration files.
- `routes.openapi.missing` — usually means a new endpoint was added to a `*.routes.ts` file but `openapi.yaml` wasn't updated. Check the existing nearby paths in `openapi.yaml` for the right tag/style.
- `routes.openapi.orphan` (warn) — usually means an OpenAPI path describes an endpoint that was renamed or removed. Either delete the OpenAPI entry or restore the route.
- `citations` — README or CLAUDE.md references an endpoint that doesn't exist. Either remove the citation, fix the typo, or implement the endpoint.
- `sse.events` — service code broadcasts an event that no doc mentions. Add it to the SSE listener examples in CLAUDE.md and the event list in openapi.yaml's `/velocity/stream` description.
- `errors.undocumented` (warn) — custom error code (e.g. `CHALLENGE_FULL`) thrown but never explained to consumers. Add to the relevant endpoint's `Errors:` block in OpenAPI.
- `schema.column` — `project.model.ts` references a column not in any migration. Almost always a typo in the model; check the actual column name.
- `version.banner` — bump the README's "Aligned with openapi vX.Y.Z" or the OpenAPI `info.version`, whichever is stale.

## What this skill should NOT do

- It must not silently bypass `check:docs` failures by suppressing or relaxing the script.
- It must not invent new endpoints or migrations to "satisfy" a citation; if the cited endpoint genuinely doesn't exist, ask the user whether to remove the citation or implement the endpoint.
- It must not commit changes — that's a separate user decision.
