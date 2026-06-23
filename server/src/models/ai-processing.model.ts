/**
 * AI Processing Job Model
 *
 * Database-backed state machine for AI file processing.
 * Parent jobs (one per source file) contain child sub-jobs (one per vision API call).
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent processing.
 */

import { pool } from '../config/database';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'processing' | 'merging' | 'completed' | 'failed' | 'skipped';
export type SubJobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type FileType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'image';
export type SubJobType = 'pdf_page' | 'docx_text' | 'docx_image' | 'pptx_text' | 'pptx_image' | 'image' | 'xlsx';

export interface AiProcessingJob {
  pk_ai_processing_job: string;
  sp_folder_id: string;
  sp_item_id: string;
  filename: string;
  file_type: FileType;
  status: JobStatus;
  vision_provider: string | null;
  vision_model: string | null;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  shadow_item_id: string | null;
  shadow_web_url: string | null;
  source_ctag: string | null;
  total_sub_jobs: number;
  completed_sub_jobs: number;
  failed_sub_jobs: number;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface AiProcessingSubJob {
  pk_ai_processing_sub_job: string;
  fk_apsj_job: string;
  sub_type: SubJobType;
  sequence_num: number;
  status: SubJobStatus;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  result_markdown: string | null;
  input_mime_type: string | null;
  input_size_bytes: number | null;
  vision_provider: string | null;
  vision_model: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateJobData {
  sp_folder_id: string;
  sp_item_id: string;
  filename: string;
  file_type: FileType;
  vision_provider?: string;
  vision_model?: string;
}

export interface CreateSubJobData {
  fk_apsj_job: string;
  sub_type: SubJobType;
  sequence_num: number;
  input_mime_type?: string;
  input_size_bytes?: number;
  vision_provider?: string;
  vision_model?: string;
  // For sub-jobs that are immediately completed (text extraction, xlsx)
  status?: 'completed';
  result_markdown?: string;
}

// ---------------------------------------------------------------------------
// Parent Job Operations
// ---------------------------------------------------------------------------

/**
 * Create a new processing job. Returns null if a job for this item is already active
 * (dedup enforced by the unique partial index).
 */
export async function createJob(data: CreateJobData): Promise<AiProcessingJob | null> {
  try {
    const result = await pool.query<AiProcessingJob>(
      `INSERT INTO ai_processing_job (
        sp_folder_id, sp_item_id, filename, file_type, vision_provider, vision_model
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [data.sp_folder_id, data.sp_item_id, data.filename, data.file_type,
       data.vision_provider || null, data.vision_model || null]
    );
    return result.rows[0];
  } catch (err: any) {
    // Unique constraint violation = duplicate active job — silently skip
    if (err.code === '23505') {
      logger.info('AI job already active, skipping', { filename: data.filename, itemId: data.sp_item_id.substring(0, 12) });
      return null;
    }
    throw err;
  }
}

/**
 * Atomically claim the next queued job for processing.
 * Uses FOR UPDATE SKIP LOCKED to prevent double-processing.
 */
export async function claimNextJob(): Promise<AiProcessingJob | null> {
  const result = await pool.query<AiProcessingJob>(
    `UPDATE ai_processing_job
     SET status = 'processing', started_at = NOW()
     WHERE pk_ai_processing_job = (
       SELECT pk_ai_processing_job FROM ai_processing_job
       WHERE status = 'queued' AND is_deleted = false
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return result.rows[0] || null;
}

/**
 * Update the sub-job counters and set total.
 */
export async function setTotalSubJobs(jobId: string, total: number): Promise<void> {
  await pool.query(
    `UPDATE ai_processing_job SET total_sub_jobs = $2 WHERE pk_ai_processing_job = $1`,
    [jobId, total]
  );
}

/**
 * Transition job to merging state.
 */
export async function markJobMerging(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE ai_processing_job SET status = 'merging' WHERE pk_ai_processing_job = $1`,
    [jobId]
  );
}

/**
 * Mark job completed with shadow file result.
 */
export async function completeJob(
  jobId: string, shadowItemId: string, shadowWebUrl: string, sourceCTag?: string
): Promise<void> {
  await pool.query(
    `UPDATE ai_processing_job
     SET status = 'completed', shadow_item_id = $2, shadow_web_url = $3,
         source_ctag = $4, completed_at = NOW()
     WHERE pk_ai_processing_job = $1`,
    [jobId, shadowItemId, shadowWebUrl, sourceCTag || null]
  );
}

/**
 * Mark job failed with error message.
 */
export async function failJob(jobId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE ai_processing_job
     SET status = 'failed', error_message = $2, completed_at = NOW()
     WHERE pk_ai_processing_job = $1`,
    [jobId, error.substring(0, 2000)]
  );
}

/**
 * Mark job skipped (cTag unchanged, no processing needed).
 */
export async function skipJob(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE ai_processing_job
     SET status = 'skipped', completed_at = NOW()
     WHERE pk_ai_processing_job = $1`,
    [jobId]
  );
}

/**
 * Re-queue a failed job for retry (increments retry_count).
 */
export async function requeueJob(jobId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE ai_processing_job
     SET status = 'queued', retry_count = retry_count + 1, error_message = NULL,
         started_at = NULL, completed_at = NULL
     WHERE pk_ai_processing_job = $1 AND retry_count < max_retries
     RETURNING pk_ai_processing_job`,
    [jobId]
  );
  return result.rowCount !== null && result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Sub-Job Operations
// ---------------------------------------------------------------------------

/**
 * Create multiple sub-jobs in a single batch INSERT.
 */
export async function createSubJobs(subJobs: CreateSubJobData[]): Promise<AiProcessingSubJob[]> {
  if (subJobs.length === 0) return [];

  const values: any[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < subJobs.length; i++) {
    const s = subJobs[i];
    const offset = i * 9;
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
    );
    values.push(
      s.fk_apsj_job, s.sub_type, s.sequence_num,
      s.status || 'pending',
      s.result_markdown || null,
      s.input_mime_type || null, s.input_size_bytes || null,
      s.vision_provider || null, s.vision_model || null
    );
  }

  const result = await pool.query<AiProcessingSubJob>(
    `INSERT INTO ai_processing_sub_job (
      fk_apsj_job, sub_type, sequence_num, status, result_markdown,
      input_mime_type, input_size_bytes, vision_provider, vision_model
    ) VALUES ${placeholders.join(', ')}
    RETURNING *`,
    values
  );

  return result.rows;
}

/**
 * Atomically claim the next pending sub-job, respecting global concurrency limit.
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent access.
 * Enforces backoff: sub-jobs with retry_count > 0 must wait before retrying.
 */
export async function claimNextSubJob(maxConcurrent = 3): Promise<AiProcessingSubJob | null> {
  const result = await pool.query<AiProcessingSubJob>(
    `UPDATE ai_processing_sub_job
     SET status = 'processing', started_at = NOW()
     WHERE pk_ai_processing_sub_job = (
       SELECT s.pk_ai_processing_sub_job
       FROM ai_processing_sub_job s
       WHERE s.status = 'pending'
         AND (s.retry_count = 0
              OR s.updated_at + (5 * POWER(3, s.retry_count - 1)) * INTERVAL '1 second' <= NOW())
         AND (SELECT COUNT(*) FROM ai_processing_sub_job WHERE status = 'processing') < $1
       ORDER BY s.created_at
       LIMIT 1
       FOR UPDATE OF s SKIP LOCKED
     )
     RETURNING *`,
    [maxConcurrent]
  );
  return result.rows[0] || null;
}

/**
 * Mark a sub-job completed with its result markdown.
 * Atomically increments the parent job's completed_sub_jobs counter.
 */
export async function completeSubJob(subJobId: string, markdown: string): Promise<AiProcessingSubJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subResult = await client.query<AiProcessingSubJob>(
      `UPDATE ai_processing_sub_job
       SET status = 'completed', result_markdown = $2, completed_at = NOW()
       WHERE pk_ai_processing_sub_job = $1
       RETURNING *`,
      [subJobId, markdown]
    );

    if (subResult.rows[0]) {
      await client.query(
        `UPDATE ai_processing_job
         SET completed_sub_jobs = completed_sub_jobs + 1
         WHERE pk_ai_processing_job = $1`,
        [subResult.rows[0].fk_apsj_job]
      );
    }

    await client.query('COMMIT');
    return subResult.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a sub-job failed. If the error is transient and retries remain, reset to pending.
 * Increments parent's failed_sub_jobs counter only on permanent failure.
 */
export async function failSubJob(subJobId: string, error: string, permanent: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!permanent) {
      // Check if retries remain
      const check = await client.query<AiProcessingSubJob>(
        `SELECT * FROM ai_processing_sub_job WHERE pk_ai_processing_sub_job = $1`,
        [subJobId]
      );
      const sub = check.rows[0];
      if (sub && sub.retry_count < sub.max_retries) {
        // Reset to pending for retry
        await client.query(
          `UPDATE ai_processing_sub_job
           SET status = 'pending', retry_count = retry_count + 1, error_message = $2
           WHERE pk_ai_processing_sub_job = $1`,
          [subJobId, error.substring(0, 2000)]
        );
        await client.query('COMMIT');
        return;
      }
    }

    // Permanent failure
    const subResult = await client.query<AiProcessingSubJob>(
      `UPDATE ai_processing_sub_job
       SET status = 'failed', error_message = $2, completed_at = NOW()
       WHERE pk_ai_processing_sub_job = $1
       RETURNING fk_apsj_job`,
      [subJobId, error.substring(0, 2000)]
    );

    if (subResult.rows[0]) {
      await client.query(
        `UPDATE ai_processing_job
         SET failed_sub_jobs = failed_sub_jobs + 1
         WHERE pk_ai_processing_job = $1`,
        [subResult.rows[0].fk_apsj_job]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get all sub-jobs for a parent job, ordered by sequence_num.
 */
export async function getSubJobsForJob(jobId: string): Promise<AiProcessingSubJob[]> {
  const result = await pool.query<AiProcessingSubJob>(
    `SELECT * FROM ai_processing_sub_job
     WHERE fk_apsj_job = $1
     ORDER BY sequence_num`,
    [jobId]
  );
  return result.rows;
}

/**
 * Check if all sub-jobs for a job are finished (completed or permanently failed).
 */
export async function areAllSubJobsDone(jobId: string): Promise<boolean> {
  const result = await pool.query<{ total: string; done: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status IN ('completed', 'failed')) AS done
     FROM ai_processing_sub_job
     WHERE fk_apsj_job = $1`,
    [jobId]
  );
  const row = result.rows[0];
  return row && row.total === row.done && Number(row.total) > 0;
}

/**
 * Get parent job by ID.
 */
export async function getJob(jobId: string): Promise<AiProcessingJob | null> {
  const result = await pool.query<AiProcessingJob>(
    `SELECT * FROM ai_processing_job WHERE pk_ai_processing_job = $1`,
    [jobId]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Recover jobs stuck in processing/merging state (e.g., after server crash).
 * Resets them to queued with incremented retry count. Also resets stuck sub-jobs.
 */
export async function recoverStuckJobs(): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Reset stuck parent jobs
    const jobResult = await client.query(
      `UPDATE ai_processing_job
       SET status = 'queued', retry_count = retry_count + 1,
           started_at = NULL, completed_at = NULL
       WHERE status IN ('processing', 'merging') AND is_deleted = false
         AND retry_count < max_retries
       RETURNING pk_ai_processing_job, filename`
    );

    // Reset stuck sub-jobs for those parents
    if (jobResult.rows.length > 0) {
      const jobIds = jobResult.rows.map(r => r.pk_ai_processing_job);
      await client.query(
        `UPDATE ai_processing_sub_job
         SET status = 'pending', retry_count = retry_count + 1
         WHERE fk_apsj_job = ANY($1) AND status = 'processing'`,
        [jobIds]
      );

      // Reset parent counters since sub-jobs are being re-processed
      await client.query(
        `UPDATE ai_processing_job
         SET total_sub_jobs = 0, completed_sub_jobs = 0, failed_sub_jobs = 0
         WHERE pk_ai_processing_job = ANY($1)`,
        [jobIds]
      );
    }

    // Fail jobs that exceeded max retries
    await client.query(
      `UPDATE ai_processing_job
       SET status = 'failed', error_message = 'Max retries exceeded after server restart',
           completed_at = NOW()
       WHERE status IN ('processing', 'merging') AND is_deleted = false
         AND retry_count >= max_retries`
    );

    await client.query('COMMIT');

    if (jobResult.rows.length > 0) {
      logger.info('Recovered stuck AI processing jobs', {
        count: jobResult.rows.length,
        files: jobResult.rows.map(r => r.filename),
      });
    }

    return jobResult.rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Status / History Queries
// ---------------------------------------------------------------------------

export interface QueueStatusResponse {
  pending: number;
  processing: number;
  completed_24h: number;
  failed_24h: number;
  jobs: Array<{
    id: string;
    filename: string;
    status: string;
    file_type: string;
    retry_count: number;
    total_sub_jobs: number;
    completed_sub_jobs: number;
    failed_sub_jobs: number;
    error_message: string | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>;
}

/**
 * Get comprehensive queue status for the API endpoint.
 */
export async function getQueueStatus(): Promise<QueueStatusResponse> {
  const counts = await pool.query<{
    pending: string; processing: string; completed_24h: string; failed_24h: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS pending,
      COUNT(*) FILTER (WHERE status IN ('processing', 'merging')) AS processing,
      COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '24 hours') AS completed_24h,
      COUNT(*) FILTER (WHERE status = 'failed' AND completed_at > NOW() - INTERVAL '24 hours') AS failed_24h
    FROM ai_processing_job
    WHERE is_deleted = false
  `);

  const jobs = await pool.query<AiProcessingJob>(`
    SELECT * FROM ai_processing_job
    WHERE is_deleted = false
      AND (status IN ('queued', 'processing', 'merging')
           OR (status IN ('completed', 'failed', 'skipped') AND completed_at > NOW() - INTERVAL '24 hours'))
    ORDER BY
      CASE status
        WHEN 'processing' THEN 1
        WHEN 'merging' THEN 2
        WHEN 'queued' THEN 3
        WHEN 'failed' THEN 4
        WHEN 'completed' THEN 5
        WHEN 'skipped' THEN 6
      END,
      created_at DESC
    LIMIT 50
  `);

  const c = counts.rows[0];
  return {
    pending: Number(c.pending),
    processing: Number(c.processing),
    completed_24h: Number(c.completed_24h),
    failed_24h: Number(c.failed_24h),
    jobs: jobs.rows.map(j => ({
      id: j.pk_ai_processing_job,
      filename: j.filename,
      status: j.status,
      file_type: j.file_type,
      retry_count: j.retry_count,
      total_sub_jobs: j.total_sub_jobs,
      completed_sub_jobs: j.completed_sub_jobs,
      failed_sub_jobs: j.failed_sub_jobs,
      error_message: j.error_message,
      created_at: j.created_at,
      started_at: j.started_at,
      completed_at: j.completed_at,
    })),
  };
}

/**
 * Get jobs with their sub-jobs for a specific folder (or all if no folder specified).
 * Returns recent jobs (active + last 24h) with full sub-job detail.
 */
export async function getJobsDetailed(spFolderId?: string): Promise<Array<
  AiProcessingJob & { sub_jobs: AiProcessingSubJob[] }
>> {
  const whereFolder = spFolderId ? `AND j.sp_folder_id = $1` : '';
  const params = spFolderId ? [spFolderId] : [];

  const jobs = await pool.query<AiProcessingJob>(`
    SELECT * FROM ai_processing_job j
    WHERE j.is_deleted = false
      AND (j.status IN ('queued', 'processing', 'merging')
           OR (j.status IN ('completed', 'failed', 'skipped') AND j.completed_at > NOW() - INTERVAL '24 hours'))
      ${whereFolder}
    ORDER BY j.created_at DESC
    LIMIT 50
  `, params);

  if (jobs.rows.length === 0) return [];

  const jobIds = jobs.rows.map(j => j.pk_ai_processing_job);
  const subJobs = await pool.query<AiProcessingSubJob>(`
    SELECT * FROM ai_processing_sub_job
    WHERE fk_apsj_job = ANY($1)
    ORDER BY fk_apsj_job, sequence_num
  `, [jobIds]);

  // Group sub-jobs by parent
  const subJobMap = new Map<string, AiProcessingSubJob[]>();
  for (const s of subJobs.rows) {
    const list = subJobMap.get(s.fk_apsj_job) || [];
    list.push(s);
    subJobMap.set(s.fk_apsj_job, list);
  }

  return jobs.rows.map(j => ({
    ...j,
    sub_jobs: subJobMap.get(j.pk_ai_processing_job) || [],
  }));
}
