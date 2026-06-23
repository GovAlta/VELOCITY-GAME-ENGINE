#!/usr/bin/env node
/**
 * check-docs-sync.mjs
 *
 * Mechanical drift detection across:
 *   • Express routes (server/src/routes/*.routes.ts)
 *   • OpenAPI spec   (server/openapi.yaml)
 *   • README         (../README.md)
 *   • CLAUDE.md      (server/src/static/CLAUDE.md)
 *   • Migrations     (server/migrations/*.sql)
 *   • SSE events     (broadcast call sites vs documented event lists)
 *
 * Exits non-zero on any drift. Designed for pre-push hook + CI usage.
 *
 * Flags:
 *   --json            machine-readable JSON output
 *   --migrations-only just the migration count check (used by Claude hook)
 *
 * Run from app/: node scripts/check-docs-sync.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// ─── Path resolution (script lives in app/scripts/, repo root is app/) ──────
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const SERVER  = path.join(APP_ROOT, 'server');
const README  = path.join(APP_ROOT, 'README.md');
const OPENAPI = path.join(SERVER, 'openapi.yaml');
const CLAUDE  = path.join(SERVER, 'src/static/CLAUDE.md');
const MIGRATIONS = path.join(SERVER, 'migrations');
const ROUTES_DIR = path.join(SERVER, 'src/routes');
const SRC_DIR    = path.join(SERVER, 'src');
const APP_TS     = path.join(SERVER, 'src/app.ts');

const args = new Set(process.argv.slice(2));
const FLAGS = { json: args.has('--json'), migOnly: args.has('--migrations-only') };

// ─── js-yaml: shared with the client install (no separate dep) ──────────────
// Windows ESM dynamic-import requires file:// URLs for absolute paths.
async function loadYaml() {
  const candidates = [
    'client/node_modules/js-yaml/dist/js-yaml.mjs',
    'client/node_modules/js-yaml/index.js',
  ];
  for (const rel of candidates) {
    const abs = path.join(APP_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const fileUrl = url.pathToFileURL(abs).href;
    try {
      const mod = await import(fileUrl);
      return mod.default || mod;
    } catch { /* try next */ }
  }
  throw new Error('js-yaml not found — run npm install in client/');
}
const yaml = await loadYaml();

const issues = [];   // { severity: 'error'|'warn', category, message, hint? }
function err(category, message, hint) { issues.push({ severity: 'error', category, message, hint }); }
function warn(category, message, hint) { issues.push({ severity: 'warn', category, message, hint }); }

// =============================================================================
// CHECK 1 — Migration count consistency
// =============================================================================
function checkMigrationCount() {
  const files = fs.readdirSync(MIGRATIONS).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  const onDisk = files.length;

  // README claim
  if (fs.existsSync(README)) {
    const text = fs.readFileSync(README, 'utf8');
    const m = text.match(/Migrations\s*\((\d+)\s*Total/i);
    if (!m) {
      warn('migrations.readme', 'README has no "Migrations (N Total)" header — drift detection limited.');
    } else if (Number(m[1]) !== onDisk) {
      err('migrations.readme',
          `README claims ${m[1]} migrations; repo has ${onDisk}.`,
          `Update the "### 3.1 Migrations (N Total" header in app/README.md.`);
    }
    // Also check the running-instructions block ("idempotent — N migrations")
    const m2 = text.match(/idempotent\s*—\s*(\d+)\s*migrations/);
    if (m2 && Number(m2[1]) !== onDisk) {
      err('migrations.readme.runinst',
          `README "${m2[0]}" disagrees with on-disk count ${onDisk}.`);
    }
  } else {
    warn('migrations.readme', 'README.md not found — skipping README/migration check.');
  }
  return { onDisk, files };
}

// =============================================================================
// CHECK 2 — Express routes vs OpenAPI paths
// =============================================================================

/** Walk a dir for *.routes.ts files. */
function listRouteFiles() {
  return fs.readdirSync(ROUTES_DIR)
           .filter(f => f.endsWith('.routes.ts'))
           .map(f => path.join(ROUTES_DIR, f));
}

/** Parse `v1Routes.use('/foo', …, fooRoutes)` to map import-name → mount-prefix. */
function parseAppMounts() {
  const text = fs.readFileSync(APP_TS, 'utf8');
  const importRe = /import\s+(\w+)\s+from\s+'\.\/routes\/([^']+)'/g;
  const mountRe  = /v1Routes\.use\('([^']+)'\s*,[^)]*?(\w+Routes)\s*\)/g;

  const importToFile = {}; // varName → routes-filename (no extension)
  for (const m of text.matchAll(importRe)) importToFile[m[1]] = m[2];

  const mounts = {}; // routes-filename → array of mount paths (multiple are possible)
  for (const m of text.matchAll(mountRe)) {
    const prefix = m[1], importName = m[2];
    const file = importToFile[importName];
    if (!file) continue;
    (mounts[file] ||= []).push(prefix);
  }
  return mounts;
}

