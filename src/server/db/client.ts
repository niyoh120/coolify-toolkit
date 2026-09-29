// Database lifecycle: open SQLite (WAL), apply versioned migrations, expose drizzle.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from './migrate.js';
import * as schema from './schema.js';

export type Db = ReturnType<typeof makeDb>;

function makeDb(client: DatabaseSync) {
  return drizzle({ client });
}

export interface OpenDbResult {
  db: Db;
  sqlite: DatabaseSync;
  close(): void;
}

export function openDatabase(databasePath: string): OpenDbResult {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(sqlite);
  return {
    db,
    sqlite,
    close() {
      sqlite.close();
    },
  };
}

export { migrate, schema };
