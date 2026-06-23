import { pool } from '../config/database';
import { env } from '../config/environment';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';
import * as gitService from './git.service';
import * as llmService from './llm-analysis.service';
import type { LlmProvider } from './llm-analysis.service';
import { deepAuditStreamManager } from '../sse/deep-audit-stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeepAuditOptions {
  branch?: string;
  maxFiles?: number;       // default 200
  maxContentKB?: number;   // default 500
  provider?: string;       // default 'claude'
  model?: string;
}

interface FileTreeEntry {
  path: string;
  size: number;
  extension: string;
}

// ---------------------------------------------------------------------------
// Exclusion lists
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = [
  'node_modules/', '.git/', 'dist/', 'build/', 'vendor/', '.next/',
  '__pycache__/', '.cache/', 'coverage/', '.nyc_output/', '.terraform/', '.angular/',
];

const EXCLUDED_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2',
  '.ttf', '.eot', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll',
  '.so', '.dylib', '.mp3', '.mp4', '.wav',
];

const EXCLUDED_FILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'composer.lock', 'Gemfile.lock', 'poetry.lock',
];

// ---------------------------------------------------------------------------
// callLlmForJson — generic JSON helper (no rigid schema)
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, context: string, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const status = error?.status || error?.statusCode || 0;
      if (status >= 400 && status < 500 && status !== 429) throw error;
      if (attempt === maxRetries) break;
      const delayMs = status === 429
        ? 15000 * Math.pow(2, attempt)
        : 2000 * Math.pow(3, attempt) + Math.random() * 3000;
      logger.warn(`[${context}] Retry ${attempt + 1}/${maxRetries} after ${Math.round(delayMs)}ms`, {
        error: (error as Error).message?.substring(0, 200),
      });
      await delay(delayMs);
    }
  }
  throw lastError;
}

function parseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
    const rawMatch = text.match(/[\[{][\s\S]*[\]}]/);
    if (rawMatch) return JSON.parse(rawMatch[0]);
    throw new Error(`Failed to parse JSON from LLM response: ${text.substring(0, 200)}`);
  }
}

/**
 * Call an LLM provider and return a parsed JSON object.
 * Unlike llmService.analyze(), this does NOT force the AuditAnalysisResult schema —
 * the caller controls the prompt and expected JSON shape.
 */
async function callLlmForJson(
  provider: string,
  model: string | undefined,
  prompt: string
): Promise<Record<string, unknown>> {
  switch (provider) {
    case 'claude':
      return callClaudeForJson(prompt, model);
    case 'gemini':
      return callGeminiForJson(prompt, model);
    case 'grok':
      return callGrokForJson(prompt, model);
    default:
      throw AppError.badRequest(`Unknown LLM provider: ${provider}`);
  }
}

// Tool schema for deep audit consolidation — forces structured JSON output
const DEEP_AUDIT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    scores: {
      type: 'object' as const,
      properties: {
        productionReadiness: { type: 'number' as const },
        codeQuality: { type: 'number' as const },
        testCoverage: { type: 'number' as const },
        codeCompleteness: { type: 'number' as const },
        securityPosture: { type: 'number' as const },
        documentationQuality: { type: 'number' as const },
        alignmentToRequirements: { type: 'number' as const },
      },
      required: ['productionReadiness', 'codeQuality', 'testCoverage', 'codeCompleteness', 'securityPosture', 'documentationQuality'],
    },
    findings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          category: { type: 'string' as const },
          severity: { type: 'string' as const, enum: ['critical', 'warning', 'info'] },
          title: { type: 'string' as const },
          description: { type: 'string' as const },
          evidence: { type: 'string' as const },
          files: { type: 'array' as const, items: { type: 'string' as const } },
        },
        required: ['category', 'severity', 'title', 'description'],
      },
    },
    recommendations: {
      type: 'object' as const,
      properties: {
        mustFix: { type: 'array' as const, items: { type: 'string' as const } },
        shouldFix: { type: 'array' as const, items: { type: 'string' as const } },
        niceToHave: { type: 'array' as const, items: { type: 'string' as const } },
      },
    },
    techStack: {
      type: 'object' as const,
      properties: {
        languages: { type: 'object' as const },
        frameworks: { type: 'array' as const, items: { type: 'string' as const } },
        testFrameworks: { type: 'array' as const, items: { type: 'string' as const } },
      },
    },
    summary: { type: 'string' as const },
    completenessAssessment: { type: 'string' as const },
    overallScore: { type: 'number' as const },
    completionEstimate: { type: 'number' as const },
  },
  required: ['scores', 'findings', 'recommendations', 'summary', 'overallScore'],
};

