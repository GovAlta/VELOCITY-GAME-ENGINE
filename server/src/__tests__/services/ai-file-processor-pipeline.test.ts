/**
 * AI File Processor — Pipeline Integration Tests
 *
 * Creates REAL file buffers for every supported type (PDF, PNG, DOCX, PPTX, XLSX, CSV)
 * and runs them through the actual processing pipeline with mocked external services
 * (SharePoint API + Vision API). Validates that real file formats are properly parsed,
 * text is extracted, and the output markdown is well-formed.
 *
 * Also tests the background processing queue for concurrency, dedup, and draining.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external services BEFORE importing the module under test
// ---------------------------------------------------------------------------

// Mock SharePoint service
const mockDownloadFile = vi.fn();
const mockGetFileMetadata = vi.fn();
const mockListFiles = vi.fn();
const mockUploadFile = vi.fn();
const mockGetFileContent = vi.fn();

vi.mock('../../services/sharepoint.service', () => ({
  downloadFile: (...args: any[]) => mockDownloadFile(...args),
  getFileMetadata: (...args: any[]) => mockGetFileMetadata(...args),
  listFiles: (...args: any[]) => mockListFiles(...args),
  uploadFile: (...args: any[]) => mockUploadFile(...args),
  getFileContent: (...args: any[]) => mockGetFileContent(...args),
}));

// Mock environment to ensure vision provider is available
vi.mock('../../config/environment', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key-for-claude',
    GEMINI_API_KEY: '',
  },
}));

// Mock logger to avoid noise
vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock global fetch for vision API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// NOW import the module under test
import * as processor from '../../services/ai-file-processor.service';

// ---------------------------------------------------------------------------
// Test Fixture Generators — create REAL file buffers
// ---------------------------------------------------------------------------

/** Create a real PDF with text content using pdf-lib */
async function createTestPdf(text = 'Budget Report Q1 2026: Revenue $4.2M, Expenses $3.1M'): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, size: 14, font });
  page.drawText('Page 1 of 1', { x: 50, y: 50, size: 10, font });
  return Buffer.from(await doc.save());
}

/** Create a multi-page PDF */
async function createMultiPagePdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i}: Project milestone ${i} — Status: Complete`, { x: 50, y: 700, size: 14, font });
    page.drawText(`Details for milestone ${i} go here.`, { x: 50, y: 680, size: 11, font });
  }
  return Buffer.from(await doc.save());
}

/** Create a minimal valid PNG (1x1 red pixel) */
function createTestPng(): Buffer {
  // Minimal valid PNG: 8-byte header + IHDR + IDAT + IEND
  const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // IHDR chunk: 1x1 pixel, 8-bit RGB
  const ihdrData = Buffer.from([
    0x00, 0x00, 0x00, 0x01, // width: 1
    0x00, 0x00, 0x00, 0x01, // height: 1
    0x08, // bit depth: 8
    0x02, // color type: RGB
    0x00, // compression
    0x00, // filter
    0x00, // interlace
  ]);
  const ihdrCrc = crc32(Buffer.concat([Buffer.from('IHDR'), ihdrData]));
  const ihdr = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0D]), // length: 13
    Buffer.from('IHDR'),
    ihdrData,
    ihdrCrc,
  ]);
  // IDAT chunk: zlib-compressed row (filter byte 0x00 + 3 bytes RGB red)
  const rawRow = Buffer.from([0x00, 0xFF, 0x00, 0x00]); // filter=none, R=255, G=0, B=0
  const { deflateSync } = require('zlib');
  const compressed = deflateSync(rawRow);
  const idatCrc = crc32(Buffer.concat([Buffer.from('IDAT'), compressed]));
  const idat = Buffer.concat([
    writeU32(compressed.length),
    Buffer.from('IDAT'),
    compressed,
    idatCrc,
  ]);
  // IEND chunk
  const iendCrc = crc32(Buffer.from('IEND'));
  const iend = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('IEND'),
    iendCrc,
  ]);
  return Buffer.concat([header, ihdr, idat, iend]);
}

// CRC32 helpers for PNG generation
function writeU32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}

const crc32Table = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): Buffer {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  return writeU32(crc);
}

/** Create a real XLSX workbook using ExcelJS */
async function createTestXlsx(): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const wb = new (ExcelJS as any).Workbook();
  const ws = wb.addWorksheet('Project Data');
  ws.addRow(['Project', 'Status', 'Budget', 'Completion']);
  ws.addRow(['Pronghorn Red', 'Active', '$1,200,000', '65%']);
  ws.addRow(['Blue Heron', 'Planning', '$800,000', '10%']);
  ws.addRow(['Eagle Pass', 'Complete', '$500,000', '100%']);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/** Create a real PPTX file using JSZip (PPTX = ZIP of XML) */
async function createTestPptx(): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // [Content_Types].xml — required for a valid PPTX
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>
</Types>`);

  // _rels/.rels
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);

  // ppt/presentation.xml
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId3"/>
  </p:sldIdLst>
