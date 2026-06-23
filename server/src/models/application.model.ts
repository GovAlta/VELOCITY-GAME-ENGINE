import { pool } from '../config/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApplicationRecord {
  pk_application: string;
  fk_application_ministry: string | null;
  application_name: string;
  application_aliases: string | null;
  application_description: string | null;
  application_business_process: string | null;
  application_type: string | null;
  application_architecture_type: string | null;
  application_install_type: string | null;
  application_install_status: string | null;
  application_lifecycle_stage_status: string | null;
  application_lifecycle_stage: string | null;
  application_technology_stack: string | null;
  application_user_base: string | null;
  application_platform: string | null;
  application_last_change_date: string | null;
  application_business_owner: string | null;
  application_it_owner: string | null;
  application_last_updated_by: string | null;
  application_business_criticality: string | null;
  application_emergency_tier: string | null;
  application_data_classification: string | null;
  application_is_certified: boolean;
  application_department: string | null;
  application_source: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
  is_deleted: boolean;
}

export interface ApplicationListItem extends ApplicationRecord {
  ministry_code: string | null;
  ministry_name: string | null;
}

export interface ApplicationFilters {
  search?: string;
  ministry?: string;
  installType?: string;
  dataClassification?: string;
  applicationType?: string;
  businessCriticality?: string;
  sort?: string;
  order?: string;
}

// ---------------------------------------------------------------------------
// Allowed sort columns — prevents SQL injection via sort parameter
// ---------------------------------------------------------------------------

const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  application_name: 'a.application_name',
  application_type: 'a.application_type',
  application_install_type: 'a.application_install_type',
  application_install_status: 'a.application_install_status',
  application_lifecycle_stage: 'a.application_lifecycle_stage',
  application_business_criticality: 'a.application_business_criticality',
  application_data_classification: 'a.application_data_classification',
  ministry_name: 'm.ministry_name',
  updated_at: 'a.updated_at',
  created_at: 'a.created_at',
};

// ---------------------------------------------------------------------------
// Build WHERE clause
// ---------------------------------------------------------------------------

function buildWhereClause(filters: ApplicationFilters): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = ['a.is_deleted = false'];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Search filter — application name, aliases, or technology stack
  if (filters.search) {
    clauses.push(
      `(a.application_name ILIKE $${paramIndex} OR a.application_aliases ILIKE $${paramIndex} OR a.application_technology_stack ILIKE $${paramIndex})`
    );
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  // Ministry filter — supports UUID or ministry code
  if (filters.ministry) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filters.ministry);
    if (isUuid) {
      clauses.push(`a.fk_application_ministry = $${paramIndex++}`);
      params.push(filters.ministry);
    } else {
      clauses.push(`m.ministry_code ILIKE $${paramIndex++}`);
      params.push(filters.ministry);
    }
  }

  // Install type filter
  if (filters.installType) {
    clauses.push(`a.application_install_type = $${paramIndex++}`);
    params.push(filters.installType);
  }

  // Data classification filter
  if (filters.dataClassification) {
    clauses.push(`a.application_data_classification = $${paramIndex++}`);
    params.push(filters.dataClassification);
  }

  // Application type filter
  if (filters.applicationType) {
    clauses.push(`a.application_type = $${paramIndex++}`);
    params.push(filters.applicationType);
  }

  // Business criticality filter
  if (filters.businessCriticality) {
    clauses.push(`a.application_business_criticality = $${paramIndex++}`);
    params.push(filters.businessCriticality);
  }

  return { clauses, params };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Find all applications with filtering, sorting, and pagination.
 * Joins ministry for ministry name/code.
 */
