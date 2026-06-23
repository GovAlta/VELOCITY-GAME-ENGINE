/**
 * AI Processing Queue — Database-Backed State Machine
 *
 * Replaces the in-memory queue with a PostgreSQL-backed job system.
 * Each source file gets a parent job; each vision API call (PDF page,
 * embedded image) gets a child sub-job. Survives server restarts,
 * supports per-sub-artifact retry with backoff, and broadcasts
 * state transitions over SSE.
 *
 * Architecture:
 *   enqueue() → INSERT job (status=queued) → tickDrain()
 *     → Claim parent job → download → split → INSERT sub-jobs
 *     → tickSubJobs() → claim sub-job → callVision → store result
 *     → all done? → merge markdowns → upload shadow → complete
 */

import logger from '../utils/logger';
import * as aiModel from '../models/ai-processing.model';
import * as aiFileProcessor from './ai-file-processor.service';
import * as sharepointService from './sharepoint.service';
import { velocityStreamManager } from '../sse/velocity-stream';
import { memoryPressure } from '../utils/memory-pressure';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DRAIN_INTERVAL_MS = 5000;
const MAX_CONCURRENT_VISION = 10;

let drainTimer: ReturnType<typeof setInterval> | null = null;
let isDraining = false;

/** In-memory buffer map: sub-job PK → binary data for vision API.
 *  Populated when parent job splits; consumed when sub-job processes.
 *  Lost on restart — parent job re-queues and re-splits. */
const bufferMap = new Map<string, Buffer>();

// ---------------------------------------------------------------------------
// Public API (signatures preserved for callers)
// ---------------------------------------------------------------------------

/**
 * Enqueue a single file for background AI processing.
 * Silently skips non-processable files. Dedup enforced by DB unique index.
 */
export function enqueue(
  spFolderId: string,
  itemId: string,
  filename: string,
  provider?: 'gemini' | 'claude',
  model?: string,
): void {
  if (!aiFileProcessor.shouldProcess(filename)) return;

  const fileType = aiFileProcessor.getFileType(filename);
  if (!fileType) return;

  aiModel.createJob({
    sp_folder_id: spFolderId,
    sp_item_id: itemId,
    filename,
    file_type: fileType,
    vision_provider: provider,
    vision_model: model,
  }).then(job => {
    if (job) {
      logger.info('AI queue: enqueued', { filename, jobId: job.pk_ai_processing_job.substring(0, 8) });
      tickDrain();
    }
  }).catch(err => {
    logger.error('AI queue: enqueue failed', { filename, error: (err as Error).message });
  });
}

/**
 * Enqueue multiple files from a folder listing (after ZIP import, etc.).
 */
export function enqueueMany(
  spFolderId: string,
  items: Array<{ id: string; name: string; folder?: unknown }>,
  provider?: 'gemini' | 'claude',
  model?: string,
): number {
  let count = 0;
  for (const item of items) {
    if (item.folder) continue;
    if (!aiFileProcessor.shouldProcess(item.name)) continue;

    const fileType = aiFileProcessor.getFileType(item.name);
    if (!fileType) continue;

    aiModel.createJob({
      sp_folder_id: spFolderId,
      sp_item_id: item.id,
      filename: item.name,
      file_type: fileType,
      vision_provider: provider,
      vision_model: model,
    }).then(job => {
      if (job) count++;
    }).catch(() => { /* dedup or error — silently skip */ });

    count++; // optimistic count for return value
  }

  if (count > 0) {
    // Delayed tick to let INSERTs complete
    setTimeout(() => tickDrain(), 100);
  }
  return count;
}

/**
 * Get comprehensive queue status from DB.
 */
export async function status(): Promise<aiModel.QueueStatusResponse> {
  return aiModel.getQueueStatus();
}

/**
 * Initialize the queue — recover stuck jobs + start drain interval.
 * Call from server.ts after database connection is verified.
 */
