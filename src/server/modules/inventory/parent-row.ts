// Shared parent-row loader for the child-inheritance gate: every caller
// (API routes, checker, jobs, executor) needs the same lookup.

import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { type ResourceRow, resources } from '../../db/schema.js';

/** db or transaction handle — both expose the same select surface. */
type Selectable = Pick<Db, 'select'>;

/** The parent service row for a resource, or null when it has no parent. */
export function parentRowOf(
  db: Selectable,
  resource: { parentId: number | null },
): ResourceRow | null {
  if (resource.parentId == null) return null;
  return db.select().from(resources).where(eq(resources.id, resource.parentId)).get() ?? null;
}