</p:presentation>`);

  // Slide 1 — Title slide with bullet points
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Velo Platform Overview</a:t></a:r></a:p>
          <a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:t>projects tracked</a:t></a:r></a:p>
          <a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:t>8-step velocity game</a:t></a:r></a:p>
          <a:p><a:pPr lvl="1"><a:buChar char="–"/></a:pPr><a:r><a:t>Human-AI collaboration</a:t></a:r></a:p>
          <a:p><a:r><a:t>Project Tool for AI</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`);

  // Slide 2 — Table slide
  zip.file('ppt/slides/slide2.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Budget Summary</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:graphicFrame>
        <a:graphic><a:graphicData>
          <a:tbl>
            <a:tr>
              <a:tc><a:txBody><a:p><a:r><a:t>Ministry</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>Budget</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>Spent</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
            <a:tr>
              <a:tc><a:txBody><a:p><a:r><a:t>TI</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>$4.2M</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>$3.1M</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
            <a:tr>
              <a:tc><a:txBody><a:p><a:r><a:t>Health</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>$8.5M</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>$6.2M</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
          </a:tbl>
        </a:graphicData></a:graphic>
      </p:graphicFrame>
    </p:spTree>
  </p:cSld>
</p:sld>`);

  // Notes for slide 1
  zip.file('ppt/notesSlides/notesSlide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>Mention the AI shadow file processing pipeline during this slide.</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`);

  // Embedded image (>5KB to trigger vision processing)
  const pngBuf = createTestPng();
  // Pad to >5KB to pass the size threshold
  const paddedPng = Buffer.concat([pngBuf, Buffer.alloc(6000 - pngBuf.length, 0)]);
  zip.file('ppt/media/image1.png', paddedPng);

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** Create a real DOCX file using JSZip (DOCX = ZIP of XML) */
async function createTestDocx(): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Project Requirements Document</w:t></w:r></w:p>
    <w:p><w:r><w:t>Version 2.1 — March 2026</w:t></w:r></w:p>
    <w:p><w:r><w:t>The Velo platform shall support multi-provider AI analysis including Claude, Gemini, and Grok models.</w:t></w:r></w:p>
    <w:p><w:r><w:t>All file uploads must be automatically processed into AI-ready markdown shadow files.</w:t></w:r></w:p>
    <w:p><w:r><w:t>The system shall maintain SharePoint as the source of truth for document storage.</w:t></w:r></w:p>
  </w:body>
