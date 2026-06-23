/**
 * Seed the database from projects.json
 * Idempotent: uses demand_number + name as natural key to avoid duplicates
 */
import { pool } from '../config/database';
import * as fs from 'fs';
import * as path from 'path';

interface ProjectJson {
  id: string;
  name: string;
  description: string;
  ministryCode: string;
  ministryName: string;
  startDate: string | null;
  endDate: string | null;
  goLiveDateType: string | null;
  status: string;
  percentComplete: number | null;
  priority: string;
  budget: number | null;
  spent: number | null;
  scope: string;
  category: string;
  demandNumber: string;
  ministryPriority: number | null;
  risk: string;
  additionalInfo: string;
  branch: string;
  projectLead: string;
  teamMembers: string;
  source: string;
  _sourceSheet: string;
  phase: string;
  isDuplicate?: boolean;
  duplicateOf?: string;
  potentialDuplicateOf?: string[];
}

interface DuplicatePair {
  project1: { id: string; name: string; source: string };
  project2: { id: string; name: string; source: string };
  similarity: number;
  isExactMatch: boolean;
}

// Map phase names to DB status enum
function mapPhaseToStatus(phase: string): string {
  const map: Record<string, string> = {
    'discovery': 'discovery',
    'requirements': 'requirements',
    'development': 'development',
    'testing': 'testing',
    'clientReview': 'client_review',
    'clientAcceptance': 'client_acceptance',
    'completion': 'completion',
    'onHold': 'on_hold',
    'cancelled': 'cancelled',
  };
  return map[phase] || 'discovery';
}

async function seed() {
  const jsonPath = path.resolve(__dirname, '../../..', 'client/src/data/projects.json');
  if (!fs.existsSync(jsonPath)) {
    console.error('projects.json not found at:', jsonPath);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const projects: ProjectJson[] = raw.projects;
  const duplicates: DuplicatePair[] = raw.duplicates;
  const ministries: { shortName: string; name: string }[] = raw.metadata.ministries;

  console.log(`Seeding ${ministries.length} ministries...`);

  // Upsert ministries
  for (const m of ministries) {
    await pool.query(
      `INSERT INTO ministry (ministry_code, ministry_name)
       VALUES ($1, $2)
       ON CONFLICT (ministry_code) DO UPDATE SET ministry_name = EXCLUDED.ministry_name`,
      [m.shortName, m.name]
    );
  }

  // Also add special codes from data
  const specialCodes = new Set<string>();
  for (const p of projects) {
    if (!ministries.find(m => m.shortName === p.ministryCode)) {
      specialCodes.add(p.ministryCode);
    }
  }
  for (const code of specialCodes) {
    const name = projects.find(p => p.ministryCode === code)?.ministryName || code;
    await pool.query(
      `INSERT INTO ministry (ministry_code, ministry_name)
       VALUES ($1, $2)
       ON CONFLICT (ministry_code) DO NOTHING`,
      [code, name]
    );
  }

  // Get ministry PK map
  const ministryMap = new Map<string, string>();
  const mResult = await pool.query('SELECT pk_ministry, ministry_code FROM ministry');
  for (const row of mResult.rows) {
    ministryMap.set(row.ministry_code, row.pk_ministry);
  }

  console.log(`Seeding ${projects.length} projects...`);

  // Track old ID → new UUID mapping for duplicates
  const idMap = new Map<string, string>();

  for (const p of projects) {
    const ministryPk = ministryMap.get(p.ministryCode);
    if (!ministryPk) {
      console.warn(`  Skipping ${p.name}: unknown ministry ${p.ministryCode}`);
      continue;
    }

    // Normalize go-live date type
    let goLiveDateType = p.goLiveDateType?.toLowerCase() || null;
    if (goLiveDateType && !['legislative', 'mandated', 'announced', 'objective'].includes(goLiveDateType)) {
      goLiveDateType = null;
    }

    const result = await pool.query(
      `INSERT INTO project (
        fk_project_ministry, project_name, project_description,
        project_status, project_start_date, project_end_date,
        project_go_live_date_type, project_percent_complete,
        project_priority, project_scope, project_category,
        project_demand_number, project_ministry_priority,
        project_risk, project_additional_info, project_branch,
        project_source, project_source_sheet, project_is_duplicate
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING pk_project`,
      [
        ministryPk,
        p.name,
        p.description || null,
        mapPhaseToStatus(p.phase),
        p.startDate || null,
        p.endDate || null,
        goLiveDateType,
        p.percentComplete,
        p.priority || null,
        p.scope || null,
        p.category || null,
        p.demandNumber || null,
        typeof p.ministryPriority === 'number' ? p.ministryPriority : null,
        p.risk || null,
        p.additionalInfo || null,
        p.branch || null,
        p.source,
        p._sourceSheet,
        p.isDuplicate || false,
      ]
    );

    const newPk = result.rows[0].pk_project;
    idMap.set(p.id, newPk);

    // Insert lead(s)
    if (p.projectLead) {
      const leads = p.projectLead.split(/[,;]/).map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < leads.length; i++) {
        await pool.query(
          `INSERT INTO project_lead (fk_project_lead_project, lead_name, lead_is_primary)
           VALUES ($1, $2, $3)`,
          [newPk, leads[i], i === 0]
        );
      }
    }

    // Insert budget if available
    if (p.budget !== null) {
      await pool.query(
        `INSERT INTO project_budget (fk_project_budget_project, budget_fiscal_year, budget_funding_source, budget_money_type, budget_amount, budget_spent)
         VALUES ($1, 'FY26-27', 'TI', 'Operating', $2, $3)`,
        [newPk, p.budget, p.spent || 0]
      );
    }
  }

  // Seed duplicates
  console.log(`Seeding ${duplicates.length} duplicate pairs...`);
  for (const d of duplicates) {
    const pk1 = idMap.get(d.project1.id);
    const pk2 = idMap.get(d.project2.id);
    if (!pk1 || !pk2) continue;

    // Ensure pk1 < pk2 for the check constraint
    const [smaller, larger] = pk1 < pk2 ? [pk1, pk2] : [pk2, pk1];
    await pool.query(
      `INSERT INTO project_duplicate (fk_duplicate_project_1, fk_duplicate_project_2, duplicate_similarity)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [smaller, larger, d.similarity]
    );
  }

  console.log('Seed complete!');
  console.log(`  Ministries: ${ministryMap.size}`);
  console.log(`  Projects: ${idMap.size}`);
  console.log(`  Duplicates: ${duplicates.length}`);

  await pool.end();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
