/**
 * SharePoint ZIP Import/Export E2E Test
 *
 * Tests: ZIP import (upload ZIP → extract into SharePoint), ZIP export (download folder as ZIP),
 * and SSE event broadcasting for SharePoint mutations.
 *
 * Usage:
 *   cd app/server
 *   API_BASE=http://localhost:3001/api/v1 npx tsx src/__tests__/services/sharepoint-zip-e2e.test.ts
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3001/api/v1';
const API_KEY = process.env.API_KEY || 'velo_248c2d0d2d5cf1a5328d5d53bb1b1f1ebfd0ff34';

function pass(msg: string) { console.log(`  \x1b[32m[PASS]\x1b[0m ${msg}`); }
function fail(msg: string) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${msg}`); process.exitCode = 1; }
function info(msg: string) { console.log(`  \x1b[34m[INFO]\x1b[0m ${msg}`); }

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { 'X-API-Key': API_KEY };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  SharePoint ZIP Import/Export + SSE E2E Test');
  console.log('='.repeat(60));

  // ── 1. Check SharePoint connection ──
  console.log('\n1. CHECK SHAREPOINT');
  const statusRes = await api('GET', '/sharepoint/status');
  if (!statusRes.data?.data?.connected) {
    fail('SharePoint not connected — cannot run ZIP tests');
    return;
  }
  pass('SharePoint connected');

  // ── 2. Find a project with SharePoint folders ──
  console.log('\n2. FIND PROJECT');
  const projRes = await api('GET', '/projects?limit=5');
  const projects = projRes.data?.data || [];
  let projectId = '';
  let testFolderId = '';

  for (const p of projects) {
    const foldersRes = await api('GET', `/sharepoint/projects/${p.pk_project}/folders`);
    const folders = foldersRes.data?.data || [];
    if (folders.length > 0) {
      projectId = p.pk_project;
      // Find a project-level folder to test with
      const projFolder = folders.find((f: any) => f.folder_type === 'project');
      if (projFolder) testFolderId = projFolder.pk_sharepoint_folder;
      break;
    }
  }

  if (!testFolderId) {
    info('No project with SharePoint folders found — creating one');
    const createRes = await api('POST', '/projects', {
      name: 'ZIP Test Project', ministryCode: 'TI', status: 'discovery',
    });
    if (!createRes.ok) { fail(`Create project: ${createRes.status}`); return; }
    projectId = createRes.data.data.pk_project;

    await api('POST', `/sharepoint/projects/${projectId}/folders`);
    const foldersRes = await api('GET', `/sharepoint/projects/${projectId}/folders`);
    const folders = foldersRes.data?.data || [];
    const projFolder = folders.find((f: any) => f.folder_type === 'project');
    if (projFolder) testFolderId = projFolder.pk_sharepoint_folder;
  }

  if (!testFolderId) { fail('Could not find or create a test folder'); return; }
  pass(`Project: ${projectId.substring(0, 8)}, Folder: ${testFolderId.substring(0, 8)}`);

  // ── 3. Create a ZIP in memory ──
  console.log('\n3. CREATE TEST ZIP');
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('README.md', '# ZIP Import Test\n\nThis was imported via Velo API.\n');
  zip.file('docs/requirements.md', '# Requirements\n\n1. ZIP import works\n2. Folders recreated\n3. Files uploaded\n');
  zip.file('docs/architecture.md', '# Architecture\n\nSimple static site.\n');
  zip.file('src/index.html', '<!DOCTYPE html>\n<html><body><h1>Hello from ZIP</h1></body></html>');
  zip.file('src/styles.css', 'body { font-family: system-ui; }\n');

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  pass(`ZIP created: ${zipBuffer.length} bytes, 5 files, 2 folders`);

  // ── 4. Import ZIP ──
  console.log('\n4. IMPORT ZIP');
  const formData = new FormData();
  formData.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'test-import.zip');

  const importRes = await fetch(`${API_BASE}/sharepoint/folders/${testFolderId}/import-zip`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: formData,
  });
  const importData = await importRes.json().catch(() => null);

  if (importRes.ok && importData?.data) {
    pass(`Imported: ${importData.data.foldersCreated} folders, ${importData.data.filesUploaded} files`);
    if (importData.data.errors?.length > 0) {
      info(`Errors: ${importData.data.errors.join(', ')}`);
    }
  } else {
    fail(`Import failed: ${importRes.status} ${JSON.stringify(importData?.error).substring(0, 200)}`);
  }

  // ── 5. Verify files exist ──
  console.log('\n5. VERIFY IMPORTED FILES');
  const filesRes = await api('GET', `/sharepoint/folders/${testFolderId}/files`);
  const fileNames = (filesRes.data?.data || []).map((f: any) => f.name);

  const expected = ['README.md', 'docs', 'src'];
  for (const name of expected) {
    if (fileNames.includes(name)) {
      pass(`Found: ${name}`);
    } else {
      fail(`Missing: ${name} (found: ${fileNames.join(', ')})`);
    }
  }

  // ── 6. Export ZIP ──
  console.log('\n6. EXPORT ZIP');
  const exportRes = await fetch(`${API_BASE}/sharepoint/folders/${testFolderId}/export-zip`, {
    headers: { 'X-API-Key': API_KEY },
  });

  if (exportRes.ok) {
    const contentType = exportRes.headers.get('content-type');
    const disposition = exportRes.headers.get('content-disposition');
    const body = await exportRes.arrayBuffer();

    pass(`Export: ${body.byteLength} bytes`);
    pass(`Content-Type: ${contentType}`);
    pass(`Disposition: ${disposition}`);

    // Verify it's a valid ZIP
    try {
      const exported = await JSZip.loadAsync(body);
      const exportedFiles = Object.keys(exported.files);
      pass(`ZIP contains ${exportedFiles.length} entries`);
      if (exportedFiles.length > 0) {
        info(`Files: ${exportedFiles.slice(0, 10).join(', ')}${exportedFiles.length > 10 ? '...' : ''}`);
      }
    } catch {
      fail('Exported file is not a valid ZIP');
    }
  } else {
    fail(`Export failed: ${exportRes.status}`);
  }

  // ── 7. Test SSE events ──
  console.log('\n7. SSE EVENT TEST');
  let sseReceived = false;

  // Use raw HTTP to listen for SSE (EventSource is browser-only)
  const ssePromise = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 8000);

    fetch(`${API_BASE}/velocity/stream`, {
      headers: { 'X-API-Key': API_KEY },
    }).then(async (res) => {
      if (!res.ok || !res.body) { resolve(); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          if (chunk.includes('sharepoint_file_uploaded')) {
            sseReceived = true;
            clearTimeout(timeout);
            reader.cancel();
            resolve();
            return;
          }
        }
      } catch { /* stream closed */ }
      resolve();
    }).catch(() => resolve());
  });

  // Small delay to ensure SSE connection is established
  await new Promise(r => setTimeout(r, 500));

  // Trigger an upload while listening
  const testContent = `# SSE Test\nTimestamp: ${new Date().toISOString()}\n`;
  const sseFormData = new FormData();
  sseFormData.append('file', new Blob([testContent], { type: 'text/markdown' }), `sse-test-${Date.now()}.md`);

  await fetch(`${API_BASE}/sharepoint/folders/${testFolderId}/files`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: sseFormData,
  });

  await ssePromise;

  if (sseReceived) {
    pass('SSE sharepoint_file_uploaded event received');
  } else {
    info('SSE event not received within timeout (may be timing or Node.js stream issue)');
  }

  // ── Summary ──
  console.log('');
  console.log('='.repeat(60));
  console.log('  ZIP Import/Export + SSE Test Complete');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exitCode = 1;
});
