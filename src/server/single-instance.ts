// Single-instance guard: exclusive SQLite file lock next to the database.
//
// The lock is a dedicated SQLite connection holding EXCLUSIVE locking_mode on
// its own small database file (toolkit.lock.db). The lock lives in the kernel
// (POSIX byte-range locks) and is released by the OS when the process exits —
// gracefully, on kill -9, OOM, or power loss — so a stale lock can never wedge
// the next boot. This also works across pid namespaces (containers) and
// across containers sharing the same /data volume, where pid-file checks fail.
//
// Tradeoff: the lock file cannot carry the holder's pid (it would be stale or
// namespace-local), so the error message stays generic; diagnostics go through
// logs instead.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Fail fast: a second instance must not queue behind the holder's lock.
const FAIL_FAST_BUSY_TIMEOUT_MS = 0;

export class SingleInstanceLock {
  private conn: DatabaseSync | null = null;

  constructor(private readonly lockPath: string) {}

  acquire(): void {
    if (this.conn != null) {
      throw new Error('SingleInstanceLock already acquired');
    }
    const conn = new DatabaseSync(this.lockPath);
    try {
      conn.exec(`PRAGMA busy_timeout = ${FAIL_FAST_BUSY_TIMEOUT_MS};`);
      // EXCLUSIVE locking_mode keeps the kernel-level byte-range lock held
      // between transactions for this connection's lifetime.
      conn.exec('PRAGMA locking_mode = EXCLUSIVE;');
      // A real write pins the OS lock: on a brand-new (0-byte) file a bare
      // read takes no byte-range lock, so the write is what makes the lock
      // visible to other processes/connections.
      conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
      conn
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?);')
        .run('acquired_at', new Date().toISOString());
    } catch (err) {
      conn.close();
      // SQLITE_NOTADB (primary result code 26): the file exists but has no
      // SQLite header — e.g. a leftover non-SQLite artifact. Deleting it is
      // safe; the lock is kernel-held, so the file itself carries no state.
      const errcode = (err as { errcode?: number }).errcode;
      if (errcode === 26) {
        throw new Error(
          `Lock file ${this.lockPath} is corrupt (not a SQLite database); delete it and restart`,
          { cause: err },
        );
      }
      throw new Error(`Another toolkit instance is running (lock held: ${this.lockPath})`, {
        cause: err,
      });
    }
    this.conn = conn;
  }

  release(): void {
    if (this.conn != null) {
      try {
        this.conn.close(); // kernel drops the file lock, even after a crash
      } finally {
        this.conn = null;
      }
    }
  }
}

export function lockPathFor(databasePath: string): string {
  // A sibling of the real database keeps the lock on the same volume as /data
  // while never colliding with toolkit.db itself (SQLite would refuse to open
  // the same file twice).
  return path.join(path.dirname(databasePath), 'toolkit.lock.db');
}
