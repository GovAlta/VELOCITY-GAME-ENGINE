/**
 * AI File Processor — generates __AI__ shadow files for SharePoint content.
 *
 * Supported conversions:
 *   PDF  → split pages, send each to vision API, merge markdowns → __AI__filename.md
 *   Image (png/jpg/gif/bmp/webp) → vision API → __AI__filename.md
 *   DOCX → mammoth → markdown + extract images → __AI__filename.md
 *   PPTX → vision API → slide-by-slide markdown → __AI__filename.md
 *   XLSX → ExcelJS → structured markdown tables → __AI__filename.md
 *
 * Shadow files are uploaded to the same SharePoint folder with __AI__ prefix.
 */

import { env } from '../config/environment';
import { AppError } from '../utils/app-error';
import logger from '../utils/logger';
import * as sharepointService from './sharepoint.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AI_PREFIX = '__AI__';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff']);
const PDF_EXTENSIONS = new Set(['pdf']);
const DOCX_EXTENSIONS = new Set(['docx']);
const PPTX_EXTENSIONS = new Set(['pptx']);
const XLSX_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessingResult {
  originalFile: string;
  shadowFile: string;
  shadowItemId: string;
  webUrl: string;
  pages?: number;
  tokensUsed?: number;
}

export interface ProcessingProgress {
  file: string;
  phase: string;
  detail: string;
  progress: number;
}

type ProgressCallback = (p: ProcessingProgress) => void;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Staleness Detection
// ---------------------------------------------------------------------------

export interface StalenessReport {
  total: number;         // total processable files
  upToDate: number;      // shadow exists and cTag matches
  stale: number;         // shadow exists but cTag differs (source was edited)
  missing: number;       // no shadow file at all
  staleFiles: string[];  // filenames that need reprocessing
  missingFiles: string[]; // filenames with no shadow
}

/**
 * Check all files in a folder for AI shadow staleness.
 * Uses a SINGLE listFiles call — no per-file API calls needed.
 * Returns which files are up-to-date, stale, or missing shadows.
 */
export async function checkFolderStaleness(spFolderId: string): Promise<StalenessReport> {
  const files = await sharepointService.listFiles(spFolderId);

  // Separate originals from shadows
  const originals = files.filter(f => !f.folder && shouldProcess(f.name));
  const shadows = new Map<string, typeof files[0]>();
  for (const f of files) {
    if (f.name.startsWith(AI_PREFIX)) {
      shadows.set(f.name, f);
    }
  }

  const staleFiles: string[] = [];
  const missingFiles: string[] = [];
  let upToDate = 0;

  for (const orig of originals) {
    const expectedShadow = shadowFilename(orig.name);
    const shadow = shadows.get(expectedShadow);

    if (!shadow) {
      missingFiles.push(orig.name);
      continue;
    }

    // Compare: the shadow's lastModifiedDateTime should be AFTER the original's
    // If the original was edited after the shadow was created, it's stale
    const origModified = new Date(orig.lastModifiedDateTime || 0).getTime();
    const shadowModified = new Date(shadow.lastModifiedDateTime || 0).getTime();

    if (origModified > shadowModified) {
      staleFiles.push(orig.name);
    } else {
      upToDate++;
    }
  }

  return {
    total: originals.length,
    upToDate,
    stale: staleFiles.length,
    missing: missingFiles.length,
    staleFiles,
    missingFiles,
  };
}

/**
 * Check if a file should be processed into an AI shadow version.
 */
export function shouldProcess(filename: string): boolean {
  if (filename.startsWith(AI_PREFIX)) return false; // skip shadow files
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext) ||
         DOCX_EXTENSIONS.has(ext) || PPTX_EXTENSIONS.has(ext) || XLSX_EXTENSIONS.has(ext);
}

/**
 * Get the shadow filename for a given original filename.
 */
export function shadowFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  return `${AI_PREFIX}${base}.md`;
}

/**
 * Check if a filename is an AI shadow file.
 */
export function isShadowFile(filename: string): boolean {
  return filename.startsWith(AI_PREFIX);
}

/**
 * Process a file from SharePoint and upload the AI shadow version.
 * Runs as a background job — call without await for fire-and-forget.
 */
/**
 * Check if a file needs reprocessing by comparing its cTag with the shadow file's embedded hash.
 * Returns true if processing is needed (new file, changed content, or no shadow exists).
 */
export async function needsProcessing(
  spFolderId: string,
  itemId: string,
  filename: string
): Promise<{ needed: boolean; reason: string }> {
  try {
    // Get source file metadata (includes cTag)
    const metadata = await sharepointService.getFileMetadata(itemId);
    const sourceCTag = (metadata as any).cTag || (metadata as any).eTag || '';

    if (!sourceCTag) return { needed: true, reason: 'no-ctag' };

    // Check if shadow file exists and read its first line for the embedded hash
    const shadowName = shadowFilename(filename);
    const files = await sharepointService.listFiles(spFolderId);
    const shadow = files.find(f => f.name === shadowName);

    if (!shadow) return { needed: true, reason: 'no-shadow' };

    // Read shadow file's first line to extract embedded cTag
    try {
      const shadowContent = await sharepointService.getFileContent(shadow.id);
      const hashMatch = shadowContent.match(/<!-- source-ctag: (.+?) -->/);
      if (!hashMatch) return { needed: true, reason: 'no-hash-in-shadow' };

      if (hashMatch[1] === sourceCTag) {
        return { needed: false, reason: 'unchanged' };
      }
      return { needed: true, reason: 'content-changed' };
    } catch {
      return { needed: true, reason: 'shadow-read-error' };
    }
  } catch {
    return { needed: true, reason: 'metadata-error' };
  }
}

