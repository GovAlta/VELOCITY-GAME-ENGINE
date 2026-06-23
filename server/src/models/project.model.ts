import { pool } from '../config/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  pk_project: string;
  project_code: string | null;
  fk_project_ministry: string | null;
  project_name: string;
  project_description: string | null;
  project_status: string | null;
  project_start_date: string | null;
  project_end_date: string | null;
  project_go_live_date_type: string | null;
  project_percent_complete: number | null;
  project_priority: string | null;
  project_scope: string | null;
  project_category: string | null;
  project_demand_number: string | null;
  project_ministry_priority: number | null;
  project_risk: string | null;
  project_additional_info: string | null;
  project_branch: string | null;
  project_source: string | null;
  project_source_sheet: string | null;
  project_is_duplicate: boolean;
  project_is_mission_critical: boolean;
  project_is_challenge: boolean;
  challenge_points: number;
  challenge_max_days: number;
  challenge_difficulty: string | null;
  challenge_claimed_by: string | null;
  challenge_claimed_at: string | null;
  challenge_completed_at: string | null;
  fk_project_duplicate_of: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
  is_deleted: boolean;
}

export interface ProjectListItem extends ProjectRecord {
  ministry_code: string | null;
  ministry_name: string | null;
  lead_names: string | null;
}

export interface ProjectLeadRecord {
  pk_project_lead: string;
  fk_project_lead_project: string;
  lead_name: string;
  lead_is_primary: boolean;
  lead_role: string | null;
  created_at: string;
}

export interface ProjectBudgetRecord {
  pk_project_budget: string;
  fk_project_budget_project: string;
  budget_fiscal_year: string;
  budget_funding_source: string;
  budget_money_type: string;
  budget_amount: number;
  budget_spent: number;
  budget_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectLinkRecord {
  pk_project_link: string;
  fk_project_link_project: string;
  link_type: string;
  link_url: string;
  link_label: string | null;
  link_description: string | null;
  created_at: string;
}

export interface ModuleRecord {
  pk_module: string;
  fk_module_project: string;
  module_name: string;
  module_description: string | null;
  module_status: string;
  module_start_date: string | null;
  module_end_date: string | null;
  module_percent_complete: number;
  module_sort_order: number;
  module_plan: string | null;
  module_progress: string | null;
  module_blockers: string | null;
  module_complexity: number;
  module_is_mission_critical: boolean;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface ProjectApplicationRecord {
  pk_project_application: string;
  fk_pa_project: string;
  fk_pa_application: string;
  fk_pa_module: string | null;
  pa_relationship_type: string;
  pa_description: string | null;
  created_at: string;
  application_name: string;
  application_type: string | null;
  application_install_type: string | null;
  module_name: string | null;
}

export interface ProjectContractRecord {
  pk_project_contract: string;
  fk_pc_project: string;
  fk_pc_contract: string;
  fk_pc_module: string | null;
  pc_relationship_type: string;
  pc_description: string | null;
  created_at: string;
  contract_name: string;
  contract_commodity_type: string | null;
  contract_vendor: string | null;
  contract_external_id: string | null;
  module_name: string | null;
}

export interface ProjectDetail extends ProjectRecord {
  ministry_code: string | null;
  ministry_name: string | null;
  leads: ProjectLeadRecord[];
  budgets: ProjectBudgetRecord[];
  links: ProjectLinkRecord[];
  modules: ModuleRecord[];
  applications: ProjectApplicationRecord[];
  contracts: ProjectContractRecord[];
}

export interface ProjectFilters {
  search?: string;
  ministry?: string;
  status?: string;
  missionCritical?: string;
  sort?: string;
  order?: string;
}

// ---------------------------------------------------------------------------
// Allowed sort columns — prevents SQL injection via sort parameter
// ---------------------------------------------------------------------------

const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  project_name: 'p.project_name',
  project_status: 'p.project_status',
  project_priority: 'p.project_priority',
  project_start_date: 'p.project_start_date',
  project_end_date: 'p.project_end_date',
  project_percent_complete: 'p.project_percent_complete',
  ministry_name: 'm.ministry_name',
  updated_at: 'p.updated_at',
  created_at: 'p.created_at',
};

// ---------------------------------------------------------------------------
// Build WHERE clause
// ---------------------------------------------------------------------------

function buildWhereClause(filters: ProjectFilters): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = ['p.is_deleted = false'];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Search filter — project name or description
  if (filters.search) {
    clauses.push(
      `(p.project_name ILIKE $${paramIndex} OR p.project_description ILIKE $${paramIndex})`
    );
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  // Ministry filter — supports UUID or ministry code
  if (filters.ministry) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filters.ministry);
    if (isUuid) {
      clauses.push(`p.fk_project_ministry = $${paramIndex++}`);
      params.push(filters.ministry);
    } else {
      clauses.push(`m.ministry_code ILIKE $${paramIndex++}`);
      params.push(filters.ministry);
    }
  }

  // Status filter
  if (filters.status) {
    clauses.push(`p.project_status = $${paramIndex++}`);
    params.push(filters.status);
  }

  // Mission critical filter
  if (filters.missionCritical === 'true') {
    clauses.push(`p.project_is_mission_critical = true`);
  } else if (filters.missionCritical === 'false') {
    clauses.push(`p.project_is_mission_critical = false`);
  }

  return { clauses, params };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Find all projects with filtering, sorting, and pagination.
 * Joins ministry for ministry name/code and aggregates primary lead names.
 */
