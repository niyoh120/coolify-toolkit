// Single-instance lock: kernel-held SQLite file lock.
// Regression guard: a second instance must fail fast, and a crashed holder
// (kill -9 / power loss) must never wedge the next boot.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockPathFor, SingleInstanceLock } from '../src/server/single-instance.js';

// Acquisition protocol mirror for the crash-test child process. The child is
// plain .mjs (no TS loader in spawned node); if the impl's protocol changes,
// keep this snippet in sync — the first two tests pin the real class.
const CHILD_ACQUIRE = `
import { DatabaseSync } from 'node:sqlite';
const lockPath = process.argv[2];
const conn = new DatabaseSync(lockPath);
conn.exec('PRAGMA busy_timeout = 0;');
conn.exec('PRAGMA locking_mode = EXCLUSIVE;');
conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
conn.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?);').run('acquired_at', new Date().toISOString());
// Exit hard while holding the lock: kill -9 semantics — no release(), no
// graceful close — exactly what a container kill -9, OOM kill, or power loss
// leaves behind on the volume.
process.kill(process.pid, 'SIGKILL');
`;

describe('SingleInstanceLock', () => {
  const dirs: string[] = [];

  function makeLockDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-lock-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir == null) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks a second instance in the same process', () => {
    const dir = makeLockDir();
    const first = new SingleInstanceLock(lockPathFor(path.join(dir, 'toolkit.db')));
    first.acquire();
    try {
      const second = new SingleInstanceLock(lockPathFor(path.join(dir, 'toolkit.db')));
      expect(() => second.acquire()).toThrowError(/Another toolkit instance is running/);
    } finally {
      first.release();
    }
  });

  it('allows re-acquire after release', () => {
    const dir = makeLockDir();
    const dbPath = path.join(dir, 'toolkit.db');
    const first = new SingleInstanceLock(lockPathFor(dbPath));
    first.acquire();
    first.release();
    const second = new SingleInstanceLock(lockPathFor(dbPath));
    expect(() => second.acquire()).not.toThrow();
    second.release();
  });

  it('gives a distinct error when the lock file is corrupt (not a SQLite db)', () => {
    const dir = makeLockDir();
    const lockPath = lockPathFor(path.join(dir, 'toolkit.db'));
    writeFileSync(lockPath, 'junk bytes, definitely no sqlite header here');
    const lock = new SingleInstanceLock(lockPath);
    expect(() => lock.acquire()).toThrowError(/is corrupt \(not a SQLite database\)/);
  });

  it('recovers after the holder dies without releasing (crash / power loss)', async () => {
    const dir = makeLockDir();
    const lockPath = lockPathFor(path.join(dir, 'toolkit.db'));
    const childScript = path.join(dir, 'crash-holder.mjs');
    writeFileSync(childScript, CHILD_ACQUIRE);
    const holder = spawn(process.execPath, [childScript, lockPath], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      holder.on('error', reject);
      holder.on('exit', (code, signal) =>
        signal === 'SIGKILL'
          ? resolve()
          : reject(new Error(`holder exited: code=${code} signal=${signal}`)),
      );
    });
    // No stale-lock cleanup needed: the kernel released the byte-range lock
    // when the holder died, so the next boot just works.
    const next = new SingleInstanceLock(lockPath);
    expect(() => next.acquire()).not.toThrow();
    next.release();
  });
});
