// Migration + reopen persistence: source tag, platform, policy, pending jobs survive.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources, updateJobs } from '../src/server/db/schema.js';

describe('sqlite migrations', () => {
  it('migrates an empty database and preserves data across reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-db-'));
    const dbPath = path.join(dir, 'toolkit.db');
    try {
      // First open: migrate + seed.
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        const now = Date.now();
        const res = db
          .insert(resources)
          .values({
            kind: 'application',
            coolifyUuid: 'app-uuid-1',
            name: 'jellyfin',
            policy: 'notify',
            configFingerprint: 'fp1',
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        db.insert(imageTracks)
          .values({
            resourceId: res.id,
            sourceRegistry: 'docker.io',
            sourceRepository: 'jellyfin/jellyfin',
            sourceRepositoryAuthored: 'jellyfin/jellyfin',
            sourceTag: 'latest',
            targetPlatform: 'linux/amd64',
            platformSource: 'server_default',
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(updateJobs)
          .values({
            resourceId: res.id,
            kind: 'initial_pin',
            trigger: 'manual',
            candidateDigest: `sha256:${'a'.repeat(64)}`,
            candidateReference: 'jellyfin/jellyfin:sha256-aaaa',
            status: 'pending',
            stage: 'queued',
            idempotencyKey: 'manual:1:digest:0',
            log: [],
            createdAt: now,
            updatedAt: now,
          })
          .run();
        close();
      }
      // Second open: migrations are idempotent, data intact.
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        const row = db
          .select()
          .from(resources)
          .where(eq(resources.coolifyUuid, 'app-uuid-1'))
          .get();
        expect(row?.policy).toBe('notify');
        const track = db
          .select()
          .from(imageTracks)
          .where(eq(imageTracks.resourceId, row!.id))
          .get();
        expect(track?.sourceTag).toBe('latest');
        expect(track?.targetPlatform).toBe('linux/amd64');
        const job = db.select().from(updateJobs).where(eq(updateJobs.resourceId, row!.id)).get();
        expect(job?.status).toBe('pending');
        close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
