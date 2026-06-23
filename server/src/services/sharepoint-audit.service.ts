import { pool } from '../config/database';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';
import * as sharepointService from './sharepoint.service';
import * as sharepointModel from '../models/sharepoint.model';
import * as llmService from './llm-analysis.service';
import type { LlmProvider } from './llm-analysis.service';
import { sharepointAuditStreamManager } from '../sse/sharepoint-audit-stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileInventoryItem {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  mimeType: string;
  itemId: string;
  webUrl: string;
  createdBy?: string;
  lastModifiedBy?: string;
}

interface DeepAuditOptions {
  provider?: string;
  model?: string;
  maxFiles?: number;       // default 100
  maxContentKB?: number;   // default 300 per file
}

// Text-readable extensions for content analysis
const READABLE_EXTENSIONS = new Set([
  'md', 'txt', 'csv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm',
  'doc', 'docx', 'rtf', 'log', 'ini', 'cfg', 'conf', 'properties',
  'ts', 'js', 'py', 'java', 'go', 'rs', 'sql', 'sh', 'bat', 'ps1',
  'css', 'scss', 'less', 'vue', 'jsx', 'tsx', 'svelte',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp',
  'pdf', 'zip', 'tar', 'gz', 'rar', '7z',
  'mp3', 'mp4', 'wav', 'avi', 'mov',
  'exe', 'dll', 'so', 'bin',
  'woff', 'woff2', 'ttf', 'eot',
  'pptx', 'xlsx', // binary Office formats (content not extractable via Graph text)
]);

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, context: string, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        const backoff = 1000 * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn(`Retry ${attempt + 1}/${maxRetries} for ${context}`, { error: error?.message });
        await delay(backoff);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Run SharePoint Deep Audit (5-phase pipeline)
// ---------------------------------------------------------------------------

export async function runSharePointAuditAsync(
  projectId: string,
  userId?: string,
  options: DeepAuditOptions = {}
): Promise<string> {
  const projRes = await pool.query(
    'SELECT pk_project, project_name FROM project WHERE pk_project = $1 AND is_deleted = false',
    [projectId]
  );
  if (projRes.rows.length === 0) throw AppError.notFound('Project not found');
  const project = projRes.rows[0];

  // Get project metadata for the analysis (modules, velocity steps)
  const moduleRes = await pool.query(
    `SELECT m.pk_module, m.module_name, m.module_status, m.module_description,
            m.module_complexity, m.module_is_mission_critical
     FROM module m WHERE m.fk_module_project = $1 AND m.is_deleted = false
     ORDER BY m.module_name`,
    [projectId]
  );
  const modules = moduleRes.rows;

  const auditRes = await pool.query(
    `INSERT INTO project_audit (fk_audit_project, audit_source, audit_status, audit_title, created_by)
     VALUES ($1, 'sharepoint-content', 'running', $2, $3)
     RETURNING pk_project_audit`,
    [projectId, `SharePoint Deep Audit — ${project.project_name}`, userId]
  );
  const auditId = auditRes.rows[0].pk_project_audit;

  // Run the 5-phase pipeline in background
  runPipeline(auditId, projectId, project.project_name, modules, options).catch((err) => {
    logger.error('SharePoint deep audit pipeline failed', { auditId, error: (err as Error).message });
    pool.query(
      `UPDATE project_audit SET audit_status = 'error', audit_ai_analysis = $1 WHERE pk_project_audit = $2`,
      [JSON.stringify({ error: (err as Error).message }), auditId]
    ).catch(() => {});
    sharepointAuditStreamManager.close(auditId);
  });

  return auditId;
}

