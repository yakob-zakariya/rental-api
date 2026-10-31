import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  cursorTimestampSql,
  decodeCursor,
  encodeCursor,
} from '../pagination.js';
import {
  type AdminActionPageDto,
  DEFAULT_PAGE_SIZE,
  type ListAdminActionsQuery,
} from './admin-actions.dto.js';

interface Row {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
  created_at: Date;
  /** created_at with full (microsecond) precision, for the cursor. */
  cursor_ts: string;
  admin_id: string;
  admin_email: string;
}

/** GET /admin/actions: the audit log, newest first, paged by a (created_at, id) cursor. */
@Injectable()
export class AdminActionsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: ListAdminActionsQuery): Promise<AdminActionPageDto> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (query.targetId) add('a.target_id = ?', query.targetId);
    if (query.adminId) add('a.admin_id = ?', query.adminId);
    if (query.action) add('a.action = ?', query.action);
    if (query.before) {
      const cursor = decodeCursor(query.before);
      params.push(cursor.createdAt, cursor.id);
      // Composite cursor: rows with the same timestamp still page correctly (ties broken by id).
      where.push(
        `(a.created_at, a.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }

    params.push(limit + 1);
    const rows = await this.dataSource.query<Row[]>(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at,
              ${cursorTimestampSql('a.created_at')} AS cursor_ts,
              u.id AS admin_id, u.email AS admin_email
       FROM admin_actions a JOIN admin_users u ON u.id = a.admin_id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        details: row.details,
        createdAt: row.created_at.toISOString(),
        admin: { id: row.admin_id, email: row.admin_email },
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.cursor_ts, last.id)
          : null,
    };
  }
}