export async function processFile(
  spFolderId: string,
  itemId: string,
  filename: string,
  onProgress?: ProgressCallback,
  visionProvider?: 'gemini' | 'claude',
  visionModel?: string,
  force = false
): Promise<ProcessingResult> {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const emit = onProgress || (() => {});

  // Check if reprocessing is needed (skip if content unchanged)
  if (!force) {
    emit({ file: filename, phase: 'check', detail: 'Checking if reprocessing needed...', progress: 2 });
    const check = await needsProcessing(spFolderId, itemId, filename);
    if (!check.needed) {
      emit({ file: filename, phase: 'skip', detail: `Skipped — ${check.reason}`, progress: 100 });
      logger.info('AI processing skipped (unchanged)', { filename, reason: check.reason });
      return {
        originalFile: filename,
        shadowFile: shadowFilename(filename),
        shadowItemId: '',
        webUrl: '',
      };
    }
    logger.info('AI processing needed', { filename, reason: check.reason });
  }

  emit({ file: filename, phase: 'download', detail: 'Downloading file from SharePoint...', progress: 5 });

  // Get source file metadata for cTag
  const metadata = await sharepointService.getFileMetadata(itemId);
  const sourceCTag = (metadata as any).cTag || (metadata as any).eTag || '';

  // Download the file
  logger.info('Downloading file from SharePoint', { filename, itemId });
  const { buffer, contentType } = await sharepointService.downloadFile(itemId);
  logger.info('File downloaded', { filename, size: buffer.length, contentType });

  emit({ file: filename, phase: 'processing', detail: `Processing ${ext.toUpperCase()} (${(buffer.length / 1024).toFixed(0)} KB)...`, progress: 10 });

  let markdown: string;
  let pages = 0;

  if (PDF_EXTENSIONS.has(ext)) {
    const result = await processPdf(buffer, filename, emit, visionProvider, visionModel);
    markdown = result.markdown;
    pages = result.pages;
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    markdown = await processImage(buffer, filename, contentType, emit, visionProvider, visionModel);
  } else if (DOCX_EXTENSIONS.has(ext)) {
    markdown = await processDocx(buffer, filename, emit, visionProvider, visionModel);
  } else if (PPTX_EXTENSIONS.has(ext)) {
    markdown = await processPptx(buffer, filename, emit, visionProvider, visionModel);
  } else if (XLSX_EXTENSIONS.has(ext)) {
    markdown = await processXlsx(buffer, filename, emit);
  } else {
    throw AppError.badRequest(`Unsupported file type: ${ext}`);
  }

  // Embed source cTag as a comment so we can skip unchanged files on re-process
  const hashComment = sourceCTag ? `<!-- source-ctag: ${sourceCTag} -->\n` : '';
  markdown = hashComment + markdown;

  // Upload shadow file
  emit({ file: filename, phase: 'upload', detail: 'Uploading AI-ready version...', progress: 90 });

  const shadowName = shadowFilename(filename);
  const shadowBuffer = Buffer.from(markdown, 'utf-8');
  logger.info('Uploading shadow file', { filename, shadowName, size: shadowBuffer.length, pages });
  const uploaded = await sharepointService.uploadFile(spFolderId, shadowName, shadowBuffer, 'text/markdown');
  logger.info('Shadow file uploaded', { filename, shadowName, itemId: uploaded.id });

  emit({ file: filename, phase: 'done', detail: 'AI-ready version created', progress: 100 });

  logger.info('AI shadow file created', { original: filename, shadow: shadowName, pages, size: shadowBuffer.length });

  return {
    originalFile: filename,
    shadowFile: shadowName,
    shadowItemId: uploaded.id,
    webUrl: uploaded.webUrl || '',
    pages: pages || undefined,
  };
}

/**
 * Process all eligible files in a SharePoint folder.
 */
export async function processFolder(
  dbFolderId: string,
  spFolderId: string,
  onProgress?: ProgressCallback,
  force = false,
  visionProvider?: 'gemini' | 'claude',
  visionModel?: string
): Promise<ProcessingResult[]> {
  const files = await sharepointService.listFiles(spFolderId);
  const results: ProcessingResult[] = [];

  // All processable non-shadow files
  const eligible = files.filter(f => !f.folder && shouldProcess(f.name));

  for (let i = 0; i < eligible.length; i++) {
    const file = eligible[i];
    try {
      onProgress?.({
        file: file.name,
        phase: 'queue',
        detail: `Processing ${i + 1}/${eligible.length}: ${file.name}`,
        progress: Math.round((i / eligible.length) * 100),
      });

      const result = await processFile(spFolderId, file.id, file.name, onProgress, visionProvider, visionModel, force);
      results.push(result);
    } catch (err) {
      logger.error('AI file processing failed', { file: file.name, error: (err as Error).message });
      // Continue with remaining files
    }

    // Small delay between files to avoid rate limiting
    if (i < eligible.length - 1) await delay(500);
  }

  return results;
}

// ---------------------------------------------------------------------------
// PDF Processing
// ---------------------------------------------------------------------------

