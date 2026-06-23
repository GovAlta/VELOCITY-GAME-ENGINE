import { pool } from '../config/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractRecord {
  pk_contract: string;
  fk_contract_ministry: string | null;
  contract_external_id: string | null;
  contract_commodity_type: string | null;
  contract_name: string;
  contract_description: string | null;
  contract_vendor: string | null;
  contract_effective_date: string | null;
  contract_expiration_date: string | null;
  contract_hierarchy_type: string | null;
  contract_source: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
  is_deleted: boolean;
}

export interface ContractListItem extends ContractRecord {
  ministry_code: string | null;
  ministry_name: string | null;
}

export interface ContractFilters {
  search?: string;
  ministry?: string;
  vendor?: string;
  commodityType?: string;
  expiringBefore?: string;
  expiringAfter?: string;
  sort?: string;
  order?: string;
}

// ---------------------------------------------------------------------------
// Allowed sort columns — prevents SQL injection via sort parameter
// ---------------------------------------------------------------------------

const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  contract_name: 'c.contract_name',
  contract_vendor: 'c.contract_vendor',
  contract_effective_date: 'c.contract_effective_date',
  contract_expiration_date: 'c.contract_expiration_date',
  contract_commodity_type: 'c.contract_commodity_type',
  ministry_name: 'm.ministry_name',
  updated_at: 'c.updated_at',
  created_at: 'c.created_at',
};

// ---------------------------------------------------------------------------
// Build WHERE clause
// ---------------------------------------------------------------------------

function buildWhereClause(filters: ContractFilters): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = ['c.is_deleted = false'];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Search filter — contract name, vendor, external ID, or description
  if (filters.search) {
    clauses.push(
      `(c.contract_name ILIKE $${paramIndex} OR c.contract_vendor ILIKE $${paramIndex} OR c.contract_external_id ILIKE $${paramIndex} OR c.contract_description ILIKE $${paramIndex})`
    );
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  // Ministry filter — supports UUID or ministry code
  if (filters.ministry) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filters.ministry);
    if (isUuid) {
      clauses.push(`c.fk_contract_ministry = $${paramIndex++}`);
      params.push(filters.ministry);
    } else {
      clauses.push(`m.ministry_code ILIKE $${paramIndex++}`);
      params.push(filters.ministry);
    }
  }

  // Vendor filter
  if (filters.vendor) {
    clauses.push(`c.contract_vendor ILIKE $${paramIndex++}`);
    params.push(`%${filters.vendor}%`);
  }

  // Commodity type filter
  if (filters.commodityType) {
    clauses.push(`c.contract_commodity_type = $${paramIndex++}`);
    params.push(filters.commodityType);
  }

  // Expiring before filter
  if (filters.expiringBefore) {
    clauses.push(`c.contract_expiration_date <= $${paramIndex++}`);
    params.push(filters.expiringBefore);
  }

  // Expiring after filter
  if (filters.expiringAfter) {
    clauses.push(`c.contract_expiration_date >= $${paramIndex++}`);
    params.push(filters.expiringAfter);
  }

  return { clauses, params };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Find all contracts with filtering, sorting, and pagination.
 * Joins ministry for ministry name/code.
 */
