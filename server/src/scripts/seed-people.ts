/**
 * Extract people from Excel data, deduplicate on exact name (case-insensitive),
 * seed person table, then create project_lead assignments.
 */
import { pool } from '../config/database';
import * as fs from 'fs';
import * as path from 'path';

const COMPANY_NAMES = new Set(['cgi', 'vantix', 'fujitsu', 'deloitte', 'ey', 'pwc', 'kpmg', 'accenture', 'ibm', 'telus', 'ams staff', 'tcs', 'infosys', 'wipro', 'capgemini', 'cognizant', 'tech mahindra', 'ams', 'n/a', 'tbd', 'none', 'vacant', 'open']);

const ROLE_MAP: Record<string, string> = {
  'product and delivery director': 'delivery_director',
  'product and delivery manager': 'delivery_manager',
  'delivery director': 'delivery_director',
  'delivery manager': 'delivery_manager',
  'developer': 'developer', 'dev': 'developer',
  'qa': 'qa_tester', 'tester': 'qa_tester',
  'ba': 'business_analyst', 'business analyst': 'business_analyst', 'analyst': 'business_analyst',
  'designer': 'designer', 'ux': 'designer',
  'architect': 'architect',
  'scrum master': 'scrum_master', 'sm': 'scrum_master',
  'product owner': 'product_owner', 'po': 'product_owner',
  'pm': 'project_manager', 'project manager': 'project_manager',
  'data analyst': 'data_analyst', 'data': 'data_analyst',
  'devops': 'devops',
  'lead': 'lead',
};

interface PersonEntry {
  displayName: string;
  isFte: boolean;
  role: string;
  organization: string;
}

function isCompany(name: string): boolean {
  const lower = name.toLowerCase().trim();
  return COMPANY_NAMES.has(lower) || lower.length < 2 || lower.length > 60;
}

function parseTeamField(raw: string): PersonEntry[] {
  const results: PersonEntry[] = [];
  // Split on common delimiters
  const entries = raw.split(/[,;\/\n]/).map(s => s.trim()).filter(Boolean);

  for (const entry of entries) {
    if (isCompany(entry)) continue;

    const dashParts = entry.split(/\s*-\s*/);
    let displayName = entry;
    let isFte = true;
    let role = 'team_member';
    let organization = '';

    if (dashParts.length >= 3) {
      displayName = dashParts[0].trim();
      const second = dashParts[1].trim().toUpperCase();
      isFte = second === 'FTE';
      if (!isFte && second !== 'CONTRACTOR') organization = dashParts[1].trim();
      const roleStr = dashParts.slice(2).join(' ').trim().toLowerCase();
      role = ROLE_MAP[roleStr] || 'other';
    } else if (dashParts.length === 2) {
      displayName = dashParts[0].trim();
      const second = dashParts[1].trim().toLowerCase();
      if (second === 'fte') isFte = true;
      else if (ROLE_MAP[second]) role = ROLE_MAP[second];
      else { organization = dashParts[1].trim(); isFte = false; }
    }

    displayName = displayName.replace(/\s+/g, ' ').trim();
    if (displayName.length < 2 || isCompany(displayName)) continue;

    results.push({ displayName, isFte, role, organization });
  }
  return results;
}