async function processPdf(
  buffer: Buffer,
  filename: string,
  emit: ProgressCallback,
  provider?: 'gemini' | 'claude',
  model?: string
): Promise<{ markdown: string; pages: number }> {
  const { PDFDocument } = await import('pdf-lib');

  emit({ file: filename, phase: 'split', detail: 'Splitting PDF into pages...', progress: 15 });

  const pdfDoc = await PDFDocument.load(buffer);
  const pageCount = pdfDoc.getPageCount();

  logger.info('PDF processing started', { filename, pageCount, provider: provider || 'auto', model: model || 'default', bufferSize: buffer.length });
  emit({ file: filename, phase: 'split', detail: `PDF has ${pageCount} pages`, progress: 20 });

  const pageMarkdowns: string[] = [];
  let successCount = 0;
  let failCount = 0;
  const CONCURRENCY = 3;

  for (let i = 0; i < pageCount; i += CONCURRENCY) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, pageCount); j++) {
      batch.push(j);
    }

    logger.info('PDF batch starting', { filename, batch: batch.map(b => b + 1), provider: provider || 'auto' });

    const results = await Promise.allSettled(
      batch.map(async (pageIdx) => {
        const singlePageDoc = await PDFDocument.create();
        const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [pageIdx]);
        singlePageDoc.addPage(copiedPage);
        const pageBuffer = Buffer.from(await singlePageDoc.save());

        logger.info('Sending page to vision API', { filename, page: pageIdx + 1, pageBufferSize: pageBuffer.length, provider: provider || 'auto', model: model || 'default' });

        const text = await callVision(pageBuffer, 'application/pdf', buildPdfPagePrompt(pageIdx + 1, pageCount), provider, model);

        logger.info('Page vision response received', { filename, page: pageIdx + 1, responseLength: text.length });
        return text;
      })
    );

    for (let k = 0; k < results.length; k++) {
      const result = results[k];
      const pageNum = batch[k] + 1;
      if (result.status === 'fulfilled' && result.value) {
        pageMarkdowns.push(`\n\n---\n## Page ${pageNum}\n\n${result.value}`);
        successCount++;
        logger.info('PDF page extracted OK', { filename, page: pageNum, markdownLength: result.value.length });
      } else {
        pageMarkdowns.push(`\n\n---\n## Page ${pageNum}\n\n*[Page extraction failed]*`);
        failCount++;
        const reason = (result as PromiseRejectedResult).reason;
        logger.error('PDF page extraction FAILED', {
          filename, page: pageNum,
          error: reason?.message || String(reason),
          stack: reason?.stack?.split('\n').slice(0, 3).join(' | '),
        });
      }
    }

    const pct = 20 + Math.round(((i + batch.length) / pageCount) * 65);
    emit({ file: filename, phase: 'extract', detail: `Extracted ${Math.min(i + CONCURRENCY, pageCount)}/${pageCount} pages (${successCount} OK, ${failCount} failed)`, progress: pct });

    if (i + CONCURRENCY < pageCount) await delay(300);
  }

  logger.info('PDF processing complete', { filename, pageCount, successCount, failCount, totalMarkdownLength: pageMarkdowns.join('').length });

  // Merge all pages
  const header = `# ${filename}\n\n*AI-processed document — ${pageCount} pages extracted (${successCount} OK, ${failCount} failed)*\n*Generated: ${new Date().toISOString()}*\n`;
  const markdown = header + pageMarkdowns.join('');

  return { markdown, pages: pageCount };
}

// ---------------------------------------------------------------------------
// Image Processing
// ---------------------------------------------------------------------------