export async function findAll(
  filters: ProjectFilters,
  page: number,
  limit: number
): Promise<ProjectListItem[]> {
  const { clauses, params } = buildWhereClause(filters);
  const whereStr = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // Safe sort column lookup
  const sortColumn = ALLOWED_SORT_COLUMNS[filters.sort || ''] || 'p.updated_at';
  const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';

  const offset = (page - 1) * limit;
  const paramIndex = params.length + 1;

  const query = `
    SELECT
      p.*,
      m.ministry_code,
      m.ministry_name,
      (SELECT STRING_AGG(pl.lead_name, ', ' ORDER BY pl.lead_name)
       FROM project_lead pl
       WHERE pl.fk_project_lead_project = p.pk_project AND pl.lead_is_primary = true
      ) AS lead_names
    FROM project p
    LEFT JOIN ministry m ON p.fk_project_ministry = m.pk_ministry
    ${whereStr}
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const result = await pool.query<ProjectListItem>(query, params);
  return result.rows;
}

/**
 * Count all projects matching filters (for pagination metadata).
 */
export async function countAll(filters: ProjectFilters): Promise<number> {
  const { clauses, params } = buildWhereClause(filters);
  const whereStr = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const query = `
    SELECT COUNT(*) AS count
    FROM project p
    LEFT JOIN ministry m ON p.fk_project_ministry = m.pk_ministry
    ${whereStr}
  `;

  const result = await pool.query<{ count: string }>(query, params);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Find a single project by ID with all related data.
 * Returns null if not found or soft-deleted.
 */
export async function findById(id: string): Promise<ProjectDetail | null> {
  // Main project + ministry
  const projectResult = await pool.query<ProjectRecord & { ministry_code: string | null; ministry_name: string | null }>(
    `SELECT
       p.*,
       m.ministry_code,
       m.ministry_name
     FROM project p
     LEFT JOIN ministry m ON p.fk_project_ministry = m.pk_ministry
     WHERE p.pk_project = $1
       AND p.is_deleted = false`,
    [id]
  );

  if (projectResult.rows.length === 0) {
    return null;
  }

  const project = projectResult.rows[0];

  // Fetch related data in parallel
  const [leadsResult, budgetsResult, linksResult, modulesResult, applicationsResult, contractsResult] = await Promise.all([
    pool.query(
      `SELECT pl.pk_project_lead, pl.fk_project_lead_project, pl.fk_project_lead_person,
              pl.lead_name, pl.lead_is_primary, pl.lead_role, pl.lead_is_fte, pl.lead_organization, pl.created_at,
              p.person_display_name, p.person_email, p.person_organization, p.person_is_fte
       FROM project_lead pl
       LEFT JOIN person p ON p.pk_person = pl.fk_project_lead_person
       WHERE pl.fk_project_lead_project = $1
       ORDER BY pl.lead_is_primary DESC, pl.lead_role ASC, pl.lead_name ASC`,
      [id]
    ),
    pool.query<ProjectBudgetRecord>(
      `SELECT pk_project_budget, fk_project_budget_project, budget_fiscal_year, budget_funding_source,
              budget_money_type, budget_amount, budget_spent, budget_notes, created_at, updated_at
       FROM project_budget
       WHERE fk_project_budget_project = $1
       ORDER BY budget_fiscal_year ASC`,
      [id]
    ),
    pool.query<ProjectLinkRecord>(
      `SELECT pk_project_link, fk_project_link_project, link_type, link_url, link_label, link_description, created_at
       FROM project_link
       WHERE fk_project_link_project = $1
       ORDER BY link_type ASC, created_at ASC`,
      [id]
    ),
    pool.query<ModuleRecord>(
      `SELECT pk_module, fk_module_project, module_name, module_description, module_status,
              module_start_date, module_end_date, module_percent_complete, module_sort_order,
              module_plan, module_progress, module_blockers, created_at, updated_at, is_deleted
       FROM module
       WHERE fk_module_project = $1 AND is_deleted = false
       ORDER BY module_sort_order ASC, created_at ASC`,
      [id]
    ),
    pool.query<ProjectApplicationRecord>(
      `SELECT pa.*, a.application_name, a.application_type, a.application_install_type, m2.module_name
       FROM project_application pa
       JOIN application a ON pa.fk_pa_application = a.pk_application
       LEFT JOIN module m2 ON pa.fk_pa_module = m2.pk_module
       WHERE pa.fk_pa_project = $1
       ORDER BY a.application_name`,
      [id]
    ),
    pool.query<ProjectContractRecord>(
      `SELECT pc.*, c.contract_name, c.contract_commodity_type, c.contract_vendor, c.contract_external_id, m2.module_name
       FROM project_contract pc
       JOIN contract c ON pc.fk_pc_contract = c.pk_contract
       LEFT JOIN module m2 ON pc.fk_pc_module = m2.pk_module
       WHERE pc.fk_pc_project = $1
       ORDER BY c.contract_name`,
      [id]
    ),
  ]);

  return {
    ...project,
    leads: leadsResult.rows,
    budgets: budgetsResult.rows,
    links: linksResult.rows,
    modules: modulesResult.rows,
    applications: applicationsResult.rows,
    contracts: contractsResult.rows,
  };
}

/**
 * Create a new project. Returns the newly created record.
 */
export async function create(
  data: Partial<ProjectRecord>,
  userId: string
): Promise<ProjectRecord> {
  const result = await pool.query<ProjectRecord>(
    `INSERT INTO project (
       project_code,
       fk_project_ministry,
       project_name,
       project_description,
       project_status,
       project_start_date,
       project_end_date,
       project_go_live_date_type,
       project_percent_complete,
       project_priority,
       project_scope,
       project_category,
       project_demand_number,
       project_ministry_priority,
       project_risk,
       project_additional_info,
       project_branch,
       project_source,
       project_source_sheet,
       project_is_duplicate,
       fk_project_duplicate_of,
       created_by,
       updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $22
     )
     RETURNING *`,
    [
      data.project_code || null,
      data.fk_project_ministry || null,
      data.project_name,
      data.project_description || null,
      data.project_status || null,
      data.project_start_date || null,
      data.project_end_date || null,
      data.project_go_live_date_type || null,
      data.project_percent_complete ?? null,
      data.project_priority || null,
      data.project_scope || null,
      data.project_category || null,
      data.project_demand_number || null,
      data.project_ministry_priority || null,
      data.project_risk || null,
      data.project_additional_info || null,
      data.project_branch || null,
      data.project_source || null,
      data.project_source_sheet || null,
      data.project_is_duplicate ?? false,
      data.fk_project_duplicate_of || null,
      userId,
    ]
  );

  return result.rows[0];
}

/**
 * Update a project by ID. Returns the updated record.
 * Returns null if not found or soft-deleted.
 */
export async function update(
  id: string,
  data: Partial<ProjectRecord>,
  userId: string
): Promise<ProjectRecord | null> {
  const result = await pool.query<ProjectRecord>(
    `UPDATE project SET
       project_code = COALESCE($1, project_code),
       fk_project_ministry = COALESCE($2, fk_project_ministry),
       project_name = COALESCE($3, project_name),
       project_description = COALESCE($4, project_description),
       project_status = COALESCE($5, project_status),
       project_start_date = COALESCE($6, project_start_date),
       project_end_date = COALESCE($7, project_end_date),
       project_go_live_date_type = COALESCE($8, project_go_live_date_type),
       project_percent_complete = COALESCE($9, project_percent_complete),
       project_priority = COALESCE($10, project_priority),
       project_scope = COALESCE($11, project_scope),
       project_category = COALESCE($12, project_category),
       project_demand_number = COALESCE($13, project_demand_number),
       project_ministry_priority = COALESCE($14, project_ministry_priority),
       project_risk = COALESCE($15, project_risk),
       project_additional_info = COALESCE($16, project_additional_info),
       project_branch = COALESCE($17, project_branch),
       project_source = COALESCE($18, project_source),
       project_source_sheet = COALESCE($19, project_source_sheet),
       project_is_duplicate = COALESCE($20, project_is_duplicate),
       fk_project_duplicate_of = COALESCE($21, fk_project_duplicate_of),
       project_is_mission_critical = COALESCE($22, project_is_mission_critical),
       project_is_challenge = COALESCE($23, project_is_challenge),
       challenge_points = COALESCE($24, challenge_points),
       challenge_max_days = COALESCE($25, challenge_max_days),
       challenge_difficulty = COALESCE($26, challenge_difficulty),
       updated_by = $27,
       updated_at = NOW()
     WHERE pk_project = $28
       AND is_deleted = false
     RETURNING *`,
    [
      data.project_code,
      data.fk_project_ministry,
      data.project_name,
      data.project_description,
      data.project_status,
      data.project_start_date,
      data.project_end_date,
      data.project_go_live_date_type,
      data.project_percent_complete,
      data.project_priority,
      data.project_scope,
      data.project_category,
      data.project_demand_number,
      data.project_ministry_priority,
      data.project_risk,
      data.project_additional_info,
      data.project_branch,
      data.project_source,
      data.project_source_sheet,
      data.project_is_duplicate,
      data.fk_project_duplicate_of,
      data.project_is_mission_critical,
      data.project_is_challenge,
      data.challenge_points,
      data.challenge_max_days,
      data.challenge_difficulty,
      userId,
      id,
    ]
  );

  // challenge_max_acceptances is tri-state: undefined = keep existing,
  // null = clear to unlimited, integer = cap. The COALESCE pattern above
  // can't express "set to NULL", so we handle this column separately when
  // the caller explicitly included it in the payload.
  if (Object.prototype.hasOwnProperty.call(data, 'challenge_max_acceptances')) {
    const v = (data as any).challenge_max_acceptances;
    await pool.query(
      `UPDATE project SET challenge_max_acceptances = $2, updated_by = $3, updated_at = NOW()
        WHERE pk_project = $1 AND is_deleted = false`,
      [id, v === undefined ? null : v, userId],
    );
    // Re-read so the returned row reflects the change
    const refreshed = await pool.query<ProjectRecord>(
      `SELECT * FROM project WHERE pk_project = $1 AND is_deleted = false`,
      [id],
    );
    if (refreshed.rows[0]) return refreshed.rows[0];
  }

  return result.rows[0] || null;
}

/**
 * Soft-delete a project by ID.
 * Sets is_deleted = true, deleted_at = NOW(), updated_by.
 * Returns null if not found or already deleted.
 */
export async function remove(
  id: string,
  userId: string
): Promise<ProjectRecord | null> {
  const result = await pool.query<ProjectRecord>(
    `UPDATE project SET
       is_deleted = true,
       deleted_at = NOW(),
       updated_by = $1,
       updated_at = NOW()
     WHERE pk_project = $2
       AND is_deleted = false
     RETURNING *`,
    [userId, id]
  );

  return result.rows[0] || null;
}

/**
 * Check if a ministry exists by ID.
 */
export async function ministryExists(ministryId: string): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM ministry WHERE pk_ministry = $1',
    [ministryId]
  );
  return parseInt(result.rows[0].count, 10) > 0;
}