// ---------------------------------------------------------------------------
// 5-Phase Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(
  auditId: string,
  projectId: string,
  projectName: string,
  modules: any[],
  options: DeepAuditOptions
): Promise<void> {
  const broadcast = (phase: string, detail: string, progress?: number) => {
    sharepointAuditStreamManager.broadcast(auditId, 'progress', { phase, detail, progress });
  };

  try {
    // ═══ PHASE 1: DISCOVERY — Enumerate all SharePoint folders and files ═══
    broadcast('discovery', 'Enumerating SharePoint folders and files...', 5);

    let folders = await sharepointModel.findByProject(projectId);
    if (folders.length === 0) {
      broadcast('discovery', 'No folders tracked — creating project hierarchy...', 8);
      await sharepointService.ensureProjectHierarchy(projectId);
      folders = await sharepointModel.findByProject(projectId);
    }

    broadcast('discovery', `Found ${folders.length} tracked folders. Listing files...`, 10);

    const allFiles: FileInventoryItem[] = [];
    const emptyFolders: string[] = [];

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      try {
        const files = await sharepointService.listFiles(folder.sp_folder_id);
        const fileItems = files.filter(f => !f.folder);
        if (fileItems.length === 0) emptyFolders.push(folder.sp_folder_path);
        for (const file of fileItems) {
          allFiles.push({
            name: file.name,
            path: `${folder.sp_folder_path}/${file.name}`,
            size: file.size || 0,
            lastModified: file.lastModifiedDateTime || '',
            mimeType: file.file?.mimeType || 'unknown',
            itemId: file.id,
            webUrl: file.webUrl || '',
            createdBy: file.createdBy?.user?.displayName || '',
            lastModifiedBy: file.lastModifiedBy?.user?.displayName || '',
          });
        }
      } catch (err) {
        logger.warn('Failed to list SP folder', { path: folder.sp_folder_path, error: (err as Error).message });
      }
      broadcast('discovery', `Scanned ${i + 1}/${folders.length} folders (${allFiles.length} files)`, 10 + Math.round((i / folders.length) * 10));
    }

    broadcast('discovery', `Discovery complete: ${allFiles.length} files in ${folders.length} folders`, 20);

    // ═══ PHASE 2: SELECTION — Pick files to read content from ═══
    broadcast('selection', 'Selecting files for content analysis...', 25);

    const maxFiles = options.maxFiles || 100;
    const readableFiles = allFiles.filter(f => {
      const ext = f.name.split('.').pop()?.toLowerCase() || '';
      return READABLE_EXTENSIONS.has(ext) && f.size > 0 && f.size < 500 * 1024; // skip >500KB
    });

    // Prioritize: requirements, architecture, plans, key docs
    const prioritized = readableFiles.sort((a, b) => {
      const scoreA = filePriority(a);
      const scoreB = filePriority(b);
      return scoreB - scoreA;
    });

    const selectedFiles = prioritized.slice(0, maxFiles);
    broadcast('selection', `Selected ${selectedFiles.length} of ${allFiles.length} files for content reading`, 30);

    // ═══ PHASE 3: LOADING — Read file content in batches ═══
    broadcast('loading', `Loading content from ${selectedFiles.length} files...`, 35);

    const BATCH_SIZE = 5;
    const fileContents: { path: string; name: string; content: string; size: number }[] = [];
    let totalContentSize = 0;
    const maxContentKB = options.maxContentKB || 300;

    for (let i = 0; i < selectedFiles.length; i += BATCH_SIZE) {
      const batch = selectedFiles.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(f => withRetry(
          () => sharepointService.getFileContent(f.itemId),
          `load:${f.name}`,
          2
        ))
      );

      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled' && result.value) {
          const content = result.value;
          // Truncate individual files to maxContentKB
          const truncated = content.length > maxContentKB * 1024
            ? content.substring(0, maxContentKB * 1024) + '\n\n[... truncated]'
            : content;
          fileContents.push({
            path: batch[j].path,
            name: batch[j].name,
            content: truncated,
            size: batch[j].size,
          });
          totalContentSize += truncated.length;
        }
      }

      const pct = 35 + Math.round((Math.min(i + BATCH_SIZE, selectedFiles.length) / selectedFiles.length) * 25);
      broadcast('loading', `Loaded ${fileContents.length}/${selectedFiles.length} files (${(totalContentSize / 1024).toFixed(0)} KB)`, pct);

      // Small delay to avoid rate limiting
      if (i + BATCH_SIZE < selectedFiles.length) await delay(200);
    }

    broadcast('loading', `Content loaded: ${fileContents.length} files, ${(totalContentSize / 1024).toFixed(0)} KB total`, 60);

    // ═══ PHASE 4: ANALYSIS — LLM analyzes content against project metadata ═══
    const provider = (options.provider || 'claude') as LlmProvider;
    broadcast('analysis', `Running AI analysis with ${provider}...`, 65);

    // Build the comprehensive inventory summary
    const inventorySummary = buildInventorySummary(allFiles, emptyFolders);

    // Build the analysis prompt with project context
    const analysisPrompt = buildDeepAnalysisPrompt(projectName, modules, inventorySummary, fileContents);

    let llmResult: any = null;
    try {
      llmResult = await withRetry(
        () => llmService.analyze(provider, analysisPrompt, { files: fileContents.length, totalSize: totalContentSize }, options.model),
        'llm-analysis',
        2
      );
      broadcast('analysis', 'AI analysis complete', 85);
    } catch (err) {
      logger.error('LLM analysis failed', { error: (err as Error).message });
      broadcast('analysis', `AI analysis failed: ${(err as Error).message}`, 85);
      llmResult = { error: (err as Error).message };
    }

    // ═══ PHASE 5: CONSOLIDATION — Save results ═══
    broadcast('consolidation', 'Saving audit results...', 90);

    const auditData = {
      sharepoint: {
        summary: inventorySummary,
        emptyFolders,
        inventory: allFiles.map(f => ({ name: f.name, path: f.path, size: f.size, lastModified: f.lastModified, mimeType: f.mimeType, webUrl: f.webUrl })),
        filesAnalyzed: fileContents.length,
        totalContentKB: Math.round(totalContentSize / 1024),
      },
      modules: modules.map(m => ({ name: m.module_name, status: m.module_status, complexity: m.module_complexity, missionCritical: m.module_is_mission_critical })),
    };

    const llmAnalysis = llmResult ? (typeof llmResult === 'string' ? llmResult : JSON.stringify(llmResult)) : null;

    await pool.query(
      `UPDATE project_audit
       SET audit_status = 'completed',
           audit_git_analytics = $1,
           audit_ai_analysis = $2,
           updated_at = NOW()
       WHERE pk_project_audit = $3`,
      [JSON.stringify(auditData), llmAnalysis, auditId]
    );

    broadcast('done', `SharePoint deep audit complete: ${allFiles.length} files discovered, ${fileContents.length} analyzed`, 100);
    sharepointAuditStreamManager.close(auditId);

  } catch (err) {
    await pool.query(
      `UPDATE project_audit SET audit_status = 'error', audit_ai_analysis = $1 WHERE pk_project_audit = $2`,
      [JSON.stringify({ error: (err as Error).message }), auditId]
    ).catch(() => {});
    sharepointAuditStreamManager.close(auditId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Priority scoring for file selection (higher = more important to read) */
function filePriority(f: FileInventoryItem): number {
  let score = 0;
  const lower = f.path.toLowerCase();
  const name = f.name.toLowerCase();

  // Key document types
  if (name.includes('requirement')) score += 50;
  if (name.includes('architecture')) score += 50;
  if (name.includes('design')) score += 40;
  if (name.includes('plan')) score += 40;
  if (name.includes('charter')) score += 45;
  if (name.includes('scope')) score += 40;
  if (name.includes('budget')) score += 35;
  if (name.includes('risk')) score += 35;
  if (name.includes('test')) score += 30;
  if (name.includes('deploy')) score += 30;
  if (name.includes('acceptance')) score += 45;
  if (name.includes('sign-off') || name.includes('signoff')) score += 45;
  if (name.includes('status') || name.includes('report')) score += 30;
  if (name.includes('readme') || name === 'readme.md') score += 35;
  if (name.includes('audit')) score += 40;
  if (name.includes('decision')) score += 30;
  if (name.includes('prototype')) score += 25;

  // Folder context
  if (lower.includes('/requirements/')) score += 20;
  if (lower.includes('/architecture/')) score += 20;
  if (lower.includes('/planning/')) score += 20;
  if (lower.includes('/deployment/')) score += 15;
  if (lower.includes('/user_testing/') || lower.includes('/user testing/')) score += 15;
  if (lower.includes('/user_acceptance/') || lower.includes('/user acceptance/')) score += 15;

  // Prefer smaller files (more likely to be actual documents, not data dumps)
  if (f.size < 50 * 1024) score += 10;
  if (f.size > 200 * 1024) score -= 5;

  // Prefer recently modified
  if (f.lastModified) {
    const age = Date.now() - new Date(f.lastModified).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) score += 15; // last 7 days
    if (age < 30 * 24 * 60 * 60 * 1000) score += 10; // last 30 days
  }

  // Markdown and text docs are highest value
  const ext = f.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'md') score += 20;
  if (ext === 'txt') score += 10;
  if (['doc', 'docx'].includes(ext)) score += 15;

  return score;
}