async function processImage(
  buffer: Buffer,
  filename: string,
  contentType: string,
  emit: ProgressCallback,
  provider?: 'gemini' | 'claude',
  model?: string
): Promise<string> {
  emit({ file: filename, phase: 'vision', detail: 'Sending image to AI for recognition...', progress: 30 });

  const mimeType = contentType.startsWith('image/') ? contentType : `image/${filename.split('.').pop()?.toLowerCase() || 'png'}`;
  const result = await callVision(buffer, mimeType, buildImagePrompt(filename), provider, model);

  const header = `# ${filename}\n\n*AI-processed image — visual recognition + OCR*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return header + result;
}

// ---------------------------------------------------------------------------
// DOCX Processing
// ---------------------------------------------------------------------------

async function processDocx(
  buffer: Buffer,
  filename: string,
  emit: ProgressCallback,
  provider?: 'gemini' | 'claude',
  model?: string
): Promise<string> {
  const mammothLib = await import('mammoth');
  const mammoth = mammothLib.default || mammothLib;

  emit({ file: filename, phase: 'convert', detail: 'Converting DOCX to markdown...', progress: 15 });

  // ── Phase 1: Extract text with mammoth, collect image buffers ──
  // IMPORTANT: convertImage must be the SECOND argument to convertToMarkdown
  const extractedImages: Array<{ buffer: Buffer; contentType: string; alt: string }> = [];
  let imageIndex = 0;

  const result = await (mammoth as any).convertToMarkdown(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image: any) => {
        imageIndex++;
        try {
          const imgBuf = await image.read();
          const ct = image.contentType || 'image/png';
          extractedImages.push({ buffer: imgBuf, contentType: ct, alt: image.altText || '' });
        } catch {
          // couldn't read image — still replace with placeholder
        }
        // Return a numbered placeholder instead of base64
        return { src: `#image-${imageIndex}` };
      }),
    }
  );

  let markdown = result.value || '';

  // Replace mammoth's img tags with clean placeholders
  markdown = markdown.replace(/!\[([^\]]*)\]\(#image-(\d+)\)/g, '*[Image $2: $1]*');
  // Safety net: strip any remaining base64 data URIs
  markdown = markdown.replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '*[embedded image]*');

  logger.info('DOCX text extracted', { filename, textLength: markdown.length, imagesFound: extractedImages.length });
  emit({ file: filename, phase: 'convert', detail: `Text extracted, ${extractedImages.length} images found`, progress: 30 });

  // ── Phase 2: Send each extracted image to vision API ──
  const imageDescriptions: string[] = [];
  // Filter: skip tiny icons (<3KB) and unsupported formats (EMF, WMF — Windows vector formats)
  const VISION_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/tiff']);
  const significantImages = extractedImages.filter(img =>
    img.buffer.length >= 3000 && VISION_MIME_TYPES.has(img.contentType)
  );
  const skippedFormats = extractedImages.filter(img => !VISION_MIME_TYPES.has(img.contentType));
  if (skippedFormats.length > 0) {
    logger.info('DOCX: skipped non-visual image formats', { filename, skipped: skippedFormats.map(i => i.contentType) });
  }

  if (significantImages.length > 0) {
    emit({ file: filename, phase: 'vision', detail: `Processing ${significantImages.length} images through AI vision...`, progress: 35 });

    const maxImages = Math.min(significantImages.length, 10);
    for (let i = 0; i < maxImages; i++) {
      const img = significantImages[i];
      const pct = 35 + Math.round(((i + 1) / maxImages) * 40);
      emit({ file: filename, phase: 'vision', detail: `Image ${i + 1}/${maxImages} (${(img.buffer.length / 1024).toFixed(0)} KB)...`, progress: pct });

      try {
        const description = await callVision(
          img.buffer,
          img.contentType,
          [
            `Analyze this image from the Word document "${filename}".`,
            'If it contains text or a scanned page, transcribe ALL text verbatim.',
            'If it\'s a chart, graph, or diagram, extract all data points, labels, axes, and legends.',
            'If it\'s a form, extract all field names and values.',
            'If it\'s a photo or logo, describe what it depicts.',
            'Be thorough — this text replaces the image in the AI-readable version.',
          ].join(' '),
          provider,
          model
        );

        if (description.trim()) {
          const alt = img.alt ? ` (${img.alt})` : '';
          imageDescriptions.push(`### Image ${i + 1}${alt}\n\n${description}`);
        }
      } catch (err) {
        logger.warn('DOCX image vision failed', { filename, image: i + 1, error: (err as Error).message });
        imageDescriptions.push(`### Image ${i + 1}\n\n*[Image could not be processed: ${(err as Error).message}]*`);
      }
    }

    emit({ file: filename, phase: 'vision', detail: `${imageDescriptions.length} images described`, progress: 78 });
  }

  // ── Phase 3: Fallback if document was mostly images ──
  const textOnly = markdown.replace(/\*\[Image \d+[^\]]*\]\*/g, '').replace(/\*\[embedded image\]\*/g, '').trim();
  if (textOnly.length < 100 && imageDescriptions.length === 0) {
    emit({ file: filename, phase: 'vision', detail: 'Sparse text — full document AI analysis...', progress: 80 });
    try {
      const visionResult = await callVision(buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buildDocxPrompt(filename), provider, model);
      markdown += '\n\n## AI Extracted Content\n\n' + visionResult;
    } catch {
      markdown += '\n\n*Note: Document appears to contain primarily images or embedded objects that could not be fully extracted.*';
    }
  }

  // ── Assemble final output ──
  if (imageDescriptions.length > 0) {
    markdown += '\n\n## Embedded Images — AI Descriptions\n\n' + imageDescriptions.join('\n\n---\n\n');
  }

  const imgNote = extractedImages.length > 0 ? ` — ${significantImages.length} images analyzed by AI` : '';
  const header = `# ${filename}\n\n*AI-processed DOCX document${imgNote}*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return header + markdown;
}

// ---------------------------------------------------------------------------
// PPTX Processing — extract via JSZip (PPTX = ZIP of XML slides + media)
// ---------------------------------------------------------------------------

/**
 * Extract text from a PPTX slide XML string.
 * PPTX slides use DrawingML: <a:t> tags contain text runs,
 * <a:p> tags delimit paragraphs, <a:br/> is a line break.
 */
function extractSlideText(xml: string): string {
  const paragraphs: string[] = [];

  // Split by paragraph tags <a:p>...</a:p>
  const pMatches = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) || [];

  for (const p of pMatches) {
    // Check for bullet/numbering level (a:pPr lvl="N")
    const lvlMatch = p.match(/<a:pPr[^>]*\blvl="(\d+)"/);
    const indent = lvlMatch ? '  '.repeat(Number(lvlMatch[1])) + '- ' : '';
    const hasBullet = /<a:buChar|<a:buAutoNum|<a:buNone/.test(p) || lvlMatch;

    // Extract all text runs <a:t>...</a:t>
    const runs = p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
    const text = runs
      .map(r => r.replace(/<a:t>([\s\S]*?)<\/a:t>/, '$1'))
      .join('')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();

    if (text) {
      paragraphs.push(hasBullet ? `${indent}${text}` : text);
    }
  }

  return paragraphs.join('\n');
}

/**
 * Extract speaker notes from a PPTX notes XML string.
 */
function extractNotesText(xml: string): string {
  // Notes use the same DrawingML paragraph structure
  return extractSlideText(xml);
}

/**
 * Extract table data from slide XML (a:tbl elements).
 */
function extractTables(xml: string): string[] {
  const tables: string[] = [];
  const tblMatches = xml.match(/<a:tbl\b[\s\S]*?<\/a:tbl>/g) || [];

  for (const tbl of tblMatches) {
    const rows: string[][] = [];
    const trMatches = tbl.match(/<a:tr\b[\s\S]*?<\/a:tr>/g) || [];

    for (const tr of trMatches) {
      const cells: string[] = [];
      const tcMatches = tr.match(/<a:tc\b[\s\S]*?<\/a:tc>/g) || [];
      for (const tc of tcMatches) {
        const runs = tc.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
        const text = runs.map(r => r.replace(/<a:t>([\s\S]*?)<\/a:t>/, '$1')).join(' ').trim();
        cells.push(text || '—');
      }
      rows.push(cells);
    }

    if (rows.length > 0) {
      const maxCols = Math.max(...rows.map(r => r.length));
      const padded = rows.map(r => { while (r.length < maxCols) r.push(''); return r; });
      let md = '| ' + padded[0].join(' | ') + ' |\n';
      md += '| ' + padded[0].map(() => '---').join(' | ') + ' |\n';
      for (let i = 1; i < padded.length; i++) {
        md += '| ' + padded[i].join(' | ') + ' |\n';
      }
      tables.push(md);
    }
  }

  return tables;
}

async function processPptx(
  buffer: Buffer,
  filename: string,
  emit: ProgressCallback,
  provider?: 'gemini' | 'claude',
  model?: string
): Promise<string> {
  const JSZip = (await import('jszip')).default;

  emit({ file: filename, phase: 'extract', detail: 'Extracting slides from PPTX...', progress: 15 });

  const zip = await JSZip.loadAsync(buffer);

  // Find all slide XML files (ppt/slides/slide1.xml, slide2.xml, ...)
  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return numA - numB;
    });

  logger.info('PPTX processing started', { filename, slideCount: slideFiles.length });

  const slides: string[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.files[slideFiles[i]].async('string');

    // Extract text content
    const text = extractSlideText(slideXml);

    // Extract tables
    const tables = extractTables(slideXml);

    // Check for notes (ppt/notesSlides/notesSlideN.xml)
    const noteFile = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    let notes = '';
    if (zip.files[noteFile]) {
      const noteXml = await zip.files[noteFile].async('string');
      notes = extractNotesText(noteXml);
      // Filter out the default placeholder text
      if (notes && !/^slide \d+$/i.test(notes.trim())) {
        notes = `\n\n**Speaker Notes:** ${notes}`;
      } else {
        notes = '';
      }
    }

    let slideMd = `## Slide ${i + 1}\n\n`;
    if (text) slideMd += text + '\n';
    if (tables.length > 0) slideMd += '\n' + tables.join('\n') + '\n';
    if (notes) slideMd += notes + '\n';

    // If slide has very little text, it might be image-heavy — check for embedded images
    if (text.length < 50) {
      slideMd += '\n*[Slide may contain images, charts, or diagrams not captured in text extraction]*\n';
    }

    slides.push(slideMd);

    const pct = 15 + Math.round(((i + 1) / slideFiles.length) * 50);
    emit({ file: filename, phase: 'extract', detail: `Extracted slide ${i + 1}/${slideFiles.length}`, progress: pct });
  }

  // Extract embedded images and send significant ones to vision API
  const mediaFiles = Object.keys(zip.files).filter(f => /^ppt\/media\/image\d+\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(f));

  if (mediaFiles.length > 0) {
    emit({ file: filename, phase: 'vision', detail: `Processing ${mediaFiles.length} embedded images...`, progress: 70 });

    // Process up to 5 significant images (skip tiny icons)
    const imageDescriptions: string[] = [];
    let processed = 0;

    for (const mediaFile of mediaFiles) {
      if (processed >= 5) break;

      try {
        const imgBuffer = Buffer.from(await zip.files[mediaFile].async('arraybuffer'));

        // Skip tiny images (likely icons or bullets)
        if (imgBuffer.length < 5000) continue;

        const ext = mediaFile.split('.').pop()?.toLowerCase() || 'png';
        const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

        const description = await callVision(
          imgBuffer,
          mimeType,
          `Describe this image from a PowerPoint presentation. If it's a chart, graph, or diagram, extract all data and labels. If it's a photo, describe what it shows. Be concise but thorough.`,
          provider,
          model
        );

        if (description.trim()) {
          imageDescriptions.push(`### Embedded Image: ${mediaFile.split('/').pop()}\n\n${description}`);
          processed++;
        }
      } catch (err) {
        logger.warn('PPTX image processing failed', { mediaFile, error: (err as Error).message });
      }
    }

    if (imageDescriptions.length > 0) {
      slides.push(`\n## Embedded Media\n\n${imageDescriptions.join('\n\n')}`);
    }

    emit({ file: filename, phase: 'vision', detail: `Processed ${processed} images`, progress: 85 });
  }

  logger.info('PPTX processing complete', { filename, slideCount: slideFiles.length, mediaCount: mediaFiles.length });

  const header = `# ${filename}\n\n*AI-processed PowerPoint — ${slideFiles.length} slides, ${mediaFiles.length} embedded images*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return header + slides.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Excel Processing
// ---------------------------------------------------------------------------

async function processXlsx(
  buffer: Buffer,
  filename: string,
  emit: ProgressCallback
): Promise<string> {
  const ExcelJS = await import('exceljs');

  emit({ file: filename, phase: 'convert', detail: 'Reading spreadsheet...', progress: 30 });

  const workbook = new (ExcelJS as any).Workbook();

  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'csv') {
    // ExcelJS csv.read() requires a stream, not a buffer
    const { Readable } = await import('stream');
    const stream = Readable.from(buffer);
    await workbook.csv.read(stream);
  } else {
    await workbook.xlsx.load(buffer as any);
  }

  const sheets: string[] = [];

  workbook.eachSheet((sheet: any, _id: any) => {
    const rows: string[][] = [];
    let maxCols = 0;

    sheet.eachRow({ includeEmpty: false }, (row: any, _rowNum: any) => {
      const cells = (row.values as any[]).slice(1).map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && v.result !== undefined) return String(v.result);
        if (typeof v === 'object' && v.text) return String(v.text);
        return String(v);
      });
      rows.push(cells);
      maxCols = Math.max(maxCols, cells.length);
    });

    if (rows.length === 0) return;

    // Pad rows to consistent width
    const padded = rows.map(r => {
      while (r.length < maxCols) r.push('');
      return r;
    });

    // Build markdown table
    let table = `## Sheet: ${sheet.name}\n\n`;

    // Header row
    const headerRow = padded[0] || [];
    table += '| ' + headerRow.map(c => c || '—').join(' | ') + ' |\n';
    table += '| ' + headerRow.map(() => '---').join(' | ') + ' |\n';

    // Data rows
    for (let i = 1; i < padded.length; i++) {
      table += '| ' + padded[i].join(' | ') + ' |\n';
    }

    table += `\n*${padded.length} rows, ${maxCols} columns*\n`;
    sheets.push(table);
  });

  emit({ file: filename, phase: 'convert', detail: `Converted ${sheets.length} sheets`, progress: 70 });

  const header = `# ${filename}\n\n*AI-processed spreadsheet — ${sheets.length} sheet(s)*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return header + sheets.join('\n\n');
}

// ---------------------------------------------------------------------------
// Multi-Provider Vision API (Gemini or Claude)
// ---------------------------------------------------------------------------

/** Default provider for vision tasks. Prefers Claude (better accuracy), falls back to Gemini */
function getVisionProvider(): 'gemini' | 'claude' {
  if (env.ANTHROPIC_API_KEY) return 'claude';
  if (env.GEMINI_API_KEY) return 'gemini';
  throw AppError.badRequest('No vision AI provider configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY.');
}

export async function callVision(
  fileBuffer: Buffer,
  mimeType: string,
  prompt: string,
  provider?: 'gemini' | 'claude',
  model?: string,
  maxRetries = 3
): Promise<string> {
  const selectedProvider = provider || getVisionProvider();
  if (selectedProvider === 'claude') {
    return callClaudeVision(fileBuffer, mimeType, prompt, maxRetries, model);
  }
  return callGeminiVision(fileBuffer, mimeType, prompt, maxRetries, model);
}

async function callGeminiVision(
  fileBuffer: Buffer,
  mimeType: string,
  prompt: string,
  maxRetries = 3,
  modelOverride?: string
): Promise<string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw AppError.badRequest('GEMINI_API_KEY is required for Gemini vision');

  const model = modelOverride || 'gemini-3.0-flash';
  const base64Data = fileBuffer.toString('base64');
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: base64Data } },
                { text: prompt },
              ],
            }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 16384 },
          }),
        }
      );

      if (res.status === 429) {
        await delay(15000 * Math.pow(2, attempt) + Math.random() * 3000);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini API error (${res.status}): ${errText.substring(0, 200)}`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty Gemini response');
      return text;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) await delay(2000 * Math.pow(2, attempt) + Math.random() * 1000);
    }
  }
  throw lastError || new Error('Gemini vision call failed');
}