export async function findAll(
  filters: ApplicationFilters,
  page: number,
  limit: number
): Promise<ApplicationListItem[]> {
  const { clauses, params } = buildWhereClause(filters);
  const whereStr = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // Safe sort column lookup
  const sortColumn = ALLOWED_SORT_COLUMNS[filters.sort || ''] || 'a.updated_at';
  const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';

  const offset = (page - 1) * limit;
  const paramIndex = params.length + 1;

  const query = `
    SELECT
      a.*,
      m.ministry_code,
      m.ministry_name
    FROM application a
    LEFT JOIN ministry m ON a.fk_application_ministry = m.pk_ministry
    ${whereStr}
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const result = await pool.query<ApplicationListItem>(query, params);
  return result.rows;
}

/**
 * Count all applications matching filters (for pagination metadata).
 */
export async function countAll(filters: ApplicationFilters): Promise<number> {
  const { clauses, params } = buildWhereClause(filters);
  const whereStr = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const query = `
    SELECT COUNT(*) AS count
    FROM application a
    LEFT JOIN ministry m ON a.fk_application_ministry = m.pk_ministry
    ${whereStr}
  `;

  const result = await pool.query<{ count: string }>(query, params);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Find a single application by ID.
 * Returns null if not found or soft-deleted.
 */
export async function findById(id: string): Promise<ApplicationListItem | null> {
  const result = await pool.query<ApplicationListItem>(
    `SELECT
       a.*,
       m.ministry_code,
       m.ministry_name
     FROM application a
     LEFT JOIN ministry m ON a.fk_application_ministry = m.pk_ministry
     WHERE a.pk_application = $1
       AND a.is_deleted = false`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Create a new application. Returns the newly created record.
 */
export async function create(
  data: Partial<ApplicationRecord>,
  userId: string
): Promise<ApplicationRecord> {
  const result = await pool.query<ApplicationRecord>(
    `INSERT INTO application (
       fk_application_ministry,
       application_name,
       application_aliases,
       application_description,
       application_business_process,
       application_type,
       application_architecture_type,
       application_install_type,
       application_install_status,
       application_lifecycle_stage_status,
       application_lifecycle_stage,
       application_technology_stack,
       application_user_base,
       application_platform,
       application_last_change_date,
       application_business_owner,
       application_it_owner,
       application_last_updated_by,
       application_business_criticality,
       application_emergency_tier,
       application_data_classification,
       application_is_certified,
       application_department,
       application_source,
       created_by,
       updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23, $24, $25, $25
     )
     RETURNING *`,
    [
      data.fk_application_ministry || null,
      data.application_name,
      data.application_aliases || null,
      data.application_description || null,
      data.application_business_process || null,
      data.application_type || null,
      data.application_architecture_type || null,
      data.application_install_type || null,
      data.application_install_status || null,
      data.application_lifecycle_stage_status || null,
      data.application_lifecycle_stage || null,
      data.application_technology_stack || null,
      data.application_user_base || null,
      data.application_platform || null,
      data.application_last_change_date || null,
      data.application_business_owner || null,
      data.application_it_owner || null,
      data.application_last_updated_by || null,
      data.application_business_criticality || null,
      data.application_emergency_tier || null,
      data.application_data_classification || null,
      data.application_is_certified ?? false,
      data.application_department || null,
      data.application_source || null,
      userId,
    ]
  );

  return result.rows[0];
}

/**
 * Update an application by ID. Returns the updated record.
 * Returns null if not found or soft-deleted.
 */
export async function update(
  id: string,
  data: Partial<ApplicationRecord>,
  userId: string
): Promise<ApplicationRecord | null> {
  const result = await pool.query<ApplicationRecord>(
    `UPDATE application SET
       fk_application_ministry = COALESCE($1, fk_application_ministry),
       application_name = COALESCE($2, application_name),
       application_aliases = COALESCE($3, application_aliases),
       application_description = COALESCE($4, application_description),
       application_business_process = COALESCE($5, application_business_process),
       application_type = COALESCE($6, application_type),
       application_architecture_type = COALESCE($7, application_architecture_type),
       application_install_type = COALESCE($8, application_install_type),
       application_install_status = COALESCE($9, application_install_status),
       application_lifecycle_stage_status = COALESCE($10, application_lifecycle_stage_status),
       application_lifecycle_stage = COALESCE($11, application_lifecycle_stage),
       application_technology_stack = COALESCE($12, application_technology_stack),
       application_user_base = COALESCE($13, application_user_base),
       application_platform = COALESCE($14, application_platform),
       application_last_change_date = COALESCE($15, application_last_change_date),
       application_business_owner = COALESCE($16, application_business_owner),
       application_it_owner = COALESCE($17, application_it_owner),
       application_last_updated_by = COALESCE($18, application_last_updated_by),
       application_business_criticality = COALESCE($19, application_business_criticality),
       application_emergency_tier = COALESCE($20, application_emergency_tier),
       application_data_classification = COALESCE($21, application_data_classification),
       application_is_certified = COALESCE($22, application_is_certified),
       application_department = COALESCE($23, application_department),
       application_source = COALESCE($24, application_source),
       updated_by = $25,
       updated_at = NOW()
     WHERE pk_application = $26
       AND is_deleted = false
     RETURNING *`,
    [
      data.fk_application_ministry,
      data.application_name,
      data.application_aliases,
      data.application_description,
      data.application_business_process,
      data.application_type,
      data.application_architecture_type,
      data.application_install_type,
      data.application_install_status,
      data.application_lifecycle_stage_status,
      data.application_lifecycle_stage,
      data.application_technology_stack,
      data.application_user_base,
      data.application_platform,
      data.application_last_change_date,
      data.application_business_owner,
      data.application_it_owner,
      data.application_last_updated_by,
      data.application_business_criticality,
      data.application_emergency_tier,
      data.application_data_classification,
      data.application_is_certified,
      data.application_department,
      data.application_source,
      userId,
      id,
    ]
  );

  return result.rows[0] || null;
}

/**
 * Soft-delete an application by ID.
 * Sets is_deleted = true, deleted_at = NOW(), updated_by.
 * Returns null if not found or already deleted.
 */
export async function remove(
  id: string,
  userId: string
): Promise<ApplicationRecord | null> {
  const result = await pool.query<ApplicationRecord>(
    `UPDATE application SET
       is_deleted = true,
       deleted_at = NOW(),
       updated_by = $1,
       updated_at = NOW()
     WHERE pk_application = $2
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