async function callClaudeForJson(prompt: string, model?: string): Promise<Record<string, unknown>> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.badRequest('ANTHROPIC_API_KEY is not configured');

  const selectedModel = model || 'claude-sonnet-4-6';

  return withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 64000,
        tools: [{
          name: 'deep_audit_report',
          description: 'Submit the consolidated deep audit report with scores, findings, and recommendations',
          input_schema: DEEP_AUDIT_TOOL_SCHEMA,
        }],
        tool_choice: { type: 'tool', name: 'deep_audit_report' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Claude API error (deep audit)', { status: res.status, body: errText.slice(0, 500) });
      const err: any = new Error(`Claude API error (${res.status})`);
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      content?: Array<{ type: string; name?: string; input?: Record<string, unknown>; text?: string }>;
    };

    // Tool use response — structured JSON guaranteed
    const toolBlock = data.content?.find(b => b.type === 'tool_use' && b.name === 'deep_audit_report');
    if (toolBlock?.input) return toolBlock.input;

    // Fallback: try text parsing
    const textBlock = data.content?.find(b => b.type === 'text');
    if (textBlock?.text) return parseJsonFromText(textBlock.text) as Record<string, unknown>;

    throw AppError.internal('Unexpected Claude response format');
  }, 'claude-deep-audit');
}

async function callGeminiForJson(prompt: string, model?: string): Promise<Record<string, unknown>> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw AppError.badRequest('GEMINI_API_KEY is not configured');

  const selectedModel = model || 'gemini-3.0-flash';

  return withRetry(async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt + '\n\nRespond with ONLY valid JSON.' }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 64000,
          },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Gemini API error (deep audit)', { status: res.status, body: errText.slice(0, 500) });
      const err: any = new Error(`Gemini API error (${res.status})`);
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw AppError.internal('Empty Gemini response');
    return parseJsonFromText(text) as Record<string, unknown>;
  }, 'gemini-deep-audit');
}