function buildInventorySummary(files: FileInventoryItem[], emptyFolders: string[]) {
  const now = Date.now();
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const totalSizeBytes = files.reduce((sum, f) => sum + f.size, 0);
  const filesByType: Record<string, number> = {};
  const filesByFolder: Record<string, number> = {};
  let staleCount = 0;
  let recentCount = 0;

  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() || 'unknown';
    filesByType[ext] = (filesByType[ext] || 0) + 1;
    const folder = f.path.split('/').slice(0, -1).join('/');
    filesByFolder[folder] = (filesByFolder[folder] || 0) + 1;
    if (f.lastModified) {
      const modTime = new Date(f.lastModified).getTime();
      if (now - modTime > NINETY_DAYS) staleCount++;
      if (now - modTime < SEVEN_DAYS) recentCount++;
    }
  }

  return {
    totalFiles: files.length,
    totalSizeMB: (totalSizeBytes / (1024 * 1024)).toFixed(2),
    filesByType,
    filesByFolder,
    staleFileCount: staleCount,
    recentFileCount: recentCount,
    emptyFolderCount: emptyFolders.length,
  };
}

function buildDeepAnalysisPrompt(
  projectName: string,
  modules: any[],
  summary: any,
  fileContents: { path: string; name: string; content: string; size: number }[]
): string {
  const moduleContext = modules.map(m =>
    `- **${m.module_name}** (status: ${m.module_status}, complexity: ${m.module_complexity || 1}, mission critical: ${m.module_is_mission_critical ? 'YES' : 'no'})`
  ).join('\n');

  const fileList = fileContents.map(f =>
    `### ${f.path} (${(f.size / 1024).toFixed(1)} KB)\n\`\`\`\n${f.content.substring(0, 3000)}\n\`\`\``
  ).join('\n\n');

  return `You are performing a deep content audit of the SharePoint document repository for project "${projectName}".

## Project Modules
${moduleContext || 'No modules defined yet.'}

## Expected Folder Structure
Each module should have folders for the 8 velocity steps:
requirements, planning, architecture, prototyping, development, user_testing, user_acceptance, deployment

## Repository Summary
- **Total files:** ${summary.totalFiles}
- **Total size:** ${summary.totalSizeMB} MB
- **Stale files (90+ days):** ${summary.staleFileCount}
- **Recent files (7 days):** ${summary.recentFileCount}
- **Empty folders:** ${summary.emptyFolderCount}
- **Files by type:** ${JSON.stringify(summary.filesByType)}
- **Files by folder:** ${JSON.stringify(summary.filesByFolder)}

## File Contents (${fileContents.length} files analyzed)

${fileList}

---

## Your Analysis Tasks

Analyze this document repository and produce a structured JSON response with these sections:

1. **overallScore** (0-100): How complete and well-organized is this repository?

2. **moduleCompleteness**: For EACH module, assess which velocity step folders have adequate documentation:
   - For each step (requirements, planning, architecture, prototyping, development, user_testing, user_acceptance, deployment):
     - **present**: boolean — are there relevant documents?
     - **quality**: "none" | "minimal" | "adequate" | "comprehensive"
     - **files**: list of relevant filenames
     - **gaps**: what's missing?

3. **keyArtifacts**: Assessment of critical document types across the project:
   - requirements_docs: { present: boolean, quality: string, files: string[] }
   - architecture_docs: { present: boolean, quality: string, files: string[] }
   - project_charter: { present: boolean, quality: string, files: string[] }
   - test_plans: { present: boolean, quality: string, files: string[] }
   - deployment_docs: { present: boolean, quality: string, files: string[] }
   - sign_off_docs: { present: boolean, quality: string, files: string[] }
   - risk_register: { present: boolean, quality: string, files: string[] }

4. **contentQuality**: For the files you read:
   - Are documents well-structured?
   - Is content current and relevant?
   - Are there contradictions or outdated information?

5. **recommendations**: Array of specific, actionable recommendations:
   - { priority: "critical" | "high" | "medium" | "low", category: string, recommendation: string }

6. **complianceReadiness**: Would this repository pass a formal audit?
   - score (0-100)
   - gaps: string[]
   - strengths: string[]

Return valid JSON only.`;
}

