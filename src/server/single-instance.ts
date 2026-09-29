// Single-instance guard: exclusive lock file next to the database.
// Stale locks (dead pid) are reclaimed; a live second instance fails fast.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

export class SingleInstanceLock {
  private fd: number | null = null;

  constructor(private readonly lockPath: string) {}

  acquire(): void {
    if (existsSync(this.lockPath)) {
      const pid = this.readPid();
      if (pid != null && this.pidAlive(pid)) {
        throw new Error(
          `Another toolkit instance (pid ${pid}) is running (lock: ${this.lockPath})`,
        );
      }
      unlinkSync(this.lockPath); // stale lock from a crashed process
    }
    this.fd = openSync(this.lockPath, 'wx');
    writeSync(this.fd, String(process.pid));
  }

  release(): void {
    if (this.fd != null) {
      closeSync(this.fd);
      this.fd = null;
      try {
        unlinkSync(this.lockPath);
      } catch {
        // already gone
      }
    }
  }

  private readPid(): number | null {
    try {
      const content = readFileSync(this.lockPath, 'utf8').trim();
      const pid = Number.parseInt(content, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

export function lockPathFor(databasePath: string): string {
  return path.join(path.dirname(databasePath), 'toolkit.lock');
}