async function callClaudeVision(
  fileBuffer: Buffer,
  mimeType: string,
  prompt: string,
  maxRetries = 3,
  modelOverride?: string
): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw AppError.badRequest('ANTHROPIC_API_KEY is required for Claude vision');

  const model = modelOverride || 'claude-sonnet-4-6';
  const base64Data = fileBuffer.toString('base64');

  // Claude uses 'document' type for PDFs, 'image' type for images
  const isPdf = mimeType === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64Data } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64Data } };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          messages: [{
            role: 'user',
            content: [contentBlock, { type: 'text', text: prompt }],
          }],
        }),
      });

      if (res.status === 429) {
        await delay(15000 * Math.pow(2, attempt) + Math.random() * 3000);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Claude API error (${res.status}): ${errText.substring(0, 200)}`);
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = data.content?.find(b => b.type === 'text')?.text;
      if (!text) throw new Error('Empty Claude response');
      return text;
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) await delay(2000 * Math.pow(2, attempt) + Math.random() * 1000);
    }
  }
  throw lastError || new Error('Claude vision call failed');
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function buildPdfPagePrompt(pageNum: number, totalPages: number): string {
  return `You are an expert document analyst. Extract ALL content from this PDF page (page ${pageNum} of ${totalPages}) as clean, structured Markdown.

Rules:
- Preserve ALL headings with proper # levels
- Preserve ALL tables using Markdown table syntax (align columns properly)
- Preserve ALL bullet points and numbered lists
- Preserve ALL financial figures, numbers, and data exactly as shown
- Preserve ALL performance metrics, targets, and percentages
- Transcribe ALL text content accurately — this is an OCR task
- If the page contains charts or graphs, describe them in detail: title, axes, data points, trends
- If the page contains images or diagrams, describe them thoroughly
- Include footnotes and references
- Do NOT add commentary or interpretation
- If the page is blank or contains only headers/footers, output "<!-- blank page -->"

Output ONLY the Markdown, nothing else.`;
}

export function buildImagePrompt(filename: string): string {
  return `You are an expert visual analyst performing comprehensive image recognition and OCR on the file "${filename}".

Perform ALL of the following that apply:

1. **Text Recognition (OCR)**: Transcribe every piece of text visible in the image, maintaining layout and hierarchy.

2. **Visual Description**: Describe what the image shows — objects, people, scenes, colors, composition, context.

3. **Structured Data Extraction**: If the image contains any structured content, convert it to proper Markdown:
   - Tables → Markdown tables with proper alignment
   - Charts/Graphs → Describe the chart type, title, axes, data points, trends, and recreate the data as a table if possible
   - Diagrams → Describe the structure, nodes, connections, and flow
   - Forms → Extract all field labels and values
   - Organizational charts → Convert to hierarchical list or table

4. **Context**: Note the apparent purpose of this image (screenshot, photograph, diagram, chart, scan, etc.)

Output well-structured Markdown. Use headings, tables, and lists as appropriate. Be thorough — extract everything visible.`;
}

export function buildDocxPrompt(filename: string): string {
  return `You are an expert document analyst. The file "${filename}" is a Word document that may contain images, diagrams, charts, or complex formatting that wasn't captured by text extraction.

Analyze the visual content and extract:
1. Any text visible in images or diagrams
2. Chart data (recreate as Markdown tables)
3. Diagram descriptions (flows, org charts, etc.)
4. Any other visual content

Output structured Markdown.`;
}

export function buildDocxImagePrompt(filename: string): string {
  return [
    `Analyze this image from the Word document "${filename}".`,
    'If it contains text or a scanned page, transcribe ALL text verbatim.',
    'If it\'s a chart, graph, or diagram, extract all data points, labels, axes, and legends.',
    'If it\'s a form, extract all field names and values.',
    'If it\'s a photo or logo, describe what it depicts.',
    'Be thorough — this text replaces the image in the AI-readable version.',
  ].join(' ');
}

export function buildPptxImagePrompt(): string {
  return 'Describe this image from a PowerPoint presentation. If it\'s a chart, graph, or diagram, extract all data and labels. If it\'s a photo, describe what it shows. Be concise but thorough.';
}

// ---------------------------------------------------------------------------
// Decomposed Functions — used by the DB-backed queue for sub-job processing
// ---------------------------------------------------------------------------

/** Supported vision MIME types (skip EMF, WMF, etc.) */
export const VISION_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/tiff',
]);

/**
 * Split a PDF into individual page buffers.
 */
export async function splitPdfPages(buffer: Buffer): Promise<Array<{ pageIndex: number; pageBuffer: Buffer }>> {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.load(buffer);
  const pageCount = pdfDoc.getPageCount();
  const pages: Array<{ pageIndex: number; pageBuffer: Buffer }> = [];

  for (let i = 0; i < pageCount; i++) {
    const singlePageDoc = await PDFDocument.create();
    const [copiedPage] = await singlePageDoc.copyPages(pdfDoc, [i]);
    singlePageDoc.addPage(copiedPage);
    pages.push({ pageIndex: i, pageBuffer: Buffer.from(await singlePageDoc.save()) });
  }

  return pages;
}

/**
 * Extract text and embedded images from a DOCX file.
 * Returns text markdown + image buffers ready for vision API.
 */
export async function extractDocxContent(buffer: Buffer, filename: string): Promise<{
  textMarkdown: string;
  images: Array<{ buffer: Buffer; contentType: string; alt: string }>;
}> {
  const mammothLib = await import('mammoth');
  const mammoth = mammothLib.default || mammothLib;

  const images: Array<{ buffer: Buffer; contentType: string; alt: string }> = [];
  let imageIndex = 0;

  const result = await (mammoth as any).convertToMarkdown(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image: any) => {
        imageIndex++;
        try {
          const imgBuf = await image.read();
          const ct = image.contentType || 'image/png';
          images.push({ buffer: imgBuf, contentType: ct, alt: image.altText || '' });
        } catch { /* skip unreadable images */ }
        return { src: `#image-${imageIndex}` };
      }),
    }
  );

  let textMarkdown = result.value || '';
  textMarkdown = textMarkdown.replace(/!\[([^\]]*)\]\(#image-(\d+)\)/g, '*[Image $2: $1]*');
  textMarkdown = textMarkdown.replace(/!\[[^\]]*\]\(data:[^)]+\)/g, '*[embedded image]*');

  const header = `# ${filename}\n\n*AI-processed DOCX document*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return { textMarkdown: header + textMarkdown, images };
}

/**
 * Extract slide text/tables/notes and embedded images from a PPTX file.
 */
export async function extractPptxContent(buffer: Buffer, filename: string): Promise<{
  slidesMarkdown: string;
  images: Array<{ buffer: Buffer; mimeType: string; mediaFile: string }>;
}> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  const slideFiles = Object.keys(zip.files)
    .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return numA - numB;
    });

  const slides: string[] = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const slideXml = await zip.files[slideFiles[i]].async('string');
    const text = extractSlideText(slideXml);
    const tables = extractTables(slideXml);

    const noteFile = `ppt/notesSlides/notesSlide${i + 1}.xml`;
    let notes = '';
    if (zip.files[noteFile]) {
      const noteXml = await zip.files[noteFile].async('string');
      notes = extractNotesText(noteXml);
      if (notes && !/^slide \d+$/i.test(notes.trim())) {
        notes = `\n\n**Speaker Notes:** ${notes}`;
      } else {
        notes = '';
      }
    }

    let slideMd = `## Slide ${i + 1}\n\n`;
    if (text) slideMd += text + '\n';
    if (tables.length > 0) slideMd += '\n' + tables.join('\n') + '\n';
    if (notes) slideMd += notes + '\n';

    slides.push(slideMd);
  }

  // Extract embedded images
  const mediaFiles = Object.keys(zip.files).filter(
    f => /^ppt\/media\/image\d+\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(f)
  );
  const images: Array<{ buffer: Buffer; mimeType: string; mediaFile: string }> = [];
  for (const mf of mediaFiles) {
    const imgBuffer = Buffer.from(await zip.files[mf].async('arraybuffer'));
    if (imgBuffer.length < 5000) continue; // skip tiny icons
    const ext = mf.split('.').pop()?.toLowerCase() || 'png';
    images.push({ buffer: imgBuffer, mimeType: `image/${ext === 'jpg' ? 'jpeg' : ext}`, mediaFile: mf });
  }

  const header = `# ${filename}\n\n*AI-processed PowerPoint — ${slideFiles.length} slides, ${images.length} embedded images*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return { slidesMarkdown: header + slides.join('\n\n---\n\n'), images };
}

/**
 * Process an XLSX/CSV file into markdown tables. No vision API needed.
 */
export async function processXlsxToMarkdown(buffer: Buffer, filename: string): Promise<string> {
  const ExcelJS = await import('exceljs');
  const workbook = new (ExcelJS as any).Workbook();

  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'csv') {
    const { Readable } = await import('stream');
    const stream = Readable.from(buffer);
    await workbook.csv.read(stream);
  } else {
    await workbook.xlsx.load(buffer as any);
  }

  const sheets: string[] = [];
  workbook.eachSheet((sheet: any) => {
    const rows: string[][] = [];
    let maxCols = 0;
    sheet.eachRow({ includeEmpty: false }, (row: any) => {
      const cells = (row.values as any[]).slice(1).map((v: any) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && v.result !== undefined) return String(v.result);
        if (typeof v === 'object' && v.text) return String(v.text);
        return String(v);
      });
      rows.push(cells);
      maxCols = Math.max(maxCols, cells.length);
    });
    if (rows.length === 0) return;
    const padded = rows.map(r => { while (r.length < maxCols) r.push(''); return r; });
    let table = `## Sheet: ${sheet.name}\n\n`;
    const headerRow = padded[0] || [];
    table += '| ' + headerRow.map((c: string) => c || '—').join(' | ') + ' |\n';
    table += '| ' + headerRow.map(() => '---').join(' | ') + ' |\n';
    for (let i = 1; i < padded.length; i++) {
      table += '| ' + padded[i].join(' | ') + ' |\n';
    }
    table += `\n*${padded.length} rows, ${maxCols} columns*\n`;
    sheets.push(table);
  });

  const header = `# ${filename}\n\n*AI-processed spreadsheet — ${sheets.length} sheet(s)*\n*Generated: ${new Date().toISOString()}*\n\n`;
  return header + sheets.join('\n\n');
}

