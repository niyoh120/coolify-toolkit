// Scheduler resource-cron registration: only classified, eligible resources
// get custom check crons; a sync round refreshes registrations.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import { resources } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import type { Deps } from '../src/server/deps.js';
import { Scheduler } from '../src/server/scheduler/index.js';

const CRON = '*/5 * * * *';

let h: OpenDbResult;
let dir: string;
let settings: SettingsRepo;
let scheduler: Scheduler;
let syncRuns = 0;
let cfg: AppConfig;

function resourceJobsOf(s: Scheduler): Map<number, unknown> {
  return (s as unknown as { resourceJobs: Map<number, unknown> }).resourceJobs;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-sched-'));
  h = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(h.db);
  settings = new SettingsRepo(h.db);
  cfg = {
    coolifyBaseUrl: 'http://x',
    coolifyApiKey: 'k',
    coolifyVerifyTls: true,
    excludedUuids: [],
    databasePath: path.join(dir, 'db.sqlite'),
    registryCredentials: {},
    githubToken: null,
    port: 0,
    publicOrigin: null,
    apprise: { apiUrl: null, configKey: null, tag: null, user: null, password: null },
    deployConcurrency: 1,
    dataDir: dir,
  };
  syncRuns = 0;
  scheduler = new Scheduler({
    cfg,
    db: h.db,
    settings,
    sync: {
      run: async () => {
        syncRuns += 1;
      },
    },
  } as unknown as Deps);
});

afterEach(() => {
  scheduler.stop();
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

interface SeedOpts {
  uuid?: string;
  managementClassified?: boolean;
  excludedInfra?: boolean;
  imageIssue?:
    | 'missing_image'
    | 'unsupported_registry'
    | 'unresolved_variable'
    | 'invalid_reference'
    | null;
  policy?: 'ignore' | 'notify';
  stopped?: boolean;
}

function seed(opts: SeedOpts = {}): number {
  const now = Date.now();
  return h.db
    .insert(resources)
    .values({
      kind: 'application',
      coolifyUuid: opts.uuid ?? 'sched-app',
      name: 'sched-app',
      policy: opts.policy ?? 'notify',
      checkCron: CRON,
      configFingerprint: 'fp',
      managementClassified: opts.managementClassified ?? true,
      excludedInfra: opts.excludedInfra ?? false,
      imageIssue: opts.imageIssue ?? null,
      isStopped: opts.stopped ?? false,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()!.id;
}

describe('resource cron registration guards', () => {
  it('does not register pending-sync resources; registers after classification with the same cron', () => {
    const id = seed({ managementClassified: false });
    scheduler.reloadResourceSchedules();
    expect(resourceJobsOf(scheduler).size).toBe(0);

    // 正常同步完成分类：同一 cron 配置恢复注册。
    h.db.update(resources).set({ managementClassified: true }).where(eq(resources.id, id)).run();
    scheduler.reloadResourceSchedules();
    expect(resourceJobsOf(scheduler).size).toBe(1);
    expect(resourceJobsOf(scheduler).get(id) != null).toBe(true);
  });

  it('skips excluded, image-issue, ignored and stopped resources', () => {
    seed({ uuid: 'x1', excludedInfra: true });
    seed({ uuid: 'x2', imageIssue: 'unsupported_registry' });
    seed({ uuid: 'x3', policy: 'ignore' });
    seed({ uuid: 'x4', stopped: true });
    scheduler.reloadResourceSchedules();
    expect(resourceJobsOf(scheduler).size).toBe(0);
  });

  it('refreshes registrations after a sync round (manual or scheduled path)', async () => {
    const id = seed({ managementClassified: false });
    scheduler.reloadResourceSchedules();
    expect(resourceJobsOf(scheduler).size).toBe(0);

    // 模拟一次正常同步把资源分类落库。
    (scheduler as unknown as { deps: { sync: { run(): Promise<void> } } }).deps.sync.run =
      async () => {
        syncRuns += 1;
        h.db
          .update(resources)
          .set({ managementClassified: true })
          .where(eq(resources.id, id))
          .run();
      };
    await (scheduler as unknown as { runSync(): Promise<void> }).runSync();
    expect(syncRuns).toBe(1);
    expect(resourceJobsOf(scheduler).size).toBe(1);
    expect(resourceJobsOf(scheduler).get(id) != null).toBe(true);
  });
});