async function seed() {
  const rawPath = path.resolve(__dirname, '../../../..', 'scripts/raw-extract.json');
  if (!fs.existsSync(rawPath)) {
    console.error('raw-extract.json not found. Run extract-projects.mjs first.');
    process.exit(1);
  }

  const rawData = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
  const allRecords = [...rawData.file1, ...rawData.file2];

  // ── Step 1: Collect all unique people (dedup on lowercase name) ──
  const personMap = new Map<string, { displayName: string; isFte: boolean; organization: string }>();

  function addPerson(name: string, isFte: boolean, org: string) {
    const key = name.toLowerCase().trim();
    if (key.length < 2 || isCompany(name)) return;
    if (!personMap.has(key)) {
      personMap.set(key, { displayName: name, isFte, organization: org });
    } else {
      // Merge: prefer FTE=true, prefer non-empty org, prefer longer name (more complete)
      const existing = personMap.get(key)!;
      if (name.length > existing.displayName.length) existing.displayName = name;
      if (isFte) existing.isFte = true;
      if (org && !existing.organization) existing.organization = org;
    }
  }

  // From DDD: deliveryDirector, deliveryManager
  for (const r of allRecords) {
    if (r.deliveryDirector) addPerson(String(r.deliveryDirector).trim(), true, '');
    if (r.deliveryManager) addPerson(String(r.deliveryManager).trim(), true, '');
  }

  // From DDD: team members field
  for (const r of rawData.file2) {
    if (r.nameOfIndividualsWorkingOnTheProject) {
      for (const p of parseTeamField(String(r.nameOfIndividualsWorkingOnTheProject))) {
        addPerson(p.displayName, p.isFte, p.organization);
      }
    }
  }

  console.log(`Unique people after dedup: ${personMap.size}`);

  // ── Step 2: Insert into person table ──
  const personIdByKey = new Map<string, string>(); // lowercase name → pk_person

  for (const [key, p] of personMap) {
    const result = await pool.query(
      `INSERT INTO person (person_display_name, person_organization, person_is_fte)
       VALUES ($1, $2, $3) RETURNING pk_person`,
      [p.displayName, p.organization || null, p.isFte]
    );
    personIdByKey.set(key, result.rows[0].pk_person);
  }

  console.log(`Inserted ${personIdByKey.size} people`);

  // ── Step 3: Build project name → pk_project lookup ──
  const projects = await pool.query(`SELECT pk_project, project_name FROM project WHERE is_deleted = false`);
  const projectByName = new Map<string, string>();
  for (const p of projects.rows) {
    projectByName.set(p.project_name.toLowerCase().trim(), p.pk_project);
  }

  // ── Step 4: Create project_lead assignments ──
  // Track (projectId, personKey) to avoid duplicates
  const assigned = new Set<string>();
  let assignmentCount = 0;

  async function assignPerson(projectId: string, personKey: string, role: string, isPrimary: boolean) {
    const dedupKey = `${projectId}::${personKey}`;
    if (assigned.has(dedupKey)) return;
    assigned.add(dedupKey);

    const personId = personIdByKey.get(personKey);
    const person = personMap.get(personKey);
    if (!personId || !person) return;

    await pool.query(
      `INSERT INTO project_lead (fk_project_lead_project, fk_project_lead_person, lead_name, lead_role, lead_is_primary, lead_is_fte, lead_organization)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, personId, person.displayName, role, isPrimary, person.isFte, person.organization || null]
    );
    assignmentCount++;
  }

  // File 1 (Priority Projects): no team data, but has project names
  // File 2 (DDD Projects): has deliveryDirector, deliveryManager, team members
  for (const r of rawData.file2) {
    const projectName = (r.projectName || '').toLowerCase().trim();
    const projectId = projectByName.get(projectName);
    if (!projectId) continue;

    // Delivery director = primary lead
    if (r.deliveryDirector) {
      const key = String(r.deliveryDirector).trim().toLowerCase();
      await assignPerson(projectId, key, 'delivery_director', true);
    }

    // Delivery manager
    if (r.deliveryManager) {
      const key = String(r.deliveryManager).trim().toLowerCase();
      await assignPerson(projectId, key, 'delivery_manager', false);
    }

    // Team members
    if (r.nameOfIndividualsWorkingOnTheProject) {
      for (const p of parseTeamField(String(r.nameOfIndividualsWorkingOnTheProject))) {
        const key = p.displayName.toLowerCase().trim();
        await assignPerson(projectId, key, p.role, false);
      }
    }
  }

  // File 1: map projectLead from the original seed (opportunityName field)
  for (const r of rawData.file1) {
    const projectName = (r.opportunityName || '').toLowerCase().trim();
    const projectId = projectByName.get(projectName);
    if (!projectId) continue;

    // The original seed script used deliveryDirector || deliveryManager as lead
    // For file 1 there's no explicit lead, but we can check if we matched any names
  }

  console.log(`Created ${assignmentCount} project assignments`);
  console.log(`\nFinal counts:`);
  const pc = await pool.query('SELECT COUNT(*)::int AS c FROM person');
  const lc = await pool.query('SELECT COUNT(*)::int AS c FROM project_lead');
  const uniq = await pool.query('SELECT COUNT(DISTINCT fk_project_lead_person)::int AS c FROM project_lead WHERE fk_project_lead_person IS NOT NULL');
  console.log(`  People: ${pc.rows[0].c}`);
  console.log(`  Assignments: ${lc.rows[0].c}`);
  console.log(`  People with assignments: ${uniq.rows[0].c}`);

  await pool.end();
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1); });