// ---------------------------------------------------------------------------
// Merge Functions — assemble sub-job results into final markdown
// ---------------------------------------------------------------------------

export interface SubJobResult {
  sequenceNum: number;
  markdown: string | null;
  failed: boolean;
  errorMessage?: string;
}

export function mergePdfResults(
  filename: string,
  pageCount: number,
  pages: SubJobResult[],
  sourceCTag?: string
): string {
  const successCount = pages.filter(p => !p.failed).length;
  const failCount = pages.filter(p => p.failed).length;

  const hashComment = sourceCTag ? `<!-- source-ctag: ${sourceCTag} -->\n` : '';
  const header = `# ${filename}\n\n*AI-processed document — ${pageCount} pages extracted (${successCount} OK, ${failCount} failed)*\n*Generated: ${new Date().toISOString()}*\n`;

  const pageMarkdowns = pages
    .sort((a, b) => a.sequenceNum - b.sequenceNum)
    .map(p => {
      const pageNum = p.sequenceNum + 1;
      if (p.failed) return `\n\n---\n## Page ${pageNum}\n\n*[Page extraction failed: ${p.errorMessage || 'unknown error'}]*`;
      return `\n\n---\n## Page ${pageNum}\n\n${p.markdown || ''}`;
    });

  return hashComment + header + pageMarkdowns.join('');
}

