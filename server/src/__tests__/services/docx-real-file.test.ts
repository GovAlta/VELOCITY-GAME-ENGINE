/**
 * Real DOCX Pipeline Test
 *
 * Processes the actual test.docx from the repo root through the full pipeline.
 * Mocks SharePoint (download/upload) and vision API, but runs real mammoth
 * extraction to verify text + image extraction works on a real document.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ---------------------------------------------------------------------------
// Load the real test file
// ---------------------------------------------------------------------------
// CWD during vitest is app/server, so ../../ reaches the repo root (velo/)
const TEST_DOCX_PATH = resolve(process.cwd(), '../../test.docx');
let testBuffer: Buffer;

try {
  testBuffer = readFileSync(TEST_DOCX_PATH);
} catch {
  testBuffer = Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
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

vi.mock('../../config/environment', () => ({
  env: {
    ANTHROPIC_API_KEY: 'test-key',
    GEMINI_API_KEY: '',
  },
}));

vi.mock('../../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Track vision API calls
const visionCalls: Array<{ mimeType: string; bufferSize: number; prompt: string }> = [];

vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
  if (url.includes('anthropic.com')) {
    const body = JSON.parse(opts?.body || '{}');
    // Extract info about what was sent
    const content = body.messages?.[0]?.content || [];
    for (const block of content) {
      if (block.type === 'image' || block.type === 'document') {
        visionCalls.push({
          mimeType: block.source?.media_type || 'unknown',
          bufferSize: block.source?.data?.length || 0,
          prompt: content.find((c: any) => c.type === 'text')?.text?.substring(0, 100) || '',
        });
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{
          type: 'text',
          text: `[AI Vision Description: This image contains organizational content related to the document. The image shows text, graphics, or diagrams relevant to the document's purpose.]`,
        }],
      }),
    };
  }
  throw new Error(`Unexpected fetch: ${url}`);
}));

import * as processor from '../../services/ai-file-processor.service';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Real DOCX Processing — test.docx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    visionCalls.length = 0;

    mockGetFileMetadata.mockResolvedValue({
      name: 'test.docx',
      cTag: '"test-ctag-123"',
    });
    mockDownloadFile.mockResolvedValue({
      buffer: testBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'test.docx',
    });
    mockListFiles.mockResolvedValue([]);
    mockUploadFile.mockImplementation(async (_folderId: string, name: string, buf: Buffer) => ({
      id: `uploaded-${name}`,
      name,
      webUrl: `https://test/${name}`,
      size: buf.length,
    }));
  });

  it('should process the real test.docx file', async () => {
    if (testBuffer.length === 0) {
      console.log('⚠️  test.docx not found — skipping');
      return;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Processing test.docx (${(testBuffer.length / 1024).toFixed(0)} KB)`);
    console.log(`${'='.repeat(60)}\n`);

    // Track progress
    const progress: Array<{ phase: string; detail: string; progress: number }> = [];

    const result = await processor.processFile(
      'sp-folder-test',
      'item-test-docx',
      'test.docx',
      (p) => {
        progress.push({ phase: p.phase, detail: p.detail, progress: p.progress });
        console.log(`  [${p.phase.padEnd(10)}] ${p.detail} (${p.progress}%)`);
      },
      'claude',
      undefined,
      true, // force
    );

    // Get the uploaded markdown
    expect(mockUploadFile).toHaveBeenCalled();
    const uploadedBuffer = mockUploadFile.mock.calls[0][2] as Buffer;
    const markdown = uploadedBuffer.toString('utf-8');

    console.log(`\n${'─'.repeat(60)}`);
    console.log('  RESULTS');
    console.log(`${'─'.repeat(60)}`);
    console.log(`  Shadow file: ${result.shadowFile}`);
    console.log(`  Markdown size: ${(uploadedBuffer.length / 1024).toFixed(1)} KB`);
    console.log(`  Vision API calls: ${visionCalls.length}`);

    for (const call of visionCalls) {
      console.log(`    → ${call.mimeType} (${(call.bufferSize / 1024).toFixed(0)} KB base64)`);
    }

    // Check for base64 contamination
    const base64Count = (markdown.match(/data:image\/[^;]+;base64/g) || []).length;
    console.log(`  Base64 data URIs found: ${base64Count}`);

    // Show first 2000 chars of output
    console.log(`\n${'─'.repeat(60)}`);
    console.log('  MARKDOWN OUTPUT (first 2000 chars)');
    console.log(`${'─'.repeat(60)}`);
    console.log(markdown.substring(0, 2000));

    if (markdown.length > 2000) {
      console.log(`\n  ... (${(markdown.length / 1024).toFixed(1)} KB total, truncated)`);
    }

    // Show image descriptions section if present
    const imgSection = markdown.indexOf('## Embedded Images');
    if (imgSection !== -1) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log('  IMAGE DESCRIPTIONS SECTION');
      console.log(`${'─'.repeat(60)}`);
      console.log(markdown.substring(imgSection, imgSection + 1500));
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('  ASSERTIONS');
    console.log(`${'='.repeat(60)}`);

    // Core assertions
    expect(result.shadowFile).toBe('__AI__test.md');
    expect(markdown).toContain('# test.docx');
    expect(markdown).toContain('source-ctag:');

    // NO base64 blobs
    expect(base64Count).toBe(0);
    console.log(`  ✓ No base64 data URIs in output`);

    // If images were found, vision API should have been called
    if (visionCalls.length > 0) {
      expect(markdown).toContain('Embedded Images');
      expect(markdown).toContain('AI Vision Description');
      console.log(`  ✓ ${visionCalls.length} images sent to vision API`);
      console.log(`  ✓ Image descriptions present in output`);
    } else {
      console.log(`  ✓ No significant images found (text-only document)`);
    }

    // Markdown should have actual text content (not just placeholders)
    const textWithoutHeaders = markdown
      .replace(/^#.*$/gm, '')
      .replace(/\*\[.*?\]\*/g, '')
      .replace(/\*.*?\*/g, '')
      .replace(/<!--.*?-->/g, '')
      .trim();
    expect(textWithoutHeaders.length).toBeGreaterThan(50);
    console.log(`  ✓ Text content extracted (${textWithoutHeaders.length} chars)`);

    console.log(`\n  All assertions passed ✓\n`);
  }, 30000);
});
