import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';
import * as gitService from './git.service';
import * as llmService from './llm-analysis.service';
import type { LlmProvider } from './llm-analysis.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditRecord {
  pk_project_audit: string;
  fk_audit_project: string;
  fk_audit_module?: string | null;
  audit_source: string;
  audit_source_url: string | null;
  audit_data: Record<string, unknown>;
  audit_ai_analysis: Record<string, unknown> | null;
  audit_ai_provider: string | null;
  created_at: string;
  created_by: string | null;
}

interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a new project audit record.
 */
export async function createAudit(
  projectId: string,
  data: {
    source: string;
    sourceUrl?: string | null;
    moduleId?: string | null;
    title?: string;
    status?: string;
    auditData: Record<string, unknown>;
  },
  userId?: string
): Promise<AuditRecord> {
  const title = data.title || `${data.source} audit — ${new Date().toISOString().split('T')[0]}`;
  const status = data.status || 'completed';
  const result = await pool.query(
    `INSERT INTO project_audit (
      fk_audit_project,
      fk_audit_module,
      audit_source,
      audit_source_url,
      audit_title,
      audit_status,
      audit_data,
      created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      projectId,
      data.moduleId || null,
      data.source,
      data.sourceUrl || null,
      title,
      status,
      JSON.stringify(data.auditData),
      userId || null,
    ]
  );

  return result.rows[0];
}

/**
 * List audits for a project with pagination and optional source filter.
 */
export async function listAudits(
  projectId: string,
  page: number,
  limit: number,
  source?: string
): Promise<PaginatedResult<AuditRecord>> {
  const conditions = ['fk_audit_project = $1', 'is_deleted = false'];
  const params: unknown[] = [projectId];

  if (source) {
    conditions.push(`audit_source = $${params.length + 1}`);
    params.push(source);
  }

  const where = conditions.join(' AND ');
  const offset = (page - 1) * limit;

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM project_audit WHERE ${where}`, params),
    pool.query(
      `SELECT pk_project_audit, fk_audit_project, fk_audit_module,
              audit_source, audit_source_url, audit_title, audit_summary, audit_status,
              audit_ai_provider, audit_ai_model, audit_ai_score,
              audit_ai_analysis IS NOT NULL AS has_ai_analysis,
              created_at, created_by
       FROM project_audit
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);

  const total = countResult.rows[0].total;

  return {
    data: dataResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single audit with full data.
 */
export async function getAudit(auditId: string): Promise<AuditRecord> {
  const result = await pool.query(
    `SELECT * FROM project_audit WHERE pk_project_audit = $1`,
    [auditId]
  );

  if (result.rows.length === 0) {
    throw AppError.notFound('Audit not found');
  }

  return result.rows[0];
}

/**
 * Soft-delete an audit record.
 */
export async function deleteAudit(auditId: string): Promise<void> {
  await pool.query(
    `UPDATE project_audit SET is_deleted = true WHERE pk_project_audit = $1`,
    [auditId]
  );
}

/**
 * Run a Git audit asynchronously — updates an existing 'running' audit record with results.
 */
export async function runGitAuditAsync(
  auditId: string,
  projectId: string,
  repoUrl: string,
  userId?: string,
  options?: { branch?: string; maxCommits?: number; since?: string; moduleId?: string }
): Promise<void> {
  try {
    // Update status to running
    await pool.query(
      `UPDATE project_audit SET audit_status = 'running', audit_data = jsonb_set(audit_data, '{status}', '"extracting"') WHERE pk_project_audit = $1`,
      [auditId]
    );

    const parsed = gitService.parseRepoUrl(repoUrl);
    if (!parsed) {
      await pool.query(
        `UPDATE project_audit SET audit_status = 'failed', audit_summary = 'Invalid GitHub URL' WHERE pk_project_audit = $1`,
        [auditId]
      );
      return;
    }

    const token = await gitService.getGitHubToken(userId);

    logger.info('Starting async Git audit extraction', { auditId, repo: `${parsed.owner}/${parsed.repo}` });

    // Wrap extraction in a timeout (5 minutes max)
    const extractionPromise = gitService.fullExtraction(token, parsed.owner, parsed.repo, {
      branch: options?.branch,
      maxCommits: options?.maxCommits,
      since: options?.since,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Git extraction timed out after 5 minutes')), 300000)
    );
    const extraction = await Promise.race([extractionPromise, timeoutPromise]);

    const meta = extraction.meta as any;
    const health = extraction.projectHealth as any;
    const contribCount = extraction.contributors ? Object.keys(extraction.contributors).length : 0;
    const title = `Git Audit — ${parsed.owner}/${parsed.repo} (${meta?.branch || 'main'})`;
    const summary = `${meta?.totalCommitsProcessed || 0} commits, ${health?.totalPRs || 0} PRs (${health?.totalMergedPRs || 0} merged), ${contribCount} contributors, ${health?.totalBranches || 0} branches`;

    await pool.query(
      `UPDATE project_audit
       SET audit_status = 'completed', audit_title = $1, audit_summary = $2,
           audit_data = $3, audit_source_url = $4
       WHERE pk_project_audit = $5`,
      [title, summary, JSON.stringify(extraction), repoUrl, auditId]
    );

    logger.info('Async Git audit completed', { auditId, commits: meta?.totalCommitsProcessed, contributors: contribCount });
  } catch (err: any) {
    const errorMsg = err?.message || err?.toString() || 'Unknown error';
    logger.error('Async Git audit failed', { auditId, error: errorMsg, stack: err?.stack?.substring(0, 500) });
    try {
      await pool.query(
        `UPDATE project_audit SET audit_status = 'failed', audit_summary = $1, audit_title = REPLACE(audit_title, '(running)', '(failed)') WHERE pk_project_audit = $2`,
        [errorMsg.substring(0, 500), auditId]
      );
    } catch (dbErr: any) {
      logger.error('Failed to update audit status to failed', { auditId, dbError: dbErr.message });
    }
  }
}

/**
 * Run a Git audit synchronously (legacy) — creates and returns the audit record.
 */
export async function runGitAudit(
  projectId: string,
  repoUrl: string,
  userId?: string,
  options?: { branch?: string; maxCommits?: number; since?: string; moduleId?: string }
): Promise<AuditRecord> {
  // Validate project exists
  const projectCheck = await pool.query(
    `SELECT pk_project FROM project WHERE pk_project = $1 AND is_deleted = false`,
    [projectId]
  );
  if (projectCheck.rows.length === 0) {
    throw AppError.notFound('Project not found');
  }

  // Parse repo URL
  const parsed = gitService.parseRepoUrl(repoUrl);
  if (!parsed) {
    throw AppError.badRequest('Invalid GitHub repository URL');
  }

  // Get token
  const token = await gitService.getGitHubToken(userId);

  // Run full extraction
  logger.info('Starting Git audit extraction', { projectId, repo: `${parsed.owner}/${parsed.repo}` });

  const extraction = await gitService.fullExtraction(token, parsed.owner, parsed.repo, {
    branch: options?.branch,
    maxCommits: options?.maxCommits,
    since: options?.since,
  });

  // Build summary from extraction
  const meta = extraction.meta as any;
  const health = extraction.projectHealth as any;
  const contribCount = extraction.contributors ? Object.keys(extraction.contributors).length : 0;
  const title = `Git Audit — ${parsed.owner}/${parsed.repo} (${meta?.branch || 'main'})`;
  const summary = `${meta?.totalCommitsProcessed || 0} commits, ${health?.totalPRs || 0} PRs (${health?.totalMergedPRs || 0} merged), ${contribCount} contributors, ${health?.totalBranches || 0} branches`;

  // Store audit
  const audit = await createAudit(
    projectId,
    {
      source: 'git',
      sourceUrl: repoUrl,
      moduleId: options?.moduleId,
      title,
      auditData: extraction as unknown as Record<string, unknown>,
    },
    userId
  );

  // Update summary (createAudit doesn't support it directly)
  await pool.query(
    `UPDATE project_audit SET audit_summary = $1 WHERE pk_project_audit = $2`,
    [summary, audit.pk_project_audit]
  );

  logger.info('Git audit completed', {
    projectId,
    auditId: audit.pk_project_audit,
    commits: (extraction.meta as any).totalCommitsProcessed,
    contributors: Object.keys(extraction.contributors).length,
  });

  return audit;
}

/**
 * Run LLM analysis on an existing audit record.
 */
export async function runLlmAnalysis(
  auditId: string,
  provider: LlmProvider,
  prompt?: string,
  model?: string,
): Promise<AuditRecord> {
  // Get existing audit
  const audit = await getAudit(auditId);

  // Prepare analysis data (project health + contributor summaries)
  const auditData = audit.audit_data as Record<string, unknown>;
  const analysisInput = {
    projectHealth: auditData.projectHealth,
    contributorCount: auditData.contributors ? Object.keys(auditData.contributors as object).length : 0,
    contributorSummaries: auditData.contributors
      ? Object.entries(auditData.contributors as Record<string, any>)
          .slice(0, 20)
          .map(([login, c]) => ({
            login,
            compositeScore: c.compositeScore,
            commits: c.commits?.length || 0,
            totalAdditions: c.totalAdditions,
            totalDeletions: c.totalDeletions,
            prsAuthored: c.totalPRsAuthored,
            prsReviewed: c.totalPRsReviewed,
            avgMsgQuality: c.avgMsgQuality,
          }))
      : [],
    prTypeDist: (auditData.projectHealth as any)?.prTypeDist,
    reviewerStats: auditData.reviewerStats,
    meta: auditData.meta,
  };

  // Run analysis — if a custom prompt with embedded data is provided (e.g., project-level audit),
  // pass the prompt directly and use minimal context. Otherwise, use the structured git analysis input.
  logger.info('Running LLM analysis', { auditId, provider });
  const useCustomPrompt = prompt && prompt.length > 500; // Project-level audits have long prompts with data
  const analysis = await llmService.analyze(
    provider,
    prompt || '',
    useCustomPrompt ? { source: audit.audit_source } : analysisInput,
    model
  );

  // Update audit record with LLM analysis
  // Build the title for project-level audits
  const aiTitle = `Project Audit — ${provider} (${new Date().toISOString().split('T')[0]})`;

  const result = await pool.query(
    `UPDATE project_audit
     SET audit_ai_analysis = $1, audit_ai_provider = $2, audit_ai_model = $3,
         audit_ai_score = $4,
         audit_summary = CASE WHEN audit_summary IS NULL OR audit_summary = '' THEN $5 ELSE audit_summary || ' | AI: ' || $5 END,
         audit_title = CASE WHEN audit_source = 'manual' THEN $7 ELSE audit_title END,
         audit_status = 'completed'
     WHERE pk_project_audit = $6
     RETURNING *`,
    [JSON.stringify(analysis), provider, model || null, analysis.overallScore || null, analysis.summary?.substring(0, 200) || '', auditId, aiTitle]
  );

  logger.info('LLM analysis completed', {
    auditId,
    provider,
    overallScore: analysis.overallScore,
    findingsCount: analysis.findings.length,
  });

  return result.rows[0];
}