export function mergeDocxResults(
  filename: string,
  textMarkdown: string,
  imageResults: SubJobResult[],
  sourceCTag?: string
): string {
  const hashComment = sourceCTag ? `<!-- source-ctag: ${sourceCTag} -->\n` : '';
  let output = hashComment + textMarkdown;

  const significantImages = imageResults.filter(r => r.markdown || r.failed);
  if (significantImages.length > 0) {
    const descriptions = significantImages
      .sort((a, b) => a.sequenceNum - b.sequenceNum)
      .map(r => {
        if (r.failed) return `### Image ${r.sequenceNum}\n\n*[Image processing failed: ${r.errorMessage || 'unknown error'}]*`;
        return `### Image ${r.sequenceNum}\n\n${r.markdown}`;
      });
    output += '\n\n## Embedded Images — AI Descriptions\n\n' + descriptions.join('\n\n---\n\n');
  }

  return output;
}

export function mergePptxResults(
  filename: string,
  slidesMarkdown: string,
  imageResults: SubJobResult[],
  sourceCTag?: string
): string {
  const hashComment = sourceCTag ? `<!-- source-ctag: ${sourceCTag} -->\n` : '';
  let output = hashComment + slidesMarkdown;

  const significantImages = imageResults.filter(r => r.markdown || r.failed);
  if (significantImages.length > 0) {
    const descriptions = significantImages
      .sort((a, b) => a.sequenceNum - b.sequenceNum)
      .map(r => {
        if (r.failed) return `### Embedded Image ${r.sequenceNum}\n\n*[Image processing failed: ${r.errorMessage || 'unknown error'}]*`;
        return `### Embedded Image ${r.sequenceNum}\n\n${r.markdown}`;
      });
    output += '\n\n## Embedded Media\n\n' + descriptions.join('\n\n');
  }

  return output;
}

/**
 * Determine the file_type category for a filename.
 */
export function getFileType(filename: string): FileType | null {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (PPTX_EXTENSIONS.has(ext)) return 'pptx';
  if (ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (ext === 'csv') return 'csv';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

type FileType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'csv' | 'image';
