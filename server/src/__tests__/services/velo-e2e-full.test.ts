/**
 * Velo Full E2E Build Test
 *
 * Creates a real project with 5 modules, provisions SharePoint folders,
 * creates a GitHub monorepo, builds Vue.js hello-world apps for each module,
 * commits code, uploads artifacts, and plays the full velocity game.
 *
 * Usage:
 *   cd app/server
 *   API_BASE=http://localhost:3001/api/v1 npx tsx src/__tests__/services/velo-e2e-full.test.ts
 *
 * Requirements:
 *   - Server running on port 3001
 *   - Valid API key with runner + project_lead roles
 *   - GITHUB_PAT configured (or user PAT saved)
 *   - SharePoint configured (optional — skips if not available)
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3001/api/v1';
const API_KEY = process.env.API_KEY || 'velo_248c2d0d2d5cf1a5328d5d53bb1b1f1ebfd0ff34';
const GITHUB_ORG = process.env.GITHUB_ORG || 'developmentation';

let projectId = '';
let projectName = '';
let repoFullName = '';
let repoOwner = '';
let repoName = '';
let moduleIds: string[] = [];
let spFoldersByModule: Record<string, Record<string, string>> = {}; // moduleId -> { stepName -> folderId }
const STEP_NAMES = ['requirements', 'planning', 'architecture', 'prototyping', 'development', 'user_testing', 'user_acceptance', 'deployment'];
const MODULE_NAMES = [
  'Phase 1 — User Auth',
  'Phase 2 — Dashboard',
  'Phase 3 — API Layer',
  'Phase 4 — Data Viz',
  'Phase 5 — Deployment',
];

// ── Helpers ──

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { 'X-API-Key': API_KEY };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function uploadFile(path: string, filename: string, content: string, contentType = 'text/markdown'): Promise<any> {
  const formData = new FormData();
  formData.append('file', new Blob([content], { type: contentType }), filename);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: formData,
  });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => null) };
}

function pass(msg: string) { console.log(`  \x1b[32m[PASS]\x1b[0m ${msg}`); }
function fail(msg: string) { console.log(`  \x1b[31m[FAIL]\x1b[0m ${msg}`); process.exitCode = 1; }
function info(msg: string) { console.log(`  \x1b[34m[INFO]\x1b[0m ${msg}`); }
function section(n: number, title: string) { console.log(`\n${n}. ${title}`); }

// ── Vue.js App Generators ──

function vueApp(moduleName: string, moduleNum: number): Record<string, string> {
  const safeName = moduleName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  return {
    [`modules/${safeName}/index.html`]: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${moduleName}</title>
<script src="https://unpkg.com/vue@3/dist/vue.global.prod.js"><\/script>
</head>
<body>
<div id="app"></div>
<script>
const { createApp, ref } = Vue
createApp({
  setup() {
    const count = ref(0)
    return { count, moduleName: '${moduleName}', moduleNum: ${moduleNum} }
  },
  template: \`
    <div style="font-family:system-ui;max-width:600px;margin:2rem auto;padding:2rem">
      <h1>{{ moduleName }}</h1>
      <p>Module {{ moduleNum }} of 5 — Vue.js CDN Hello World</p>
      <button @click="count++">Count: {{ count }}</button>
      <p style="color:#888;margin-top:2rem">Built by Velo E2E Test</p>
    </div>
  \`
}).mount('#app')
<\/script>
</body>
</html>`,
    [`modules/${safeName}/README.md`]: `# ${moduleName}\n\nVue.js CDN hello world app — Module ${moduleNum} of 5.\n\nBuilt by Velo E2E automated build test.\n`,
  };
}

// ── Step Artifact Documents ──

function requirementsDoc(moduleName: string): string {
  return `# Requirements — ${moduleName}\n\n## Functional Requirements\n1. Display module name and number\n2. Interactive counter button\n3. Responsive layout\n\n## Non-Functional Requirements\n1. Load time < 2s on CDN\n2. Works without build tools\n3. Vue.js 3 via CDN\n\n## Acceptance Criteria\n- Page loads with module title\n- Counter increments on click\n- Mobile responsive\n`;
}

function planningDoc(moduleName: string): string {
  return `# Planning — ${moduleName}\n\n## Tasks\n1. Create HTML scaffold (0.5h)\n2. Add Vue.js CDN script (0.25h)\n3. Implement counter component (0.5h)\n4. Add responsive styles (0.5h)\n5. Test across browsers (0.25h)\n\n## Timeline\n- Total: 2 hours\n- Risk: CDN availability\n`;
}

function architectureDoc(moduleName: string): string {
  return `# Architecture — ${moduleName}\n\n## Stack\n- Vue.js 3 (CDN — no build step)\n- Vanilla HTML/CSS\n- No bundler required\n\n## Structure\n\`\`\`\nmodules/${moduleName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}/\n  index.html    # Entry point with inline Vue app\n  README.md     # Module documentation\n\`\`\`\n\n## Deployment\nServe via any static file host or CDN.\n`;
}

function testDoc(moduleName: string): string {
  return `# Test Results — ${moduleName}\n\n## Manual Test\n- [x] Page loads correctly\n- [x] Counter increments\n- [x] Responsive on mobile\n- [x] No console errors\n\n## Browser Compatibility\n- Chrome 120+ : PASS\n- Firefox 120+ : PASS\n- Safari 17+ : PASS\n- Edge 120+ : PASS\n`;
}

// ── Main ──

async function main() {
  console.log('');
  console.log('='.repeat(70));
  console.log('  VELO FULL E2E BUILD TEST');
  console.log('  Real project • 5 modules • GitHub monorepo • SharePoint artifacts');
  console.log('='.repeat(70));

  // ═══════════════════════════════════════════════════════════════════
  section(1, 'CREATE PROJECT');
  const suffix = Date.now().toString(36).slice(-4);
  projectName = `VELO E2E Build ${suffix}`;
  const createRes = await api('POST', '/projects', {
    name: projectName,
    description: 'Automated E2E build test — 5 Vue.js CDN hello world apps in a monorepo, with full velocity game lifecycle.',
    ministryCode: 'TI',
    status: 'development',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    isMissionCritical: true,
  });
  if (!createRes.ok) { fail(`Create project: ${createRes.status}`); return; }
  projectId = createRes.data.data.pk_project;
  pass(`Project: ${projectName} (${projectId.substring(0, 8)})`);

  // ═══════════════════════════════════════════════════════════════════
  section(2, 'CREATE 5 MODULES');
  for (const name of MODULE_NAMES) {
    const res = await api('POST', `/projects/${projectId}/modules`, {
      name, description: `Vue.js CDN hello world — ${name}`,
      status: 'requirements_gathering', complexity: 2.0, isMissionCritical: true,
    });
    if (res.ok) {
      moduleIds.push(res.data.data.pk_module);
      pass(`Module: ${name}`);
    } else { fail(`Module ${name}: ${res.status}`); }
  }

  // ═══════════════════════════════════════════════════════════════════
  section(3, 'CREATE GITHUB REPO');
  repoName = `VELO-${projectName.replace(/[^a-zA-Z0-9]/g, '-')}-${projectId.slice(-4)}`;
  const repoRes = await api('POST', '/git/repos', {
    name: repoName,
    description: `Velo E2E monorepo — ${projectName}`,
    isPrivate: false,
    ...(GITHUB_ORG ? { org: GITHUB_ORG } : {}),
  });
  if (repoRes.ok) {
    repoFullName = repoRes.data.data.full_name;
    const parts = repoFullName.split('/');
    repoOwner = parts[0];
    repoName = parts[1];
    pass(`Repo: ${repoFullName} (${repoRes.data.data.html_url})`);

    // Link repo to project
    await api('POST', `/projects/${projectId}/links`, {
      type: 'github', url: repoRes.data.data.html_url, label: 'Monorepo',
    });
    pass('Linked repo to project');
  } else {
    fail(`Create repo: ${repoRes.status} ${JSON.stringify(repoRes.data?.error || repoRes.data?.data).substring(0, 200)}`);
    info('Continuing without GitHub — will skip code commits');
  }

  // ═══════════════════════════════════════════════════════════════════
  section(4, 'CREATE SHAREPOINT FOLDERS');
  const spRes = await api('POST', `/sharepoint/projects/${projectId}/folders`);
  if (spRes.ok) {
    const folders = spRes.data.data?.folders || [];
    pass(`SharePoint: ${folders.length} folders created`);

    // Build folder lookup: moduleId -> { stepName -> pk_sharepoint_folder }
    const allFolders = await api('GET', `/sharepoint/projects/${projectId}/folders`);
    const flist = allFolders.data?.data || [];
    for (const mod of moduleIds) {
      spFoldersByModule[mod] = {};
      for (const f of flist) {
        if (f.fk_sf_module === mod && f.fk_sf_velocity_step) {
          const stepName = f.sp_folder_path.split('/').pop();
          spFoldersByModule[mod][stepName] = f.pk_sharepoint_folder;
        }
      }
    }
  } else {
    info(`SharePoint: ${spRes.status} — continuing without`);
  }

  // ═══════════════════════════════════════════════════════════════════
  section(5, 'BUILD & DEPLOY — VELOCITY GAME');

  for (let m = 0; m < moduleIds.length; m++) {
    const modId = moduleIds[m];
    const modName = MODULE_NAMES[m];
    const modFolders = spFoldersByModule[modId] || {};
    const files = vueApp(modName, m + 1);

    console.log(`\n  ── Module ${m + 1}: ${modName} ──`);

    for (let s = 0; s < STEP_NAMES.length; s++) {
      const step = STEP_NAMES[s];

      // Re-fetch current step status
      const stepsRes = await api('GET', `/velocity/modules/${modId}`);
      const steps = stepsRes.data?.data || [];
      const current = steps.find((st: any) => st.step_name === step);
      if (!current) { fail(`Step ${step} not found`); continue; }
      let status = current.status;

      // Advance to ready_to_start if needed
      if (status === 'not_started') {
        await api('PUT', `/velocity/modules/${modId}/steps/${step}`, {
          status: 'ready_to_start', actor: 'human', content: `Starting ${step}`,
        });
        status = 'ready_to_start';
      }

      // AI picks up
      if (status === 'ready_to_start') {
        await api('PUT', `/velocity/modules/${modId}/steps/${step}`, {
          status: 'ai_working', actor: 'ai', content: `AI working on ${step}`,
        });
        status = 'ai_working';
      }

      // Do the actual work per step
      let artifactContent = '';
      let artifactName = '';
      const attachments: { filename: string; url: string }[] = [];

      // Helper: commit a file to GitHub via Velo API
      async function commitToRepo(filePath: string, fileContent: string, msg: string): Promise<boolean> {
        if (!repoFullName) return false;
        try {
          await api('POST', `/git/repos/${repoOwner}/${repoName}/commits`, {
            path: filePath, content: fileContent, message: msg, branch: 'main',
          });
          attachments.push({ filename: filePath, url: `https://github.com/${repoFullName}/blob/main/${filePath}` });
          return true;
        } catch (e: any) {
          info(`  commit ${filePath}: ${e?.message?.substring(0, 80) || 'failed'}`);
          return false;
        }
      }

      const safeName = modName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

      switch (step) {
        case 'requirements':
          artifactContent = requirementsDoc(modName);
          artifactName = 'requirements.md';
          // Commit requirements doc + root README (first module only)
          await commitToRepo(`docs/${safeName}/requirements.md`, artifactContent, `[${modName}] Add requirements`);
          if (m === 0) {
            await commitToRepo('README.md', `# ${projectName}\n\nMonorepo with 5 Vue.js CDN modules.\n\nBuilt and tracked by [Velo](https://velo.example.com).\n`, `Initial README`);
            await commitToRepo('package.json', JSON.stringify({ name: repoName.toLowerCase(), version: '1.0.0', private: true, description: projectName, scripts: { dev: 'npx serve .' } }, null, 2), `Add root package.json`);
          }
          break;
        case 'planning':
          artifactContent = planningDoc(modName);
          artifactName = 'planning.md';
          await commitToRepo(`docs/${safeName}/planning.md`, artifactContent, `[${modName}] Add planning doc`);
          break;
        case 'architecture':
          artifactContent = architectureDoc(modName);
          artifactName = 'architecture.md';
          await commitToRepo(`docs/${safeName}/architecture.md`, artifactContent, `[${modName}] Add architecture doc`);
          break;
        case 'prototyping':
          // Commit the Vue.js app files
          for (const [filePath, content] of Object.entries(files)) {
            await commitToRepo(filePath, content, `[${modName}] Prototype: ${filePath}`);
          }
          artifactContent = `# Prototyping — ${modName}\n\nPrototype committed to ${repoFullName}.\n\nFiles:\n${Object.keys(files).map(f => `- ${f}`).join('\n')}\n`;
          artifactName = 'prototyping-summary.md';
          break;
        case 'development':
          // Add a CSS file and update the app
          const cssContent = `/* ${modName} styles */\nbody { font-family: system-ui; margin: 0; padding: 2rem; }\nbutton { padding: 0.5rem 1rem; border-radius: 0.5rem; border: 1px solid #ddd; cursor: pointer; }\nbutton:hover { background: #f0f0f0; }\n`;
          await commitToRepo(`modules/${safeName}/styles.css`, cssContent, `[${modName}] Add styles`);
          artifactContent = `# Development — ${modName}\n\nProduction code finalized. Added styles.css.\n`;
          artifactName = 'development-summary.md';
          break;
        case 'user_testing':
          artifactContent = testDoc(modName);
          artifactName = 'test-results.md';
          break;
        case 'user_acceptance':
          artifactContent = `# User Acceptance — ${modName}\n\nAll acceptance criteria met.\n\nSigned off by: Automated E2E Test\nDate: ${new Date().toISOString().split('T')[0]}\n`;
          artifactName = 'sign-off.md';
          await commitToRepo(`docs/${safeName}/sign-off.md`, artifactContent, `[${modName}] UAT sign-off`);
          break;
        case 'deployment':
          artifactContent = `# Deployment — ${modName}\n\nDeployed to: CDN (static files)\nURL: https://cdn.example.com/${safeName}/\nStatus: Live\nDate: ${new Date().toISOString()}\n`;
          artifactName = 'deployment-log.md';
          await commitToRepo(`docs/${safeName}/deployment.md`, artifactContent, `[${modName}] Deployment log`);
          break;
      }

      // Upload artifact to SharePoint step folder
      const folderId = modFolders[step];
      if (folderId && artifactContent) {
        const up = await uploadFile(`/sharepoint/folders/${folderId}/files`, artifactName, artifactContent);
        if (up.ok) attachments.push({ filename: artifactName, url: up.data?.data?.webUrl || '' });
      }

      // Submit for review
      if (status === 'ai_working' || status === 'human_working') {
        await api('PUT', `/velocity/modules/${modId}/steps/${step}`, {
          status: 'human_review', actor: 'ai',
          content: `${step} complete for ${modName}. ${attachments.length} artifacts attached.`,
          attachments,
        });
      }

      // Approve
      const approveRes = await api('PUT', `/velocity/modules/${modId}/steps/${step}`, {
        status: 'completed', actor: 'human',
        content: `${step} approved for ${modName}.`,
      });

      if (approveRes.ok) {
        pass(`${step}`);
      } else {
        fail(`${step}: ${approveRes.status} ${JSON.stringify(approveRes.data?.error).substring(0, 100)}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  section(6, 'FINAL METRICS');
  const velRes = await api('GET', `/velocity/projects/${projectId}`);
  if (velRes.ok) {
    const metrics = velRes.data.data?.metrics || [];
    let totalScore = 0, totalBonus = 0, totalPenalty = 0;
    for (const m of metrics) {
      totalScore += m.velocity_score || 0;
      totalBonus += m.velocity_bonus || 0;
      totalPenalty += m.velocity_penalty || 0;
    }
    pass(`Total Score: ${totalScore} | Bonus: +${totalBonus} | Penalty: -${totalPenalty}`);
    pass(`Modules scored: ${metrics.length}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  section(7, 'VERIFY');
  const finalRes = await api('GET', `/projects/${projectId}`);
  if (finalRes.ok) {
    const p = finalRes.data.data;
    pass(`Project: ${p.project_name}`);
    pass(`Modules: ${p.modules?.length || 0}`);
    pass(`Links: ${p.links?.length || 0}`);
    pass(`Mission Critical: ${p.project_is_mission_critical}`);
  }

  // Count completed velocity steps across all modules
  let totalCompleted = 0;
  for (const modId of moduleIds) {
    const mRes = await api('GET', `/velocity/modules/${modId}`);
    if (mRes.ok) {
      totalCompleted += (mRes.data.data || []).filter((s: any) => s.status === 'completed').length;
    }
  }
  pass(`Velocity steps completed: ${totalCompleted}/40 (${moduleIds.length} modules x 8 steps)`);

  if (repoFullName) {
    pass(`GitHub repo: https://github.com/${repoFullName}`);
  }

  // CLAUDE.md download
  const claudeRes = await fetch(`${API_BASE}/velocity/claude-md`);
  if (claudeRes.ok) {
    pass(`CLAUDE.md: ${(await claudeRes.text()).length} bytes`);
  }

  console.log('');
  console.log('='.repeat(70));
  console.log(`  BUILD COMPLETE — ${totalCompleted}/40 steps • ${moduleIds.length} modules`);
  console.log(`  Project: ${projectName} (${projectId})`);
  if (repoFullName) console.log(`  Repo: https://github.com/${repoFullName}`);
  console.log('  NOTE: Project NOT deleted — inspect it in the UI');
  console.log('='.repeat(70));
}

main().catch((err) => {
  console.error('E2E test crashed:', err);
  process.exitCode = 1;
});