export async function initialize(): Promise<void> {
  try {
    const recovered = await aiModel.recoverStuckJobs();
    if (recovered > 0) {
      logger.info('AI queue: recovered stuck jobs on startup', { count: recovered });
    }
  } catch (err) {
    // Table might not exist yet (migration not run) — that's OK
    logger.warn('AI queue: recovery skipped (table may not exist)', { error: (err as Error).message });
  }

  drainTimer = setInterval(() => tickDrain(), DRAIN_INTERVAL_MS);
  logger.info('AI queue: initialized', { drainIntervalMs: DRAIN_INTERVAL_MS });
}

/**
 * Shutdown the queue — stop drain interval.
 */
export async function shutdown(): Promise<void> {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  logger.info('AI queue: shutdown');
}

// ---------------------------------------------------------------------------
// Drain Loop
// ---------------------------------------------------------------------------

function tickDrain(): void {
  if (isDraining) return;
  isDraining = true;

  setImmediate(async () => {
    try {
      // Phase 1: Claim and process parent jobs (split into sub-jobs)
      await processNextParentJob();

      // Phase 2: Fire off sub-jobs in parallel up to concurrency limit.
      // Claim as many as we can, run them concurrently, then check for more.
      await drainSubJobs();
    } catch (err) {
      logger.error('AI queue: drain tick error', { error: (err as Error).message });
    } finally {
      isDraining = false;
    }
  });
}

/** Claim and run sub-jobs in parallel. As each finishes, immediately claim another. */
async function drainSubJobs(): Promise<void> {
  // Claim initial batch
  let activeClaimed = 0;
  for (let i = 0; i < MAX_CONCURRENT_VISION; i++) {
    const claimed = await claimAndProcess();
    if (!claimed) break;
    activeClaimed++;
  }
}

/** Claim one sub-job and process it. When done, claim another (self-replenishing pool). Returns false if nothing to claim. */
async function claimAndProcess(): Promise<boolean> {
  const subJob = await aiModel.claimNextSubJob(MAX_CONCURRENT_VISION);
  if (!subJob) return false;

  // Fire and forget — don't await. When this finishes, it claims another.
  processSubJobWithTimeout(subJob)
    .then(() => checkJobCompletion(subJob.fk_apsj_job))
    .catch(() => {})
    .finally(() => {
      // Immediately try to fill this slot with another sub-job
      claimAndProcess().catch(() => {});
    });

  return true;
}

