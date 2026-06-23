import { pool } from '../config/database';

export interface MinistryWithCount {
  pk_ministry: string;
  ministry_code: string;
  ministry_name: string;
  ministry_is_active: boolean;
  project_count: number;
}

export async function listAll(): Promise<MinistryWithCount[]> {
  const result = await pool.query(`
    SELECT m.pk_ministry, m.ministry_code, m.ministry_name, m.ministry_is_active,
           COUNT(p.pk_project) FILTER (WHERE p.is_deleted = false)::int AS project_count
    FROM ministry m
    LEFT JOIN project p ON p.fk_project_ministry = m.pk_ministry
    GROUP BY m.pk_ministry
    ORDER BY project_count DESC, m.ministry_code ASC
  `);
  return result.rows;
}

export async function findByCode(code: string): Promise<MinistryWithCount | null> {
  const result = await pool.query(`
    SELECT m.pk_ministry, m.ministry_code, m.ministry_name, m.ministry_is_active,
           COUNT(p.pk_project) FILTER (WHERE p.is_deleted = false)::int AS project_count
    FROM ministry m
    LEFT JOIN project p ON p.fk_project_ministry = m.pk_ministry
    WHERE m.ministry_code = $1
    GROUP BY m.pk_ministry
  `, [code]);
  return result.rows[0] || null;
}

export async function getProjectsByMinistry(code: string, page = 1, limit = 50) {
  const offset = (page - 1) * limit;
  const result = await pool.query(`
    SELECT p.*, m.ministry_code, m.ministry_name,
           (SELECT STRING_AGG(pl.lead_name, ', ') FROM project_lead pl WHERE pl.fk_project_lead_project = p.pk_project AND pl.lead_is_primary = true) AS primary_lead
    FROM project p
    JOIN ministry m ON m.pk_ministry = p.fk_project_ministry
    WHERE m.ministry_code = $1 AND p.is_deleted = false
    ORDER BY p.project_end_date ASC NULLS LAST
    LIMIT $2 OFFSET $3
  `, [code, limit, offset]);

  const countResult = await pool.query(`
    SELECT COUNT(*)::int AS total
    FROM project p
    JOIN ministry m ON m.pk_ministry = p.fk_project_ministry
    WHERE m.ministry_code = $1 AND p.is_deleted = false
  `, [code]);

  return {
    data: result.rows,
    pagination: {
      page, limit,
      total: countResult.rows[0].total,
      totalPages: Math.ceil(countResult.rows[0].total / limit),
    },
  };
}