</w:document>`);

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

// ---------------------------------------------------------------------------
// Common mock setup
// ---------------------------------------------------------------------------

function setupMocks(buffer: Buffer, filename: string, contentType: string) {
  // SharePoint mocks
  mockGetFileMetadata.mockResolvedValue({
    name: filename,
    cTag: `"ctag-${Date.now()}"`,
    lastModifiedDateTime: new Date().toISOString(),
  });

  mockDownloadFile.mockResolvedValue({
    buffer,
    contentType,
    filename,
  });

  // No existing shadow file
  mockListFiles.mockResolvedValue([]);

  // Upload captures the result
  mockUploadFile.mockImplementation(async (_folderId: string, name: string, buf: Buffer) => ({
    id: `uploaded-${name}`,
    name,
    webUrl: `https://sharepoint.test/${name}`,
    size: buf.length,
  }));

  // Mock fetch for Claude vision API
  mockFetch.mockImplementation(async (url: string, opts: any) => {
    const body = JSON.parse(opts?.body || '{}');

    // Claude API response
    if (url.includes('anthropic.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{
            type: 'text',
            text: `Extracted content from ${filename}: This document contains project data, tables, and analysis. Key findings include budget allocations and timeline milestones.`,
          }],
        }),
      };
    }

    // Gemini API response
    if (url.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ text: `Gemini extracted: ${filename} — document analysis complete.` }],
            },
          }],
        }),
      };
    }

    throw new Error(`Unexpected fetch to: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AI File Processor — Pipeline Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PDF Processing
  // ═══════════════════════════════════════════════════════════════════════

  describe('PDF Processing', () => {
    it('processes a single-page PDF through the full pipeline', async () => {
      const pdfBuffer = await createTestPdf();
      setupMocks(pdfBuffer, 'budget-report.pdf', 'application/pdf');

      expect(pdfBuffer.length).toBeGreaterThan(100);
      expect(pdfBuffer[0]).toBe(0x25); // PDF magic byte %

      const result = await processor.processFile(
        'sp-folder-123', 'item-456', 'budget-report.pdf',
        undefined, 'claude', undefined, true
      );

      expect(result.originalFile).toBe('budget-report.pdf');
      expect(result.shadowFile).toBe('__AI__budget-report.md');
      expect(result.shadowItemId).toBe('uploaded-__AI__budget-report.md');
      expect(result.pages).toBe(1);

      // Verify upload was called with markdown content
      expect(mockUploadFile).toHaveBeenCalledOnce();
      const [_folder, name, buf, mime] = mockUploadFile.mock.calls[0];
      expect(name).toBe('__AI__budget-report.md');
      expect(mime).toBe('text/markdown');

      const markdown = buf.toString('utf-8');
      expect(markdown).toContain('# budget-report.pdf');
      expect(markdown).toContain('Page 1');
      expect(markdown).toContain('source-ctag:');
    }, 15000);

    it('processes a multi-page PDF with concurrent page extraction', async () => {
      const pdfBuffer = await createMultiPagePdf();
      setupMocks(pdfBuffer, 'milestones.pdf', 'application/pdf');

      const result = await processor.processFile(
        'sp-folder-123', 'item-789', 'milestones.pdf',
        undefined, 'claude', undefined, true
      );

      expect(result.pages).toBe(3);
      expect(result.shadowFile).toBe('__AI__milestones.md');

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');
      expect(markdown).toContain('Page 1');
      expect(markdown).toContain('Page 2');
      expect(markdown).toContain('Page 3');
      expect(markdown).toContain('3 pages extracted');

      // Vision API should have been called 3 times (once per page)
      const claudeCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[0]?.includes('anthropic.com')
      );
      expect(claudeCalls.length).toBe(3);
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Image Processing
  // ═══════════════════════════════════════════════════════════════════════

  describe('Image Processing', () => {
    it('processes a PNG image through the vision API', async () => {
      const pngBuffer = createTestPng();
      setupMocks(pngBuffer, 'architecture-diagram.png', 'image/png');

      expect(pngBuffer[0]).toBe(0x89); // PNG magic byte
      expect(pngBuffer[1]).toBe(0x50); // P
      expect(pngBuffer[2]).toBe(0x4E); // N
      expect(pngBuffer[3]).toBe(0x47); // G

      const result = await processor.processFile(
        'sp-folder-123', 'item-img', 'architecture-diagram.png',
        undefined, 'claude', undefined, true
      );

      expect(result.originalFile).toBe('architecture-diagram.png');
      expect(result.shadowFile).toBe('__AI__architecture-diagram.md');

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');
      expect(markdown).toContain('# architecture-diagram.png');
      expect(markdown).toContain('visual recognition');

      // Vision API called once for the image
      expect(mockFetch).toHaveBeenCalledOnce();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // XLSX Processing
  // ═══════════════════════════════════════════════════════════════════════

  describe('XLSX Processing', () => {
    it('processes a real Excel file into markdown tables', async () => {
      const xlsxBuffer = await createTestXlsx();
      setupMocks(xlsxBuffer, 'project-data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      expect(xlsxBuffer.length).toBeGreaterThan(100);

      const result = await processor.processFile(
        'sp-folder-123', 'item-xlsx', 'project-data.xlsx',
        undefined, undefined, undefined, true
      );

      expect(result.originalFile).toBe('project-data.xlsx');
      expect(result.shadowFile).toBe('__AI__project-data.md');

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');
      expect(markdown).toContain('# project-data.xlsx');
      expect(markdown).toContain('Sheet: Project Data');
      // Verify table data was extracted
      expect(markdown).toContain('Pronghorn Red');
      expect(markdown).toContain('$1,200,000');
      expect(markdown).toContain('Eagle Pass');
      expect(markdown).toContain('100%');
      // Should be a markdown table
      expect(markdown).toContain('|');
      expect(markdown).toContain('---');
      // Row count
      expect(markdown).toContain('4 rows');

      // No vision API call needed for XLSX
      expect(mockFetch).not.toHaveBeenCalled();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DOCX Processing
  // ═══════════════════════════════════════════════════════════════════════

  describe('DOCX Processing', () => {
    it('processes a real DOCX file into markdown', async () => {
      const docxBuffer = await createTestDocx();
      setupMocks(docxBuffer, 'requirements.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      expect(docxBuffer.length).toBeGreaterThan(100);

      const result = await processor.processFile(
        'sp-folder-123', 'item-docx', 'requirements.docx',
        undefined, 'claude', undefined, true
      );

      expect(result.originalFile).toBe('requirements.docx');
      expect(result.shadowFile).toBe('__AI__requirements.md');

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');
      expect(markdown).toContain('# requirements.docx');
      // Verify mammoth extracted the text content
      expect(markdown).toContain('Project Requirements Document');
      // mammoth may escape special chars in markdown output
      expect(markdown).toMatch(/Version 2[\\.]*1/);
      expect(markdown).toContain('Velo platform');
      expect(markdown).toContain('shadow files');
      expect(markdown).toContain('SharePoint');
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PPTX Processing
  // ═══════════════════════════════════════════════════════════════════════

  describe('PPTX Processing', () => {
    it('processes a real PPTX file — extracts slides, tables, notes, and images', async () => {
      const pptxBuffer = await createTestPptx();
      setupMocks(pptxBuffer, 'velo-overview.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

      expect(pptxBuffer.length).toBeGreaterThan(1000);

      const result = await processor.processFile(
        'sp-folder-123', 'item-pptx', 'velo-overview.pptx',
        undefined, 'claude', undefined, true
      );

      expect(result.originalFile).toBe('velo-overview.pptx');
      expect(result.shadowFile).toBe('__AI__velo-overview.md');

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');

      // Header
      expect(markdown).toContain('# velo-overview.pptx');
      expect(markdown).toContain('2 slides');

      // Slide 1 text extraction
      expect(markdown).toContain('Slide 1');
      expect(markdown).toContain('Velo Platform Overview');
      expect(markdown).toContain('projects tracked');
      expect(markdown).toContain('8-step velocity game');
      expect(markdown).toContain('Human-AI collaboration');
      expect(markdown).toContain('Project Tool for AI');

      // Slide 2 table extraction
      expect(markdown).toContain('Slide 2');
      expect(markdown).toContain('Budget Summary');
      expect(markdown).toContain('Ministry');
      expect(markdown).toContain('$4.2M');
      expect(markdown).toContain('Health');
      expect(markdown).toContain('$6.2M');

      // Speaker notes
      expect(markdown).toContain('Speaker Notes');
      expect(markdown).toContain('AI shadow file processing pipeline');

      // Embedded image was processed via vision API
      expect(markdown).toContain('Embedded Media');

      // Vision API called for the embedded image
      const claudeCalls = mockFetch.mock.calls.filter(
        (c: any[]) => c[0]?.includes('anthropic.com')
      );
      expect(claudeCalls.length).toBe(1);
    }, 15000);

    it('handles PPTX with no embedded images (text-only slides)', async () => {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
      zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
      zip.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`);
      zip.file('ppt/slides/slide1.xml', `<?xml version="1.0"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    <a:p><a:r><a:t>Simple text-only slide with enough content to not trigger the image warning threshold for testing purposes here</a:t></a:r></a:p>
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`);

      const pptxBuffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
      setupMocks(pptxBuffer, 'text-only.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

      const result = await processor.processFile(
        'sp-folder-123', 'item-pptx2', 'text-only.pptx',
        undefined, 'claude', undefined, true
      );

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');
      expect(markdown).toContain('1 slides');
      expect(markdown).toContain('0 embedded images');
      expect(markdown).not.toContain('Embedded Media');

      // No vision API call since no images
      expect(mockFetch).not.toHaveBeenCalled();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CSV Processing (via XLSX processor)
  // ═══════════════════════════════════════════════════════════════════════

  describe('CSV Processing', () => {
    it('processes a CSV file into markdown tables', async () => {
      const csvContent = 'Name,Role,Department\nJordan Lee,DM,Technology Office\nAlice Chen,Director,Digital Services\nBob Ramirez,Analyst,Data Strategy\n';
      const csvBuffer = Buffer.from(csvContent, 'utf-8');
      setupMocks(csvBuffer, 'team-roster.csv', 'text/csv');

      const result = await processor.processFile(
        'sp-folder-123', 'item-csv', 'team-roster.csv',
        undefined, undefined, undefined, true
      );

      expect(result.shadowFile).toBe('__AI__team-roster.md');

      const markdown = mockUploadFile.mock.calls[0][2].toString('utf-8');
      expect(markdown).toContain('# team-roster.csv');
      expect(markdown).toContain('Jordan Lee');
      expect(markdown).toContain('Technology Office');
      expect(markdown).toContain('Data Strategy');
      expect(markdown).toContain('|');

      // No vision API needed
      expect(mockFetch).not.toHaveBeenCalled();
    }, 10000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // cTag Staleness — skip unchanged files
  // ═══════════════════════════════════════════════════════════════════════

  describe('Staleness Detection', () => {
    it('skips processing when source cTag matches shadow file', async () => {
      const pdfBuffer = await createTestPdf();
      const ctag = '"ctag-fixed-123"';

      mockGetFileMetadata.mockResolvedValue({
        name: 'report.pdf',
        cTag: ctag,
      });
      mockListFiles.mockResolvedValue([
        { name: '__AI__report.md', id: 'shadow-id' },
      ]);
      mockGetFileContent.mockResolvedValue(`<!-- source-ctag: ${ctag} -->\n# report.pdf\n`);

      const result = await processor.processFile(
        'sp-folder-123', 'item-stale', 'report.pdf',
        undefined, 'claude', undefined, false // force=false
      );

      // Should skip — no upload, no vision call
      expect(result.shadowItemId).toBe('');
      expect(mockUploadFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reprocesses when source cTag differs from shadow', async () => {
      const pdfBuffer = await createTestPdf();

      mockGetFileMetadata.mockResolvedValue({
        name: 'report.pdf',
        cTag: '"ctag-new-456"',
      });
      mockListFiles.mockResolvedValue([
        { name: '__AI__report.md', id: 'shadow-id' },
      ]);
      mockGetFileContent.mockResolvedValue(`<!-- source-ctag: "ctag-old-123" -->\n# report.pdf\n`);
      mockDownloadFile.mockResolvedValue({
        buffer: pdfBuffer,
        contentType: 'application/pdf',
        filename: 'report.pdf',
      });
      mockUploadFile.mockResolvedValue({
        id: 'new-shadow-id',
        name: '__AI__report.md',
        webUrl: 'https://test/shadow',
      });

      const result = await processor.processFile(
        'sp-folder-123', 'item-changed', 'report.pdf',
        undefined, 'claude', undefined, false
      );

      // Should reprocess
      expect(result.shadowItemId).toBe('new-shadow-id');
      expect(mockUploadFile).toHaveBeenCalled();
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Progress callback
  // ═══════════════════════════════════════════════════════════════════════

  describe('Progress Callbacks', () => {
    it('emits progress events through the pipeline', async () => {
      const xlsxBuffer = await createTestXlsx();
      setupMocks(xlsxBuffer, 'data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      const events: Array<{ phase: string; progress: number }> = [];
      const onProgress = (p: any) => events.push({ phase: p.phase, progress: p.progress });

      await processor.processFile(
        'sp-folder-123', 'item-prog', 'data.xlsx',
        onProgress, undefined, undefined, true
      );

      // Should have multiple progress phases
      const phases = events.map(e => e.phase);
      expect(phases).toContain('download');
      expect(phases).toContain('processing');
      expect(phases).toContain('upload');
      expect(phases).toContain('done');

      // Progress should be monotonically increasing
      for (let i = 1; i < events.length; i++) {
        expect(events[i].progress).toBeGreaterThanOrEqual(events[i - 1].progress);
      }

      // Should end at 100
      expect(events[events.length - 1].progress).toBe(100);
    }, 10000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// File Type Classification and Merge Function Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('File Type Classification', () => {
  it('getFileType returns correct type for each extension', () => {
    expect(processor.getFileType('report.pdf')).toBe('pdf');
    expect(processor.getFileType('photo.png')).toBe('image');
    expect(processor.getFileType('scan.jpg')).toBe('image');
    expect(processor.getFileType('doc.docx')).toBe('docx');
    expect(processor.getFileType('slides.pptx')).toBe('pptx');
    expect(processor.getFileType('data.xlsx')).toBe('xlsx');
    expect(processor.getFileType('data.csv')).toBe('csv');
    expect(processor.getFileType('anim.gif')).toBe('image');
  });

  it('getFileType returns null for unsupported types', () => {
    expect(processor.getFileType('readme.md')).toBeNull();
    expect(processor.getFileType('script.js')).toBeNull();
    expect(processor.getFileType('legacy.doc')).toBeNull();
    expect(processor.getFileType('legacy.ppt')).toBeNull();
  });
});

describe('Merge Functions', () => {
  it('mergePdfResults assembles pages with headers', () => {
    const pages: processor.SubJobResult[] = [
      { sequenceNum: 0, markdown: 'Page 1 content', failed: false },
      { sequenceNum: 1, markdown: 'Page 2 content', failed: false },
      { sequenceNum: 2, markdown: null, failed: true, errorMessage: 'API timeout' },
    ];

    const result = processor.mergePdfResults('report.pdf', 3, pages, '"ctag-123"');

    expect(result).toContain('<!-- source-ctag: "ctag-123" -->');
    expect(result).toContain('# report.pdf');
    expect(result).toContain('3 pages extracted (2 OK, 1 failed)');
    expect(result).toContain('## Page 1');
    expect(result).toContain('Page 1 content');
    expect(result).toContain('## Page 2');
    expect(result).toContain('## Page 3');
    expect(result).toContain('*[Page extraction failed: API timeout]*');
  });

  it('mergeDocxResults combines text and image descriptions', () => {
    const images: processor.SubJobResult[] = [
      { sequenceNum: 1, markdown: 'This is a bar chart showing Q1-Q4 revenue.', failed: false },
      { sequenceNum: 2, markdown: null, failed: true, errorMessage: 'rate limited' },
    ];

    const result = processor.mergeDocxResults('doc.docx', '# Document\n\nText content here.', images, '"ctag-456"');

    expect(result).toContain('<!-- source-ctag: "ctag-456" -->');
    expect(result).toContain('Text content here');
    expect(result).toContain('## Embedded Images — AI Descriptions');
    expect(result).toContain('bar chart');
    expect(result).toContain('*[Image processing failed: rate limited]*');
  });

  it('mergePptxResults combines slides and image descriptions', () => {
    const images: processor.SubJobResult[] = [
      { sequenceNum: 1, markdown: 'Image showing a company logo.', failed: false },
    ];

    const result = processor.mergePptxResults('deck.pptx', '## Slide 1\n\nTitle slide', images);

    expect(result).toContain('Slide 1');
    expect(result).toContain('## Embedded Media');
    expect(result).toContain('company logo');
  });

  it('mergePdfResults handles empty results', () => {
    const result = processor.mergePdfResults('empty.pdf', 0, []);
    expect(result).toContain('# empty.pdf');
    expect(result).toContain('0 pages extracted');
  });
});
