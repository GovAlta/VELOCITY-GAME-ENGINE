-- Migration: 059_ai_processing_jobs
-- Description: Database-backed AI file processing pipeline with sub-artifact tracking.
--   Parent jobs track each source file through queued → processing → merging → completed/failed/skipped.
--   Child sub-jobs track each vision API call (PDF pages, DOCX/PPTX images) individually.

-- ═══════════════════════════════════════════════════════════════════════════
-- Parent job table — one row per source file
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_processing_job (
  pk_ai_processing_job UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- SharePoint references
  sp_folder_id         VARCHAR(255) NOT NULL,
  sp_item_id           VARCHAR(255) NOT NULL,
  filename             VARCHAR(500) NOT NULL,
  file_type            VARCHAR(10)  NOT NULL
                       CHECK (file_type IN ('pdf','docx','pptx','xlsx','csv','image')),

  -- State machine
  status               VARCHAR(20)  NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','processing','merging','completed','failed','skipped')),

  -- AI provider config
  vision_provider      VARCHAR(20),
  vision_model         VARCHAR(100),

  -- Retry
  retry_count          INT NOT NULL DEFAULT 0,
  max_retries          INT NOT NULL DEFAULT 3,
  error_message        TEXT,

  -- Result
  shadow_item_id       VARCHAR(255),
  shadow_web_url       TEXT,
  source_ctag          VARCHAR(500),

  -- Denormalized sub-job counters (updated atomically)
  total_sub_jobs       INT NOT NULL DEFAULT 0,
  completed_sub_jobs   INT NOT NULL DEFAULT 0,
  failed_sub_jobs      INT NOT NULL DEFAULT 0,

  -- Timestamps
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted           BOOLEAN NOT NULL DEFAULT false
);

CREATE TRIGGER trg_ai_processing_job_set_updated_at
  BEFORE UPDATE ON ai_processing_job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Prevent double-enqueue: only one active job per SharePoint item
CREATE UNIQUE INDEX idx_aipj_active_item
  ON ai_processing_job (sp_item_id)
  WHERE status IN ('queued', 'processing', 'merging');

-- Drain query: find next queued job efficiently
CREATE INDEX idx_aipj_status_created
  ON ai_processing_job (status, created_at)
  WHERE is_deleted = false;

-- Folder-level queries (e.g., "show all jobs for this folder")
CREATE INDEX idx_aipj_folder
  ON ai_processing_job (sp_folder_id)
  WHERE is_deleted = false;

-- ═══════════════════════════════════════════════════════════════════════════
-- Sub-job table — one row per vision API call (PDF page, embedded image, etc.)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ai_processing_sub_job (
  pk_ai_processing_sub_job UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fk_apsj_job              UUID NOT NULL REFERENCES ai_processing_job(pk_ai_processing_job) ON DELETE CASCADE,

  -- What this sub-job represents
  sub_type                 VARCHAR(20) NOT NULL
                           CHECK (sub_type IN ('pdf_page','docx_text','docx_image','pptx_text','pptx_image','image','xlsx')),
  sequence_num             INT NOT NULL,

  -- State machine
  status                   VARCHAR(20) NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','processing','completed','failed')),

  -- Retry
  retry_count              INT NOT NULL DEFAULT 0,
  max_retries              INT NOT NULL DEFAULT 3,
  error_message            TEXT,

  -- Result (vision API output or local extraction result)
  result_markdown          TEXT,

  -- Input metadata
  input_mime_type          VARCHAR(100),
  input_size_bytes         INT,

  -- AI provider (may differ from parent if retried with different provider)
  vision_provider          VARCHAR(20),
  vision_model             VARCHAR(100),

  -- Timestamps
  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_ai_processing_sub_job_set_updated_at
  BEFORE UPDATE ON ai_processing_sub_job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Parent FK index (for JOIN queries and CASCADE deletes)
CREATE INDEX idx_apsj_job
  ON ai_processing_sub_job (fk_apsj_job);

-- Sub-job drain query: find retryable/pending sub-jobs with backoff
CREATE INDEX idx_apsj_pending
  ON ai_processing_sub_job (status, created_at)
  WHERE status IN ('pending', 'failed');
