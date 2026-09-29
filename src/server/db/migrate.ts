// Applies drizzle-kit generated SQL migrations from ./drizzle.
// A migration failure must stop startup: partial schema = unsupported state.

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { migrate as drizzleMigrate } from 'drizzle-orm/node-sqlite/migrator';
import type { Db } from './client.js';

export function migrate(db: Db, migrationsFolder?: string): void {
  const folder =
    migrationsFolder ??
    pickExisting([
      // tsx dev / vitest run from project root
      path.resolve(process.cwd(), 'drizzle'),
      // source layout: src/server/db -> project root
      path.resolve(import.meta.dirname, '../../../drizzle'),
      // bundled layout: dist/server -> project root
      path.resolve(import.meta.dirname, '../../drizzle'),
    ]);
  if (folder == null) {
    throw new Error('Drizzle migrations folder not found (cwd/drizzle or bundle-relative)');
  }
  drizzleMigrate(db, { migrationsFolder: folder });
}

function pickExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isDirectory()) return c;
  }
  return null;
}