/** Find router.METHOD('path', …) in a routes file. Returns [{ method, relPath }]. */
function parseRoutesInFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  // matches router.get('/x', …)  router.post('/x', …) etc.
  const re = /router\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  const out = [];
  for (const m of text.matchAll(re)) out.push({ method: m[1].toUpperCase(), relPath: m[2] });
  return out;
}

/** Convert Express ":id" → OpenAPI "{id}" so paths can be compared. */
function expressToOpenapi(p) {
  return p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/** Combine mount + relative path; collapse double slashes. */
function joinPath(mount, rel) {
  if (rel === '/' || rel === '') return mount.replace(/\/$/, '') || '/';
  return (mount.replace(/\/$/, '') + (rel.startsWith('/') ? rel : '/' + rel)).replace(/\/{2,}/g, '/');
}

/** Find inline routes defined directly on v1Routes in app.ts (e.g. /docs, /_meta/sync). */
function parseInlineAppRoutes() {
  if (!fs.existsSync(APP_TS)) return [];
  const text = fs.readFileSync(APP_TS, 'utf8');
  const re = /v1Routes\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;
  const out = [];
  for (const m of text.matchAll(re)) {
    out.push({ method: m[1].toUpperCase(), relPath: m[2] });
  }
  return out;
}

function checkRoutesVsOpenAPI() {
  if (!fs.existsSync(OPENAPI)) {
    warn('openapi', 'openapi.yaml not found — skipping route coverage check.');
    return { expressRoutes: [], openapiPaths: [] };
  }
  const doc = yaml.load(fs.readFileSync(OPENAPI, 'utf8'));
  const openapiPaths = new Set(Object.keys(doc.paths || {}));

  const mounts = parseAppMounts();
  // Each Express route may resolve to multiple URLs because a routes file may
  // be `.use`d under several prefixes (e.g. leaderboard is mounted both at
  // `/leaderboard` and at root `/` so its `/challenges` lives at root). For
  // coverage purposes a route is "documented" if ANY of its possible URLs is
  // in openapi.yaml — we don't want to flag the duplicate.
  const expressRoutes = []; // { method, candidates: string[], sourceFile, relPath }

  for (const file of listRouteFiles()) {
    const fileBase = path.basename(file, '.ts');
    const prefixes = mounts[fileBase] || [''];
    const relRoutes = parseRoutesInFile(file);
    for (const r of relRoutes) {
      const candidates = prefixes.map(p => expressToOpenapi(joinPath(p, r.relPath)));
      expressRoutes.push({
        method: r.method,
        candidates,
        sourceFile: path.basename(file),
        relPath: r.relPath,
      });
    }
  }

  // Inline routes declared on v1Routes itself (no separate routes file).
  for (const r of parseInlineAppRoutes()) {
    const full = expressToOpenapi(r.relPath);
    expressRoutes.push({
      method: r.method,
      candidates: [full],
      sourceFile: 'app.ts (inline)',
      relPath: r.relPath,
    });
  }

  // Express → OpenAPI: documented if ANY candidate URL is in the spec.
  const docCovered = new Set();
  for (const r of expressRoutes) {
    const hit = r.candidates.find(c => openapiPaths.has(c));
    if (hit) {
      docCovered.add(hit);
    } else {
      err('routes.openapi.missing',
          `Express ${r.method} ${r.candidates[0]} (in ${r.sourceFile}) not documented in openapi.yaml`,
          r.candidates.length > 1
            ? `Tried alternates: ${r.candidates.slice(1).join(', ')}`
            : undefined);
    }
  }

  // OpenAPI → Express orphans: a path is an orphan only if NO Express route
  // has it in any of its candidate URLs.
  for (const p of openapiPaths) {
    if (docCovered.has(p)) continue;
    const matched = expressRoutes.some(r => r.candidates.includes(p));
    if (!matched) {
      warn('routes.openapi.orphan',
           `openapi.yaml documents ${p} but no Express route matches`);
    }
  }
  return { expressRoutes, openapiPaths: [...openapiPaths] };
}

// =============================================================================
// CHECK 3 — README/CLAUDE.md endpoint citations resolve to real routes
// =============================================================================
function checkDocCitations(expressRoutes) {
  const docs = [
    { name: 'README.md', path: README },
    { name: 'CLAUDE.md', path: CLAUDE },
  ];

  // Build the lookup of every valid (method, candidate-path) pair.
  // expressRoutes[].candidates is an array because of the dual-mount case.
  const valid = new Set();
  for (const r of expressRoutes) {
    for (const c of r.candidates) {
      valid.add(`${r.method} ${c}`);
      valid.add(`${r.method} ${c.replace(/^\/[a-z0-9_-]+\//, '/')}`); // also without first segment
    }
  }

  // Citation regex — we only want clean canonical forms inside backticks or as
  // section headers in tables. Reject:
  //   - paths that contain a literal comma or `{a,b}` shorthand (markdown union)
  //   - paths ending with a space-then-token (split tokenization)
  //   - example placeholders that aren't real UUIDs / IDs (e.g. "abc")
  const re = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9\/_:{}\-.]+)/g;

  for (const d of docs) {
    if (!fs.existsSync(d.path)) continue;
    const text = fs.readFileSync(d.path, 'utf8');
    const seen = new Set();

    for (const m of text.matchAll(re)) {
      const key = `${m[1]} ${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip obvious non-route citations
      const rawPath = m[2];
      if (/^\/etc|^\/Users|^\/var|^\/tmp|^\/Velo Projects/.test(rawPath)) continue;
      // Markdown shorthand like /auth/{google or /challenges/{projectId}/{claim — not a real path
      if (/\{[a-z_]+$/.test(rawPath) && !rawPath.endsWith('}')) continue;
      // Example placeholders — full UUIDs/IDs in docs use {projectId} etc.
      if (/\/(abc|xyz|foo|bar)(\/|$)/.test(rawPath)) continue;

      // Single-segment paths like `/lock`, `/unlock`, `/clone-policy` are
      // almost always markdown table shorthand for a longer route whose prefix
      // was established by the table header or surrounding context. If the
      // suffix appears at the end of any real route, accept it silently.
      const isSingleSegment = /^\/[A-Za-z0-9_-]+$/.test(rawPath);
      if (isSingleSegment) {
        const suffixHit = [...valid].some(v =>
          v.startsWith(`${m[1]} `) && v.endsWith(rawPath));
        if (suffixHit) continue;
      }

      // Normalize: strip /api/v1 prefix (with word boundary so /api-keys isn't
      // accidentally truncated to /-keys); convert :param → {param}.
      let normalized = rawPath
        .replace(/^\/api(\/v\d+)?(?=\/)/, '')   // require following slash
        .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
      const normalizedKey = `${m[1]} ${normalized}`;
      const altNoSlash    = normalizedKey.replace(/\/$/, '');
      const altWithSlash  = normalizedKey + '/';

      if (!valid.has(normalizedKey) && !valid.has(altNoSlash) && !valid.has(altWithSlash)) {
        warn('citations',
             `${d.name} mentions ${m[1]} ${rawPath} but no matching Express route found`,
             `Either remove the citation, fix the typo, or implement the endpoint.`);
      }
    }
  }
}

// =============================================================================
// CHECK 4 — SSE events: broadcast call sites vs docs
// =============================================================================
function grepFiles(dir, pattern, fileFilter = () => true) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
        stack.push(p);
      } else if (fileFilter(p)) {
        const text = fs.readFileSync(p, 'utf8');
        for (const m of text.matchAll(pattern)) out.push({ file: p, match: m });
      }
    }
  }
  return out;
}

function checkSSEEvents() {
  // Find all `.broadcast('event_name', …)` call sites
  const broadcasts = grepFiles(SRC_DIR,
    /\.broadcast\(\s*['"]([a-z_]+)['"]/g,
    p => p.endsWith('.ts'));
  const codeEvents = new Set(broadcasts.map(b => b.match[1]));

  // Strings to look in for documentation
  const docTexts = {};
  for (const p of [README, OPENAPI, CLAUDE]) {
    if (fs.existsSync(p)) docTexts[path.basename(p)] = fs.readFileSync(p, 'utf8');
  }

  for (const ev of [...codeEvents].sort()) {
    // Skip the dynamic / always-present infrastructure events
    if (['connected', 'clients'].includes(ev)) continue;

    const inAny = Object.entries(docTexts).some(([_, t]) =>
      new RegExp(`\\b${ev}\\b`).test(t));
    if (!inAny) {
      err('sse.events',
          `Event '${ev}' is broadcast in code but not documented in README, openapi.yaml, or CLAUDE.md`);
    }
  }
}

// =============================================================================
// CHECK 5 — Error codes thrown vs documented
// =============================================================================
function checkErrorCodes() {
  // Grep for AppError throws with explicit code strings: new AppError(msg, status, 'CODE')
  const re = /new AppError\(\s*[`'"][^`'"]*[`'"]\s*,\s*\d+\s*,\s*['"]([A-Z_]+)['"]/g;
  const re2 = /AppError\.(badRequest|forbidden|notFound|conflict|tooManyRequests|unauthorized)\s*\(/g;
  const codes = new Set();
  for (const m of grepFiles(SRC_DIR, re, p => p.endsWith('.ts'))) {
    codes.add(m.match[1]);
  }

  // Documented codes — these must appear at least once in openapi.yaml or README
  const openapiText = fs.existsSync(OPENAPI) ? fs.readFileSync(OPENAPI, 'utf8') : '';
  const readmeText  = fs.existsSync(README)  ? fs.readFileSync(README, 'utf8')  : '';
  const claudeText  = fs.existsSync(CLAUDE)  ? fs.readFileSync(CLAUDE, 'utf8')  : '';

  for (const code of [...codes].sort()) {
    // The trivial built-in codes are documented globally; only check our custom semantic codes
    if (['INTERNAL_ERROR', 'UNAUTHORIZED', 'BAD_REQUEST', 'FORBIDDEN', 'NOT_FOUND',
         'VALIDATION_ERROR', 'CONFLICT', 'RATE_LIMIT_EXCEEDED'].includes(code)) continue;
    const found = openapiText.includes(code) || readmeText.includes(code) || claudeText.includes(code);
    if (!found) {
      warn('errors.undocumented',
           `Error code '${code}' is thrown but never mentioned in README/openapi/CLAUDE`,
           `Add the code + meaning to whichever doc the consumer reads.`);
    }
  }
}

// =============================================================================
// CHECK 6 — Project columns referenced in code but not in any migration
// =============================================================================
function checkProjectColumns() {
  // Read 020_project.sql + every ALTER TABLE project ADD COLUMN
  const allMigText = fs.readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .join('\n');

  // Pull column names from CREATE TABLE project (...) and ADD COLUMN
  const cols = new Set();
  const createMatch = allMigText.match(/CREATE TABLE IF NOT EXISTS project \(([^;]+)\);/);
  if (createMatch) {
    for (const m of createMatch[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\s+/gm)) {
      cols.add(m[1]);
    }
  }
  for (const m of allMigText.matchAll(/ALTER TABLE project ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/g)) {
    cols.add(m[1]);
  }

  // Now scan model + service for column references that LOOK like project.{column}
  const refs = grepFiles(path.join(SERVER, 'src/models'),
    /\bproject\.([a-z_][a-z0-9_]*)/g, p => p.endsWith('project.model.ts'));
  for (const ref of refs) {
    const col = ref.match[1];
    if (col === 'value' || col === 'rows' || col === 'project_name' || cols.has(col)) continue;
    if (!cols.has(col)) {
      warn('schema.column',
           `project.model references project.${col} but no migration adds that column`,
           `Either fix the typo or add a migration.`);
    }
  }
}

// =============================================================================
// CHECK 7 — Version banner consistency
// =============================================================================
function checkVersionBanners() {
  if (!fs.existsSync(README) || !fs.existsSync(OPENAPI)) return;
  const readme = fs.readFileSync(README, 'utf8');
  const openapi = fs.readFileSync(OPENAPI, 'utf8');

  // README "Aligned with `server/openapi.yaml` v4.1.0"
  const align = readme.match(/Aligned with[^v]+v(\d+\.\d+\.\d+)/);
  const oapi  = openapi.match(/^\s*version:\s*(\d+\.\d+\.\d+)/m);
  if (align && oapi && align[1] !== oapi[1]) {
    err('version.banner',
        `README version banner says openapi v${align[1]}; openapi.yaml itself is v${oapi[1]}.`);
  }
}

// =============================================================================
// Run
// =============================================================================
const migInfo = checkMigrationCount();
if (FLAGS.migOnly) {
  emitAndExit();
}
const { expressRoutes } = checkRoutesVsOpenAPI();
checkDocCitations(expressRoutes);
checkSSEEvents();
checkErrorCodes();
checkProjectColumns();
checkVersionBanners();

emitAndExit();

function emitAndExit() {
  const errors = issues.filter(i => i.severity === 'error');
  const warns  = issues.filter(i => i.severity === 'warn');

  if (FLAGS.json) {
    const out = {
      ok: errors.length === 0,
      errorCount: errors.length,
      warnCount: warns.length,
      summary: {
        migrationsOnDisk: migInfo.onDisk,
      },
      issues,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    if (issues.length === 0) {
      console.log('docs-sync: ✅ no drift detected.');
      console.log(`  ${migInfo.onDisk} migrations on disk.`);
      process.exit(0);
    }
    if (errors.length) {
      console.log(`\ndocs-sync: ${errors.length} error(s):`);
      for (const i of errors) {
        console.log(`  ✘ [${i.category}] ${i.message}`);
        if (i.hint) console.log(`     → ${i.hint}`);
      }
    }
    if (warns.length) {
      console.log(`\ndocs-sync: ${warns.length} warning(s):`);
      for (const i of warns) {
        console.log(`  ⚠ [${i.category}] ${i.message}`);
      }
    }
    console.log('');
  }

  process.exit(errors.length > 0 ? 1 : 0);
}