/** Process a sub-job with a timeout to prevent stuck API calls from blocking the pipeline. */
async function processSubJobWithTimeout(subJob: aiModel.AiProcessingSubJob): Promise<void> {
  const VISION_TIMEOUT_MS = 120_000; // 2 minutes max per vision call

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Vision API timeout after ${VISION_TIMEOUT_MS / 1000}s`)), VISION_TIMEOUT_MS);
  });

  try {
    await Promise.race([processSubJob(subJob), timeoutPromise]);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error('AI queue: sub-job timed out or failed', {
      subType: subJob.sub_type,
      seq: subJob.sequence_num,
      error: errMsg,
    });
    // Mark as failed (transient — will retry)
    await aiModel.failSubJob(subJob.pk_ai_processing_sub_job, errMsg, false);
    bufferMap.delete(subJob.pk_ai_processing_sub_job);
  }
}

// ---------------------------------------------------------------------------
// Parent Job Processing
// ---------------------------------------------------------------------------

async function processNextParentJob(): Promise<void> {
  // Memory-pressure shed. Parent jobs split a source file into per-page or
  // per-image Buffers held in `bufferMap` until each sub-job runs through
  // the vision API — easily hundreds of MB resident for a large PDF.
  // Refusing to claim new parents while the heap is hot lets in-flight
  // sub-jobs drain their buffers and the state recovers naturally.
  if (memoryPressure.isAmberOrWorse()) {
    logger.warn('AI queue: parent-job claim skipped (memory pressure)', {
      state: memoryPressure.getState(),
      pct: memoryPressure.getLastSample().pct,
      bufferMapSize: bufferMap.size,
    });
    return;
  }

  const job = await aiModel.claimNextJob();
  if (!job) return;

  const startTime = Date.now();
  logger.info('AI queue: processing job', { filename: job.filename, jobId: job.pk_ai_processing_job.substring(0, 8) });

  velocityStreamManager.broadcast('sharepoint_ai_job_started', {
    jobId: job.pk_ai_processing_job,
    filename: job.filename,
    fileType: job.file_type,
  });

  try {
    // Download file from SharePoint
    const { buffer, contentType } = await sharepointService.downloadFile(job.sp_item_id);

    // Check cTag staleness
    const metadata = await sharepointService.getFileMetadata(job.sp_item_id);
    const sourceCTag = (metadata as any).cTag || (metadata as any).eTag || '';

    if (sourceCTag) {
      const check = await aiFileProcessor.needsProcessing(job.sp_folder_id, job.sp_item_id, job.filename);
      if (!check.needed) {
        await aiModel.skipJob(job.pk_ai_processing_job);
        logger.info('AI queue: skipped (unchanged)', { filename: job.filename });
        velocityStreamManager.broadcast('sharepoint_ai_skipped', { filename: job.filename });
        return;
      }
    }

    // Split into sub-artifacts based on file type
    await splitAndCreateSubJobs(job, buffer, contentType, sourceCTag);

    // Immediately drain sub-jobs in parallel
    await drainSubJobs();

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errMsg = (err as Error).message;
    logger.error('AI queue: parent job failed', { filename: job.filename, elapsed: `${elapsed}s`, error: errMsg });

    if (isTransientError(err)) {
      const requeued = await aiModel.requeueJob(job.pk_ai_processing_job);
      if (requeued) {
        logger.info('AI queue: job requeued for retry', { filename: job.filename });
        return;
      }
    }
    await aiModel.failJob(job.pk_ai_processing_job, errMsg);
    velocityStreamManager.broadcast('sharepoint_ai_job_failed', { filename: job.filename, error: errMsg });
  }
}

async function splitAndCreateSubJobs(
  job: aiModel.AiProcessingJob,
  buffer: Buffer,
  _contentType: string,
  sourceCTag: string,
): Promise<void> {
  const jobId = job.pk_ai_processing_job;

  // Store source cTag on job first
  if (sourceCTag) {
    try {
      const { pool } = await import('../config/database');
      await pool.query(
        `UPDATE ai_processing_job SET source_ctag = $2 WHERE pk_ai_processing_job = $1`,
        [jobId, sourceCTag]
      );
    } catch { /* non-critical */ }
  }

  switch (job.file_type) {
    case 'pdf': {
      const pages = await aiFileProcessor.splitPdfPages(buffer);
      const subJobsData: aiModel.CreateSubJobData[] = pages.map(page => ({
        fk_apsj_job: jobId,
        sub_type: 'pdf_page' as const,
        sequence_num: page.pageIndex,
        input_mime_type: 'application/pdf',
        input_size_bytes: page.pageBuffer.length,
        vision_provider: job.vision_provider || undefined,
        vision_model: job.vision_model || undefined,
      }));

      await aiModel.setTotalSubJobs(jobId, subJobsData.length);
      const created = await aiModel.createSubJobs(subJobsData);
      for (let i = 0; i < created.length; i++) {
        bufferMap.set(created[i].pk_ai_processing_sub_job, pages[i].pageBuffer);
      }
      break;
    }

    case 'docx': {
      const { textMarkdown, images } = await aiFileProcessor.extractDocxContent(buffer, job.filename);
      const significant = images.filter(img =>
        img.buffer.length >= 3000 && aiFileProcessor.VISION_MIME_TYPES.has(img.contentType)
      );

      const subJobsData: aiModel.CreateSubJobData[] = [];

      // Seq 0: text extraction — pre-completed with result
      subJobsData.push({
        fk_apsj_job: jobId,
        sub_type: 'docx_text',
        sequence_num: 0,
        status: 'completed',
        result_markdown: textMarkdown,
      });

      // Seq 1+: images needing vision API
      for (let i = 0; i < Math.min(significant.length, 10); i++) {
        subJobsData.push({
          fk_apsj_job: jobId,
          sub_type: 'docx_image',
          sequence_num: i + 1,
          input_mime_type: significant[i].contentType,
          input_size_bytes: significant[i].buffer.length,
          vision_provider: job.vision_provider || undefined,
          vision_model: job.vision_model || undefined,
        });
      }

      // Set total BEFORE creating sub-jobs so counters are correct
      const preCompletedCount = 1; // the text sub-job
      await aiModel.setTotalSubJobs(jobId, subJobsData.length);
      await setCompletedCount(jobId, preCompletedCount);

      const created = await aiModel.createSubJobs(subJobsData);

      // Map image buffers for vision processing
      const imageSubJobs = created.filter(s => s.sub_type === 'docx_image');
      for (let i = 0; i < imageSubJobs.length; i++) {
        bufferMap.set(imageSubJobs[i].pk_ai_processing_sub_job, significant[i].buffer);
      }

      logger.info('DOCX split complete', {
        filename: job.filename,
        totalSubJobs: subJobsData.length,
        visionSubJobs: imageSubJobs.length,
        preCompleted: preCompletedCount,
      });
      break;
    }

    case 'pptx': {
      const { slidesMarkdown, images } = await aiFileProcessor.extractPptxContent(buffer, job.filename);

      const subJobsData: aiModel.CreateSubJobData[] = [];

      // Seq 0: slide text — pre-completed
      subJobsData.push({
        fk_apsj_job: jobId,
        sub_type: 'pptx_text',
        sequence_num: 0,
        status: 'completed',
        result_markdown: slidesMarkdown,
      });

      // Seq 1+: embedded images
      for (let i = 0; i < Math.min(images.length, 5); i++) {
        subJobsData.push({
          fk_apsj_job: jobId,
          sub_type: 'pptx_image',
          sequence_num: i + 1,
          input_mime_type: images[i].mimeType,
          input_size_bytes: images[i].buffer.length,
          vision_provider: job.vision_provider || undefined,
          vision_model: job.vision_model || undefined,
        });
      }

      const preCompletedCount = 1;
      await aiModel.setTotalSubJobs(jobId, subJobsData.length);
      await setCompletedCount(jobId, preCompletedCount);

      const created = await aiModel.createSubJobs(subJobsData);

      const imageSubJobs = created.filter(s => s.sub_type === 'pptx_image');
      for (let i = 0; i < imageSubJobs.length; i++) {
        bufferMap.set(imageSubJobs[i].pk_ai_processing_sub_job, images[i].buffer);
      }
      break;
    }

    case 'xlsx':
    case 'csv': {
      const markdown = await aiFileProcessor.processXlsxToMarkdown(buffer, job.filename);
      const hashComment = sourceCTag ? `<!-- source-ctag: ${sourceCTag} -->\n` : '';
      const fullMarkdown = hashComment + markdown;

      await aiModel.setTotalSubJobs(jobId, 1);
      await setCompletedCount(jobId, 1);

      await aiModel.createSubJobs([{
        fk_apsj_job: jobId,
        sub_type: 'xlsx',
        sequence_num: 0,
        status: 'completed',
        result_markdown: fullMarkdown,
      }]);
      break;
    }

    case 'image': {
      await aiModel.setTotalSubJobs(jobId, 1);

      const created = await aiModel.createSubJobs([{
        fk_apsj_job: jobId,
        sub_type: 'image',
        sequence_num: 0,
        input_mime_type: `image/${job.filename.split('.').pop()?.toLowerCase() || 'png'}`,
        input_size_bytes: buffer.length,
        vision_provider: job.vision_provider || undefined,
        vision_model: job.vision_model || undefined,
      }]);
      if (created[0]) {
        bufferMap.set(created[0].pk_ai_processing_sub_job, buffer);
      }
      break;
    }
  }

  // After splitting, check if everything is already done (xlsx, docx with no images)
  // This must happen AFTER all sub-jobs are created and counters set
  await checkJobCompletion(jobId);
}

/** Set completed_sub_jobs counter directly (for pre-completed sub-jobs like text extraction) */
async function setCompletedCount(jobId: string, count: number): Promise<void> {
  const { pool } = await import('../config/database');
  await pool.query(
    `UPDATE ai_processing_job SET completed_sub_jobs = $2 WHERE pk_ai_processing_job = $1`,
    [jobId, count]
  );
}

// ---------------------------------------------------------------------------
// Sub-Job Processing
// ---------------------------------------------------------------------------

async function processSubJob(subJob: aiModel.AiProcessingSubJob): Promise<void> {
  const startTime = Date.now();
  const buffer = bufferMap.get(subJob.pk_ai_processing_sub_job);

  if (!buffer) {
    // Buffer lost (server restarted) — parent job will be requeued by recovery
    await aiModel.failSubJob(subJob.pk_ai_processing_sub_job, 'Buffer not available (server may have restarted)', true);
    return;
  }

  try {
    let prompt: string;
    const provider = (subJob.vision_provider as 'claude' | 'gemini' | undefined) || undefined;
    const model = subJob.vision_model || undefined;

    switch (subJob.sub_type) {
      case 'pdf_page':
        // Get parent job for page count context
        const parentJob = await aiModel.getJob(subJob.fk_apsj_job);
        const totalPages = parentJob?.total_sub_jobs || 1;
        prompt = aiFileProcessor.buildPdfPagePrompt(subJob.sequence_num + 1, totalPages);
        break;
      case 'docx_image':
        prompt = aiFileProcessor.buildDocxImagePrompt('document');
        break;
      case 'pptx_image':
        prompt = aiFileProcessor.buildPptxImagePrompt();
        break;
      case 'image':
        const job = await aiModel.getJob(subJob.fk_apsj_job);
        prompt = aiFileProcessor.buildImagePrompt(job?.filename || 'image');
        break;
      default:
        prompt = 'Analyze this content and extract all information as Markdown.';
    }

    const markdown = await aiFileProcessor.callVision(
      buffer,
      subJob.input_mime_type || 'application/octet-stream',
      prompt,
      provider,
      model,
    );

    await aiModel.completeSubJob(subJob.pk_ai_processing_sub_job, markdown);

    // Clean up buffer
    bufferMap.delete(subJob.pk_ai_processing_sub_job);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info('AI queue: sub-job completed', {
      subType: subJob.sub_type,
      seq: subJob.sequence_num,
      elapsed: `${elapsed}s`,
      markdownLen: markdown.length,
    });

    // Broadcast progress
    const parent = await aiModel.getJob(subJob.fk_apsj_job);
    if (parent) {
      velocityStreamManager.broadcast('sharepoint_ai_sub_progress', {
        jobId: parent.pk_ai_processing_job,
        filename: parent.filename,
        completed: parent.completed_sub_jobs,
        total: parent.total_sub_jobs,
      });
    }
  } catch (err) {
    bufferMap.delete(subJob.pk_ai_processing_sub_job);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errMsg = (err as Error).message;
    logger.error('AI queue: sub-job failed', {
      subType: subJob.sub_type,
      seq: subJob.sequence_num,
      elapsed: `${elapsed}s`,
      error: errMsg,
    });

    const permanent = !isTransientError(err);
    await aiModel.failSubJob(subJob.pk_ai_processing_sub_job, errMsg, permanent);
  }
}

// ---------------------------------------------------------------------------
// Job Completion Check + Merge
// ---------------------------------------------------------------------------

async function checkJobCompletion(jobId: string): Promise<void> {
  const allDone = await aiModel.areAllSubJobsDone(jobId);
  if (!allDone) return;

  const job = await aiModel.getJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return;

  await aiModel.markJobMerging(jobId);

  try {
    const subJobs = await aiModel.getSubJobsForJob(jobId);
    const sourceCTag = job.source_ctag || '';

    // Build sub-job results for merge functions
    const results: aiFileProcessor.SubJobResult[] = subJobs.map(s => ({
      sequenceNum: s.sequence_num,
      markdown: s.result_markdown,
      failed: s.status === 'failed',
      errorMessage: s.error_message || undefined,
    }));

    let finalMarkdown: string;

    switch (job.file_type) {
      case 'pdf': {
        finalMarkdown = aiFileProcessor.mergePdfResults(
          job.filename, subJobs.length, results, sourceCTag
        );
        break;
      }
      case 'docx': {
        const textResult = results.find(r => r.sequenceNum === 0);
        const imageResults = results.filter(r => r.sequenceNum > 0);
        finalMarkdown = aiFileProcessor.mergeDocxResults(
          job.filename, textResult?.markdown || '', imageResults, sourceCTag
        );
        break;
      }
      case 'pptx': {
        const textResult = results.find(r => r.sequenceNum === 0);
        const imageResults = results.filter(r => r.sequenceNum > 0);
        finalMarkdown = aiFileProcessor.mergePptxResults(
          job.filename, textResult?.markdown || '', imageResults, sourceCTag
        );
        break;
      }
      case 'xlsx':
      case 'csv': {
        finalMarkdown = results[0]?.markdown || '';
        break;
      }
      case 'image': {
        const hashComment = sourceCTag ? `<!-- source-ctag: ${sourceCTag} -->\n` : '';
        const header = `# ${job.filename}\n\n*AI-processed image — visual recognition + OCR*\n*Generated: ${new Date().toISOString()}*\n\n`;
        finalMarkdown = hashComment + header + (results[0]?.markdown || '*[Processing failed]*');
        break;
      }
      default:
        finalMarkdown = results.map(r => r.markdown || '').join('\n\n');
    }

    // Upload shadow file to SharePoint
    const shadowName = aiFileProcessor.shadowFilename(job.filename);
    const shadowBuffer = Buffer.from(finalMarkdown, 'utf-8');

    logger.info('AI queue: uploading shadow file', {
      filename: job.filename,
      shadowName,
      size: shadowBuffer.length,
    });

    const uploaded = await sharepointService.uploadFile(
      job.sp_folder_id,
      shadowName,
      shadowBuffer,
      'text/markdown'
    );

    await aiModel.completeJob(
      jobId,
      uploaded.id,
      uploaded.webUrl || '',
      sourceCTag
    );

    logger.info('AI queue: job completed', {
      filename: job.filename,
      shadow: shadowName,
      subJobs: subJobs.length,
      completed: job.completed_sub_jobs,
      failed: job.failed_sub_jobs,
    });

    velocityStreamManager.broadcast('sharepoint_ai_shadow_created', {
      originalFile: job.filename,
      shadowFile: shadowName,
      shadowItemId: uploaded.id,
      spFolderId: job.sp_folder_id,
    });

  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error('AI queue: merge/upload failed', { filename: job.filename, error: errMsg });
    await aiModel.failJob(jobId, `Merge/upload failed: ${errMsg}`);
    velocityStreamManager.broadcast('sharepoint_ai_job_failed', {
      filename: job.filename,
      error: errMsg,
    });
  }
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

function isTransientError(err: unknown): boolean {
  const error = err as any;
  const status = error?.status || error?.statusCode || 0;
  if (status === 429 || status === 502 || status === 503) return true;
  const msg = error?.message || '';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket hang up/i.test(msg)) return true;
  return false;
}