async function callGrokForJson(prompt: string, model?: string): Promise<Record<string, unknown>> {
  const apiKey = env.XAI_API_KEY;
  if (!apiKey) throw AppError.badRequest('XAI_API_KEY is not configured');

  const selectedModel = model || 'grok-3-mini-fast';

  return withRetry(async () => {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          { role: 'system', content: 'You are a project analytics expert. Always respond with valid JSON only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 64000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error('Grok API error (deep audit)', { status: res.status, body: errText.slice(0, 500) });
      const err: any = new Error(`Grok API error (${res.status})`);
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content;
    if (!text) throw AppError.internal('Empty Grok response');
    return parseJsonFromText(text) as Record<string, unknown>;
  }, 'grok-deep-audit');
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runDeepAuditAsync(
  auditId: string,
  projectId: string,
  repoUrl: string,
  userId?: string,
  options: DeepAuditOptions = {}
): Promise<void> {
  const maxFiles = options.maxFiles || 200;
  const maxContentKB = options.maxContentKB || 2000;
  const provider = (options.provider || 'claude') as LlmProvider;
  const model = options.model;
  const branch = options.branch || 'main';

  const emit = (event: string, data: unknown) =>
    deepAuditStreamManager.sendProgress(auditId, event, data);

  try {
    const parsed = gitService.parseRepoUrl(repoUrl);
    if (!parsed) throw new Error('Invalid GitHub URL');
    const token = await gitService.getGitHubToken(userId);
    const { owner, repo } = parsed;

    // ── Phase 1: Discovery ──────────────────────────────────────────────────
    emit('phase', { phase: 'discovery', status: 'started' });
    await updateAuditProgress(auditId, { currentPhase: 'discovery', status: 'running' });

    // Discover the default branch if not specified
    let actualBranch = branch;
    if (!options.branch) {
      try {
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'velo-deep-audit/1.0' },
        });
        if (repoRes.ok) {
          const repoData = (await repoRes.json()) as { default_branch?: string };
          actualBranch = repoData.default_branch || 'main';
          logger.info('Detected default branch', { owner, repo, branch: actualBranch });
        }
      } catch {
        // Fall back to trying common branch names
      }
    }

    // Use GitHub Trees API for recursive file listing — try the branch, fall back to common names
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let treeData: any = null;
    const branchesToTry = [actualBranch, 'main', 'master', 'dev', 'develop'].filter((v, i, a) => a.indexOf(v) === i);

    for (const tryBranch of branchesToTry) {
      const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(tryBranch)}?recursive=1`;
      const treeRes = await fetch(treeUrl, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'velo-deep-audit/1.0' },
      });
      if (treeRes.ok) {
        treeData = await treeRes.json();
        actualBranch = tryBranch;
        break;
      }
    }
    if (!treeData) throw new Error(`Could not access repository tree. Tried branches: ${branchesToTry.join(', ')}. Check that the repo exists and your PAT has access.`);
    if (treeData.truncated) {
      logger.warn('GitHub tree was truncated for large repo', { owner, repo });
    }

    const allFiles = (treeData.tree as any[]).filter((f: any) => f.type === 'blob');

    // Filter out binaries, lock files, generated dirs
    const filteredFiles: FileTreeEntry[] = allFiles
      .filter(f => {
        const lower = f.path.toLowerCase();
        if (EXCLUDED_DIRS.some(d => lower.includes(d))) return false;
        if (EXCLUDED_FILES.some(ef => lower.endsWith(ef))) return false;
        const ext = '.' + (f.path.split('.').pop()?.toLowerCase() || '');
        if (EXCLUDED_EXTENSIONS.includes(ext)) return false;
        return true;
      })
      .map(f => ({
        path: f.path,
        size: f.size || 0,
        extension: '.' + (f.path.split('.').pop() || 'unknown'),
      }));

    // Identify stubs and empties
    const stubFiles = filteredFiles.filter(f => f.size > 0 && f.size < 100);
    const emptyFiles = filteredFiles.filter(f => f.size === 0);

    emit('phase', {
      phase: 'discovery', status: 'completed',
      totalFiles: allFiles.length, filteredFiles: filteredFiles.length,
      stubFiles: stubFiles.length, emptyFiles: emptyFiles.length,
    });
    await updateAuditProgress(auditId, {
      currentPhase: 'selection',
      discovery: {
        totalFiles: allFiles.length, filteredFiles: filteredFiles.length,
        stubCount: stubFiles.length, emptyCount: emptyFiles.length,
      },
    });

    // ── Phase 2: AI File Selection ──────────────────────────────────────────
    emit('phase', { phase: 'selection', status: 'started' });

    const fileListForLLM = filteredFiles.map(f => `${f.path} (${f.size}B)`).join('\n');
    const selectionPrompt = `You are auditing a GitHub repository (${owner}/${repo}) for production readiness.

Here is the complete file tree (${filteredFiles.length} files):

${fileListForLLM.substring(0, 80000)}

Select files for a comprehensive production readiness audit. Be thorough — select as many files as needed (up to ${maxFiles}) to deeply understand the codebase. More coverage is better.

Include files from ALL of these categories that exist in the repo:
- ALL config files (package.json, tsconfig, vite/webpack config, .env.example, Dockerfile, CI/CD pipelines)
- ALL route/controller/handler files
- ALL service/business logic files
- ALL model/schema/migration files
- ALL test files (unit, integration, e2e)
- ALL middleware (auth, validation, error handling, security)
- Key frontend views and components
- Documentation (README, CHANGELOG, API docs, openapi specs)
- Utilities, helpers, and shared modules

If the repo has fewer than ${maxFiles} source files, select ALL of them. The goal is maximum coverage, not minimal selection.

Return ONLY a JSON object: { "selectedFiles": ["path1", "path2", ...], "rationale": "brief explanation" }`;

    let selectedPaths: string[] = [];
    let selectionRationale = '';

    try {
      const selectionResponse = await callLlmForJson(provider, model, selectionPrompt);
      if (selectionResponse.selectedFiles && Array.isArray(selectionResponse.selectedFiles)) {
        selectedPaths = (selectionResponse.selectedFiles as string[]).slice(0, maxFiles);
        selectionRationale = (selectionResponse.rationale as string) || '';
      }
    } catch (err: any) {
      logger.warn('LLM file selection failed, using heuristic', { error: err.message });
    }

    // Supplement: if LLM selected too few, fill remaining slots with heuristic
    if (selectedPaths.length < maxFiles) {
      const needed = maxFiles - selectedPaths.length;
      const alreadySelected = new Set(selectedPaths);
      const heuristicPaths = filteredFiles
        .filter(f => !alreadySelected.has(f.path))
        .sort((a, b) => {
          const score = (f: FileTreeEntry) => {
            const p = f.path.toLowerCase();
            if (p.includes('package.json') || p.includes('readme') || p.includes('changelog')) return 100;
            if (p.includes('test') || p.includes('spec') || p.includes('__tests__')) return 90;
            if (p.includes('config') || p.includes('.env') || p.includes('docker') || p.includes('ci')) return 85;
            if (p.includes('controller') || p.includes('handler') || p.includes('route')) return 80;
            if (p.includes('service') || p.includes('model') || p.includes('store')) return 75;
            if (p.includes('middleware') || p.includes('auth') || p.includes('security')) return 70;
            if (p.includes('migration') || p.includes('schema') || p.includes('seed')) return 65;
            if (p.includes('component') || p.includes('view') || p.includes('page')) return 60;
            if (p.endsWith('.ts') || p.endsWith('.js') || p.endsWith('.py') || p.endsWith('.go') || p.endsWith('.vue') || p.endsWith('.tsx')) return 50;
            if (p.endsWith('.css') || p.endsWith('.scss') || p.endsWith('.html')) return 30;
            if (p.endsWith('.md') || p.endsWith('.yaml') || p.endsWith('.yml') || p.endsWith('.json')) return 25;
            return 10;
          };
          return score(b) - score(a);
        })
        .slice(0, needed)
        .map(f => f.path);

      if (selectedPaths.length === 0) {
        selectionRationale = 'Heuristic selection (LLM selection returned no results)';
      } else {
        selectionRationale += ` | Supplemented with ${heuristicPaths.length} heuristic picks to reach ${maxFiles} target.`;
      }
      selectedPaths = [...selectedPaths, ...heuristicPaths];
      selectionRationale = 'Heuristic selection (LLM selection failed)';
    }

    emit('phase', {
      phase: 'selection', status: 'completed',
      selectedFiles: selectedPaths.length, rationale: selectionRationale,
    });
    await updateAuditProgress(auditId, {
      currentPhase: 'loading',
      selection: { selectedFiles: selectedPaths.length, rationale: selectionRationale },
    });

    // ── Phase 3: File Content Loading ───────────────────────────────────────
    emit('phase', { phase: 'loading', status: 'started' });

    const loadedFiles: Array<{ path: string; content: string; size: number }> = [];
    let totalContentBytes = 0;
    const maxContentBytes = maxContentKB * 1024;
    let skippedCount = 0;

    const CONCURRENCY = 5;
    for (let i = 0; i < selectedPaths.length; i += CONCURRENCY) {
      const batch = selectedPaths.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          if (totalContentBytes >= maxContentBytes) return null;
          try {
            const fileData = await gitService.getFileContent(token, owner, repo, actualBranch, filePath);
            const content = fileData.content;
            if (!content || content.length > 200 * 1024) {
              skippedCount++;
              return null;
            }
            return { path: filePath, content, size: content.length };
          } catch (fileErr: any) {
            if (skippedCount < 3) logger.warn('Deep audit file load failed', { path: filePath, error: fileErr.message?.substring(0, 200) });
            skippedCount++;
            return null;
          }
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          if (totalContentBytes + r.value.size <= maxContentBytes) {
            loadedFiles.push(r.value);
            totalContentBytes += r.value.size;
          }
        }
      }
      emit('progress', {
        phase: 'loading',
        current: Math.min(i + CONCURRENCY, selectedPaths.length),
        total: selectedPaths.length,
        loaded: loadedFiles.length,
        skipped: skippedCount,
      });
    }

    emit('phase', {
      phase: 'loading', status: 'completed',
      loadedFiles: loadedFiles.length, skippedFiles: skippedCount,
      totalContentKB: Math.round(totalContentBytes / 1024),
    });
    await updateAuditProgress(auditId, {
      currentPhase: 'analysis',
      loading: {
        loadedFiles: loadedFiles.length, skippedFiles: skippedCount,
        totalContentKB: Math.round(totalContentBytes / 1024),
      },
    });

    // ── Phase 4: Batched LLM Analysis ───────────────────────────────────────
    emit('phase', { phase: 'analysis', status: 'started' });

    const TOKEN_LIMIT = 100000; // ~100K tokens per batch
    const CHARS_PER_TOKEN = 4;
    const batches: Array<Array<{ path: string; content: string }>> = [];
    let currentBatch: Array<{ path: string; content: string }> = [];
    let currentBatchChars = 0;

    for (const file of loadedFiles) {
      if (currentBatchChars + file.content.length > TOKEN_LIMIT * CHARS_PER_TOKEN && currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchChars = 0;
      }
      currentBatch.push({ path: file.path, content: file.content });
      currentBatchChars += file.content.length;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    const batchResults: Array<Record<string, unknown>> = [];
    for (let i = 0; i < batches.length; i++) {
      emit('progress', {
        phase: 'analysis', current: i + 1, total: batches.length,
        detail: `Analyzing batch ${i + 1} (${batches[i].length} files)`,
      });

      const batchContent = batches[i]
        .map(f => `=== FILE: ${f.path} ===\n${f.content}\n`)
        .join('\n');

      const batchPrompt = `You are performing a deep production readiness audit of a software project.
Analyze these ${batches[i].length} files (batch ${i + 1} of ${batches.length}).

Evaluate:
1. Code quality (patterns, error handling, typing, naming)
2. Test coverage (presence of tests, quality of tests)
3. Security posture (auth, input validation, secrets management, SQL injection, XSS)
4. Code completeness (stubs, TODOs, incomplete implementations)
5. Documentation quality (comments, README, API docs)
6. Production readiness (logging, error handling, configuration, health checks)

Files:
${batchContent}

Return a JSON object with:
{
  "scores": { "codeQuality": 0-100, "testCoverage": 0-100, "securityPosture": 0-100, "codeCompleteness": 0-100, "documentationQuality": 0-100, "productionReadiness": 0-100 },
  "findings": [{ "category": "code-quality|test-coverage|security|completeness|documentation|production-readiness", "severity": "critical|warning|info", "title": "short title", "description": "detail", "evidence": "specific code reference", "files": ["affected file paths"] }],
  "techStack": { "languages": { "TypeScript": 60, "JavaScript": 20 }, "frameworks": ["Express", "Vue"], "testFrameworks": ["vitest"] }
}`;

      try {
        const result = await llmService.analyze(provider, batchPrompt, { batchIndex: i, fileCount: batches[i].length }, model);
        batchResults.push(result as unknown as Record<string, unknown>);
      } catch (err: any) {
        logger.error('Deep audit batch analysis failed', { auditId, batch: i, error: err.message });
        batchResults.push({
          scores: {},
          findings: [{
            category: 'error', severity: 'warning',
            title: `Batch ${i + 1} analysis failed`,
            description: err.message, evidence: '', files: [],
          }],
        });
      }
    }

    emit('phase', { phase: 'analysis', status: 'completed', batchesProcessed: batches.length });

    // ── Phase 5: Consolidation ──────────────────────────────────────────────
    emit('phase', { phase: 'consolidation', status: 'started' });
    await updateAuditProgress(auditId, { currentPhase: 'consolidation' });

    const consolidationPrompt = `You are producing the final consolidated deep audit report for a software project (${owner}/${repo}).

You analyzed ${loadedFiles.length} files across ${batches.length} batches. Here are the batch results:

${JSON.stringify(batchResults, null, 2)}

Repository stats: ${filteredFiles.length} total files, ${stubFiles.length} stub files (<100 bytes), ${emptyFiles.length} empty files.

Produce a FINAL consolidated report. Merge scores (weighted average), deduplicate findings, and provide:
{
  "scores": { "productionReadiness": 0-100, "codeQuality": 0-100, "testCoverage": 0-100, "codeCompleteness": 0-100, "securityPosture": 0-100, "documentationQuality": 0-100, "alignmentToRequirements": 0-100 },
  "findings": [{ "category": "...", "severity": "critical|warning|info", "title": "...", "description": "...", "evidence": "...", "files": [...] }],
  "recommendations": { "mustFix": ["..."], "shouldFix": ["..."], "niceToHave": ["..."] },
  "techStack": { "languages": {...}, "frameworks": [...], "testFrameworks": [...], "dependencies": {...} },
  "summary": "3-5 paragraph executive summary of production readiness",
  "completenessAssessment": "paragraph assessing actual completion vs reported completion",
  "overallScore": 0-100,
  "completionEstimate": 0-100
}`;

    let finalResult: Record<string, unknown>;
    try {
      finalResult = await callLlmForJson(provider, model, consolidationPrompt);
    } catch (err: any) {
      // Fallback: use the standard analyze() and cast
      logger.warn('callLlmForJson consolidation failed, falling back to analyze()', { error: err.message });
      const fallback = await llmService.analyze(provider, consolidationPrompt, { phase: 'consolidation' }, model);
      finalResult = fallback as unknown as Record<string, unknown>;
    }

    // Build the complete deep audit result
    const deepAuditResult = {
      deepAuditVersion: '1.0',
      phases: {
        discovery: {
          totalFiles: allFiles.length, filteredFiles: filteredFiles.length,
          stubFiles: stubFiles.map(f => ({ path: f.path, size: f.size })),
          emptyFiles: emptyFiles.map(f => f.path),
        },
        selection: {
          selectedFiles: selectedPaths.length,
          rationale: selectionRationale,
          paths: selectedPaths,
        },
        loading: {
          loadedFiles: loadedFiles.length, skippedFiles: skippedCount,
          totalContentKB: Math.round(totalContentBytes / 1024),
        },
        analysis: {
          batchesProcessed: batches.length,
          batchResults: batchResults.map((r, idx) => ({
            batch: idx + 1,
            fileCount: batches[idx]?.length || 0,
            findingsCount: Array.isArray(r.findings) ? r.findings.length : 0,
          })),
        },
      },
      scores: (finalResult.scores as Record<string, number>) || {},
      findings: (finalResult.findings as unknown[]) || [],
      recommendations: (finalResult.recommendations as Record<string, string[]>) || { mustFix: [], shouldFix: [], niceToHave: [] },
      techStack: (finalResult.techStack as Record<string, unknown>) || {},
      stubFiles: stubFiles.map(f => ({ path: f.path, size: f.size })),
      summary: (finalResult.summary as string) || '',
      completenessAssessment: (finalResult.completenessAssessment as string) || '',
      overallScore: (finalResult.overallScore as number) || 0,
      completionEstimate: (finalResult.completionEstimate as number) || 0,
    };

    // Save final result to DB
    const title = `Deep Audit — ${owner}/${repo} (${branch})`;
    const summary = `Analyzed ${loadedFiles.length}/${filteredFiles.length} files. Production readiness: ${deepAuditResult.overallScore}/100. ${deepAuditResult.findings.length} findings.`;

    await pool.query(
      `UPDATE project_audit
       SET audit_status = 'completed', audit_title = $1, audit_summary = $2,
           audit_data = $3, audit_ai_provider = $4, audit_ai_model = $5,
           audit_ai_score = $6, audit_ai_analysis = $7
       WHERE pk_project_audit = $8`,
      [
        title, summary,
        JSON.stringify(deepAuditResult),
        provider, model || null,
        deepAuditResult.overallScore || null,
        JSON.stringify(deepAuditResult.scores),
        auditId,
      ]
    );

    emit('phase', { phase: 'consolidation', status: 'completed' });
    emit('complete', { auditId, score: deepAuditResult.overallScore });
    logger.info('Deep audit completed', {
      auditId, score: deepAuditResult.overallScore,
      findings: deepAuditResult.findings.length,
    });

  } catch (err: any) {
    logger.error('Deep audit failed', {
      auditId, error: err.message,
      stack: err.stack?.substring(0, 500),
    });
    emit('error', { message: err.message, phase: 'unknown' });
    try {
      await pool.query(
        `UPDATE project_audit
         SET audit_status = 'failed', audit_summary = $1,
             audit_title = REPLACE(audit_title, '(running)', '(failed)')
         WHERE pk_project_audit = $2`,
        [err.message?.substring(0, 500), auditId]
      );
    } catch { /* best-effort DB update */ }
  } finally {
    // Clean up SSE connections after a delay to let clients receive final events
    setTimeout(() => deepAuditStreamManager.cleanup(auditId), 5000);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function updateAuditProgress(
  auditId: string,
  progress: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `UPDATE project_audit SET audit_data = audit_data || $1::jsonb WHERE pk_project_audit = $2`,
    [JSON.stringify(progress), auditId]
  ).catch(() => { /* best-effort progress update */ });
}