export async function findAll(
  filters: ContractFilters,
  page: number,
  limit: number
): Promise<ContractListItem[]> {
  const { clauses, params } = buildWhereClause(filters);
  const whereStr = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  // Safe sort column lookup
  const sortColumn = ALLOWED_SORT_COLUMNS[filters.sort || ''] || 'c.updated_at';
  const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';

  const offset = (page - 1) * limit;
  const paramIndex = params.length + 1;

  const query = `
    SELECT
      c.*,
      m.ministry_code,
      m.ministry_name
    FROM contract c
    LEFT JOIN ministry m ON c.fk_contract_ministry = m.pk_ministry
    ${whereStr}
    ORDER BY ${sortColumn} ${sortOrder}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const result = await pool.query<ContractListItem>(query, params);
  return result.rows;
}

/**
 * Count all contracts matching filters (for pagination metadata).
 */
export async function countAll(filters: ContractFilters): Promise<number> {
  const { clauses, params } = buildWhereClause(filters);
  const whereStr = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const query = `
    SELECT COUNT(*) AS count
    FROM contract c
    LEFT JOIN ministry m ON c.fk_contract_ministry = m.pk_ministry
    ${whereStr}
  `;

  const result = await pool.query<{ count: string }>(query, params);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Find a single contract by ID.
 * Returns null if not found or soft-deleted.
 */
export async function findById(id: string): Promise<ContractListItem | null> {
  const result = await pool.query<ContractListItem>(
    `SELECT
       c.*,
       m.ministry_code,
       m.ministry_name
     FROM contract c
     LEFT JOIN ministry m ON c.fk_contract_ministry = m.pk_ministry
     WHERE c.pk_contract = $1
       AND c.is_deleted = false`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Create a new contract. Returns the newly created record.
 */
export async function create(
  data: Partial<ContractRecord>,
  userId: string
): Promise<ContractRecord> {
  const result = await pool.query<ContractRecord>(
    `INSERT INTO contract (
       fk_contract_ministry,
       contract_external_id,
       contract_commodity_type,
       contract_name,
       contract_description,
       contract_vendor,
       contract_effective_date,
       contract_expiration_date,
       contract_hierarchy_type,
       contract_source,
       created_by,
       updated_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $11
     )
     RETURNING *`,
    [
      data.fk_contract_ministry || null,
      data.contract_external_id || null,
      data.contract_commodity_type || null,
      data.contract_name,
      data.contract_description || null,
      data.contract_vendor || null,
      data.contract_effective_date || null,
      data.contract_expiration_date || null,
      data.contract_hierarchy_type || null,
      data.contract_source || null,
      userId,
    ]
  );

  return result.rows[0];
}

/**
 * Update a contract by ID. Returns the updated record.
 * Returns null if not found or soft-deleted.
 */
export async function update(
  id: string,
  data: Partial<ContractRecord>,
  userId: string
): Promise<ContractRecord | null> {
  const result = await pool.query<ContractRecord>(
    `UPDATE contract SET
       fk_contract_ministry = COALESCE($1, fk_contract_ministry),
       contract_external_id = COALESCE($2, contract_external_id),
       contract_commodity_type = COALESCE($3, contract_commodity_type),
       contract_name = COALESCE($4, contract_name),
       contract_description = COALESCE($5, contract_description),
       contract_vendor = COALESCE($6, contract_vendor),
       contract_effective_date = COALESCE($7, contract_effective_date),
       contract_expiration_date = COALESCE($8, contract_expiration_date),
       contract_hierarchy_type = COALESCE($9, contract_hierarchy_type),
       contract_source = COALESCE($10, contract_source),
       updated_by = $11,
       updated_at = NOW()
     WHERE pk_contract = $12
       AND is_deleted = false
     RETURNING *`,
    [
      data.fk_contract_ministry,
      data.contract_external_id,
      data.contract_commodity_type,
      data.contract_name,
      data.contract_description,
      data.contract_vendor,
      data.contract_effective_date,
      data.contract_expiration_date,
      data.contract_hierarchy_type,
      data.contract_source,
      userId,
      id,
    ]
  );

  return result.rows[0] || null;
}

/**
 * Soft-delete a contract by ID.
 * Sets is_deleted = true, deleted_at = NOW(), updated_by.
 * Returns null if not found or already deleted.
 */
export async function remove(
  id: string,
  userId: string
): Promise<ContractRecord | null> {
  const result = await pool.query<ContractRecord>(
    `UPDATE contract SET
       is_deleted = true,
       deleted_at = NOW(),
       updated_by = $1,
       updated_at = NOW()
     WHERE pk_contract = $2
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
