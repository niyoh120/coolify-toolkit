// Checker behavior: policies, dedupe, blocking, platform gaps, error isolation.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import { RegistryFailure } from '../src/server/integrations/registry/adapter.js';
import { Outbox } from '../src/server/modules/notifications/outbox.js';
import { UpdateChecker } from '../src/server/modules/updates/checker.js';
import { JobsService } from '../src/server/modules/updates/jobs.js';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

let handle: OpenDbResult;
let dir: string;
let checker: UpdateChecker;
let jobs: JobsService;
let settings: SettingsRepo;
let resolveValue: string | null = D1;
let resolveError: Error | null = null;
let resolveCalls = 0;
let cfg: AppConfig;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-check-'));
  handle = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(handle.db);
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
  settings = new SettingsRepo(handle.db);
  jobs = new JobsService(handle.db, settings);
  const outbox = new Outbox(handle.db, () => null);
  resolveValue = D1;
  resolveError = null;
  resolveCalls = 0;
  checker = new UpdateChecker(handle.db, cfg, settings, outbox, jobs, (_req, _v, _o) => {
    resolveCalls += 1;
    if (resolveError != null) {
      return Promise.reject(resolveError);
    }
    return Promise.resolve({
      digest: resolveValue ?? D1,
      referenceKind: 'index',
      platformManifestDigest: resolveValue ?? D1,
      observedAt: Date.now(),
      manifestContentType: 'application/vnd.oci.image.index.v1+json',
    });
  });
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

interface SeedOptions {
  policy?: 'ignore' | 'notify' | 'manual' | 'auto';
  configuredDigest?: string | null;
  observedDigest?: string | null;
  platform?: string | null;
  sourceTag?: string;
  blockedReason?: string | null;
  excluded?: boolean;
  stopped?: boolean;
  checkCron?: string | null;
  uuid?: string;
}