// ---------------------------------------------------------------------------
// Export Audit to SharePoint
// ---------------------------------------------------------------------------

export async function exportAuditToSharePoint(
  auditId: string,
  projectId: string
): Promise<{ webUrl: string; filename: string }> {
  const auditRes = await pool.query(
    'SELECT * FROM project_audit WHERE pk_project_audit = $1',
    [auditId]
  );
  if (auditRes.rows.length === 0) throw AppError.notFound('Audit not found');
  const audit = auditRes.rows[0];

  const analytics = audit.audit_git_analytics ? JSON.parse(audit.audit_git_analytics) : {};
  const sp = analytics.sharepoint || {};
  const summary = sp.summary || {};

  let report = `# SharePoint Content Audit Report\n\n`;
  report += `**Project:** ${audit.audit_title || 'Unknown'}\n`;
  report += `**Date:** ${new Date().toISOString().split('T')[0]}\n`;
  report += `**Status:** ${audit.audit_status}\n`;
  report += `**Files Discovered:** ${summary.totalFiles || 0}\n`;
  report += `**Files Analyzed:** ${sp.filesAnalyzed || 0}\n`;
  report += `**Content Read:** ${sp.totalContentKB || 0} KB\n\n`;

  report += `## Summary\n\n`;
  report += `| Metric | Value |\n|--------|-------|\n`;
  report += `| Total Files | ${summary.totalFiles || 0} |\n`;
  report += `| Total Size | ${summary.totalSizeMB || 0} MB |\n`;
  report += `| Stale Files (90+ days) | ${summary.staleFileCount || 0} |\n`;
  report += `| Recent Files (7 days) | ${summary.recentFileCount || 0} |\n`;
  report += `| Empty Folders | ${summary.emptyFolderCount || 0} |\n\n`;

  if (summary.filesByType) {
    report += `## Files by Type\n\n`;
    for (const [ext, count] of Object.entries(summary.filesByType)) {
      report += `- .${ext}: ${count}\n`;
    }
    report += '\n';
  }

  if (audit.audit_ai_analysis) {
    report += `## AI Deep Analysis\n\n`;
    try {
      const analysis = JSON.parse(audit.audit_ai_analysis);
      report += '```json\n' + JSON.stringify(analysis, null, 2) + '\n```\n\n';
    } catch {
      report += audit.audit_ai_analysis + '\n\n';
    }
  }

  report += `\n---\n*Generated by Velo — Project Tool for AI*\n`;

  const filename = `sharepoint-deep-audit-${new Date().toISOString().split('T')[0]}.md`;
  const result = await sharepointService.uploadAuditReport(projectId, filename, report);

  return { webUrl: result.webUrl || '', filename };
}
