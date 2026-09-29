// 历史表保留策略：随新记录写入触发的终态裁剪（写多少裁多少，不跑定时器）。
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** 历史表各自保留的终态记录上限。 */
export const RETENTION_MAX_ROWS = 500;

/** 任务表：终态超过上限时裁掉最旧的；进行中的（pending/running）永不清理。 */
export function pruneJobHistory(db: Db): void {
  db.run(sql`
    DELETE FROM update_jobs
    WHERE status IN ('success', 'failed', 'conflict', 'unknown_submit', 'blocked')
      AND id NOT IN (SELECT id FROM update_jobs ORDER BY id DESC LIMIT ${RETENTION_MAX_ROWS})
  `);
}

/** 通知表：已发送/失败超过上限时裁掉最旧的；待发送/暂停中的永不清理。 */
export function pruneNotificationHistory(db: Db): void {
  db.run(sql`
    DELETE FROM notification_outbox
    WHERE status IN ('sent', 'failed')
      AND id NOT IN (SELECT id FROM notification_outbox ORDER BY id DESC LIMIT ${RETENTION_MAX_ROWS})
  `);
}