async function seed(opts: SeedOptions = {}): Promise<number> {
  const now = Date.now();
  const res = handle.db
    .insert(resources)
    .values({
      kind: 'application',
      coolifyUuid: opts.uuid ?? `uuid-${Math.random().toString(36).slice(2)}`,
      name: 'test-app',
      policy: opts.policy ?? 'notify',
      configFingerprint: 'fp',
      excludedInfra: opts.excluded ?? false,
      isStopped: opts.stopped ?? false,
      checkCron: opts.checkCron ?? null,
      blockedReason: opts.blockedReason ?? null,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  handle.db
    .insert(imageTracks)
    .values({
      resourceId: res.id,
      sourceRegistry: 'docker.io',
      sourceRepository: 'jellyfin/jellyfin',
      sourceRepositoryAuthored: 'jellyfin/jellyfin',
      sourceTag: opts.sourceTag ?? 'latest',
      targetPlatform: opts.platform === undefined ? 'linux/amd64' : opts.platform,
      platformSource: 'server_default',
      configuredDigest: opts.configuredDigest ?? null,
      observedDigest: opts.observedDigest ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return res.id;
}

describe('checker policy rules', () => {
  it('stores the upstream tag push time from the metadata lookup', async () => {
    const id = await seed({ policy: 'notify' });
    let calls = 0;
    checker = new UpdateChecker(
      handle.db,
      cfg,
      settings,
      new Outbox(handle.db, () => null),
      jobs,
      (_req, _v, _o) => {
        resolveCalls += 1;
        return Promise.resolve({
          digest: D1,
          referenceKind: 'index',
          platformManifestDigest: D1,
          observedAt: Date.now(),
          manifestContentType: 'application/vnd.oci.image.index.v1+json',
        });
      },
      (_registry, _repository, _tag) => {
        calls += 1;
        return Promise.resolve(1_700_000_000_000);
      },
    );
    await checker.checkResource(id, 'manual');
    expect(calls).toBe(1);
    const track = handle.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.upstreamTagUpdatedAt).toBe(1_700_000_000_000);
  });

  it('scheduled scan skips resources with a per-resource check cron', async () => {
    const globalId = await seed({ policy: 'notify' });
    const ownId = await seed({ policy: 'notify', checkCron: '0 6 * * *' });
    await checker.checkAll('scheduled');
    // 全局资源被扫描并产生观察；自定义 cron 资源留给独立调度，不重复查询。
    expect(resolveCalls).toBe(1);
    const ownTrack = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, ownId))
      .get();
    expect(ownTrack?.observedDigest).toBeNull();
    const globalTrack = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, globalId))
      .get();
    expect(globalTrack?.observedDigest).toBe(D1);
  });

  it('never queries ignored resources', async () => {
    const id = await seed({ policy: 'ignore' });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('blocked');
    expect(r.message).toBe('忽略策略的资源不检查更新');
    expect(resolveCalls).toBe(0);
    const track = handle.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.observedDigest).toBeNull();
  });

  it('reports specific block reasons for removed and excluded resources', async () => {
    const removedId = await seed({ policy: 'notify' });
    handle.db.update(resources).set({ status: 'removed' }).where(eq(resources.id, removedId)).run();
    const removed = await checker.checkResource(removedId, 'manual');
    expect(removed.outcome).toBe('blocked');
    expect(removed.message).toBe('资源已移除');

    const excludedId = await seed({ policy: 'notify', excluded: true });
    const excluded = await checker.checkResource(excludedId, 'manual');
    expect(excluded.outcome).toBe('blocked');
    expect(excluded.message).toBe('已排除（基础设施）');
    expect(resolveCalls).toBe(0);
  });

  it('records the first observation without changing config (unfixed)', async () => {
    const id = await seed({ policy: 'notify', configuredDigest: null });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('unfixed');
    const track = handle.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.observedDigest).toBe(D1);
    expect(track?.configuredDigest).toBeNull();
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(0);
  });

  it('detects candidates, dedupes notifications and keeps matching quiet', async () => {
    const id = await seed({ policy: 'notify', configuredDigest: D2 });
    resolveValue = D1;
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('candidate');
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(1);
    // Re-check same digest: dedupe key identical.
    await checker.checkResource(id, 'scheduled');
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(1);

    // Upstream moves back to configured: matching, no new notifications.
    resolveValue = D2;
    const r2 = await checker.checkResource(id, 'scheduled');
    expect(r2.outcome).toBe('matching');
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(1);
  });

  it('creates an auto job once per candidate for auto policy', async () => {
    const id = await seed({ policy: 'auto', configuredDigest: D2 });
    resolveValue = D1;
    await checker.checkResource(id, 'scheduled');
    const jobsRows = handle.db.select().from(updateJobs).all();
    expect(jobsRows).toHaveLength(1);
    expect(jobsRows[0]).toMatchObject({ trigger: 'auto', candidateDigest: D1 });
    // Repeat scan: no duplicate job.
    await checker.checkResource(id, 'scheduled');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(1);
  });

  it('skips auto jobs for stopped resources and global pause', async () => {
    const id = await seed({ policy: 'auto', configuredDigest: D2, stopped: true });
    resolveValue = D1;
    await checker.checkResource(id, 'scheduled');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(0);

    settings.patch({ globalPaused: true });
    const id2 = await seed({ policy: 'auto', configuredDigest: D2, uuid: 'u2' });
    await checker.checkResource(id2, 'scheduled');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(0);
  });

  it('blocks checks when platform is missing', async () => {
    const id = await seed({ policy: 'notify', configuredDigest: D2, platform: null });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('blocked');
    expect(r.message).toBe('目标平台待配置');
    expect(resolveCalls).toBe(0);
  });

  it('blocks checks for external-change resources', async () => {
    const id = await seed({
      policy: 'notify',
      configuredDigest: D2,
      blockedReason: 'external_change',
    });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('blocked');
    expect(r.message).toBe('外部修改，需重新确认');
    expect(resolveCalls).toBe(0);
  });

  it('keeps the previous observation on registry errors and records the cause', async () => {
    const id = await seed({ policy: 'notify', configuredDigest: D2, observedDigest: D2 });
    resolveError = new RegistryFailure({
      kind: 'server',
      message: 'Registry server error (HTTP 503)',
      statusCode: 503,
      retryable: true,
    });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('error');
    const track = handle.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.observedDigest).toBe(D2); // old observation retained
    expect(track?.observedError).toContain('503');
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(0);
  });

  it('requires the tracking tag before checking', async () => {
    const id = await seed({ policy: 'notify', sourceTag: '' });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('blocked');
    expect(r.message).toBe('追踪 tag 待配置');
    expect(resolveCalls).toBe(0);
  });
});

