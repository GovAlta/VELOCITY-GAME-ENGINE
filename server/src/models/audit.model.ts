import { pool } from '../config/database';

export interface AuditLogEntry {
  pk_audit_log: string;
  audit_table_name: string;
  audit_record_id: string;
  audit_action: 'INSERT' | 'UPDATE' | 'DELETE';
  audit_old_data: Record<string, unknown> | null;
  audit_new_data: Record<string, unknown> | null;
  audit_user_id: string | null;
  audit_ip_address: string | null;
  created_at: string;
}

/**
 * Create an audit log entry for data mutations.
 */
export async function createAuditEntry(
  tableName: string,
  recordId: string,
  action: 'INSERT' | 'UPDATE' | 'DELETE',
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null,
  userId: string | null,
  ipAddress: string | null
): Promise<AuditLogEntry> {
  const result = await pool.query<AuditLogEntry>(
    `INSERT INTO audit_log
      (audit_table_name, audit_record_id, audit_action, audit_old_data, audit_new_data, audit_user_id, audit_ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      tableName,
      recordId,
      action,
      oldData ? JSON.stringify(oldData) : null,
      newData ? JSON.stringify(newData) : null,
      userId,
      ipAddress,
    ]
  );
  return result.rows[0];
}