describe('auto initialization for uninitialized resources', () => {
  it('creates an initial pin job on any check for non-ignore policies', async () => {
    const scheduledId = await seed({ policy: 'notify', configuredDigest: null, uuid: 'u-n' });
    const manualId = await seed({ policy: 'manual', configuredDigest: null, uuid: 'u-m' });
    const autoId = await seed({ policy: 'auto', configuredDigest: null, uuid: 'u-a' });
    await checker.checkResource(scheduledId, 'scheduled');
    await checker.checkResource(manualId, 'manual');
    // auto 资源的手动检查同样初始化（初始化与候选更新的 reason 门槛不同）。
    await checker.checkResource(autoId, 'manual');
    const rows = handle.db.select().from(updateJobs).all();
    expect(rows).toHaveLength(3);
    const byResource = new Map(rows.map((j) => [j.resourceId, j]));
    expect(byResource.get(scheduledId)).toMatchObject({
      kind: 'initial_pin',
      trigger: 'auto',
      status: 'pending',
      candidateDigest: D1,
    });
    expect(byResource.get(manualId)).toMatchObject({ kind: 'initial_pin', trigger: 'manual' });
    expect(byResource.get(autoId)).toMatchObject({ kind: 'initial_pin', trigger: 'manual' });
    // 配置摘要由部署成功证据推进，检查本身只观察。
    const track = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, scheduledId))
      .get();
    expect(track?.configuredDigest).toBeNull();
  });

  it('skips initialization under guards and keeps the resource unfixed', async () => {
    const stoppedId = await seed({ policy: 'auto', configuredDigest: null, stopped: true });
    const blockedId = await seed({
      policy: 'notify',
      configuredDigest: null,
      blockedReason: 'compose_confirmation_pending',
      uuid: 'u-b',
    });
    const stopped = await checker.checkResource(stoppedId, 'scheduled');
    const blocked = await checker.checkResource(blockedId, 'scheduled');
    expect(stopped.outcome).toBe('unfixed');
    expect(blocked.outcome).toBe('unfixed');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(0);

    settings.patch({ globalPaused: true });
    const pausedId = await seed({ policy: 'auto', configuredDigest: null, uuid: 'u-p' });
    const paused = await checker.checkResource(pausedId, 'scheduled');
    expect(paused.outcome).toBe('unfixed');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(0);
  });

  it('suppresses the drift notification when an initial pin job was created', async () => {
    const id = await seed({ policy: 'notify', configuredDigest: null, observedDigest: D2 });
    resolveValue = D1;
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('unfixed');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(1);
    // 初始化已接管在途，部署完成另有 update_success 通知，漂移通知是噪音。
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(0);
  });

  it('notifies upstream drift once when initialization is skipped', async () => {
    const id = await seed({ policy: 'notify', configuredDigest: null, observedDigest: D2 });
    resolveValue = D1;
    settings.patch({ globalPaused: true });
    const r = await checker.checkResource(id, 'scheduled');
    expect(r.outcome).toBe('unfixed');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(0);
    const boxes = handle.db.select().from(notificationOutbox).all();
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.eventType).toBe('upstream_changed');
    // Repeat scan: dedupe key identical.
    await checker.checkResource(id, 'scheduled');
    expect(handle.db.select().from(notificationOutbox).all()).toHaveLength(1);
  });

  it('does not re-create the initial pin job while the previous attempt failed', async () => {
    const id = await seed({ policy: 'auto', configuredDigest: null });
    await checker.checkResource(id, 'scheduled');
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(1);
    handle.db.update(updateJobs).set({ status: 'failed' }).run();
    await checker.checkResource(id, 'scheduled');
    // 同 digest 失败任务阻塞重建：等上游变化或人工重试，避免每轮扫描反复部署。
    expect(handle.db.select().from(updateJobs).all()).toHaveLength(1);
  });
});
