// Executor end-to-end behavior against a stub Coolify + real SQLite.
// Covers: happy path, deploy failure retention, conflict, retry, unknown submit,
// crash recovery and compose child flows.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import type { UpdateJobRow } from '../src/server/db/schema.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import type { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import { CoolifyApiError } from '../src/server/integrations/coolify/client.js';
import { Outbox } from '../src/server/modules/notifications/outbox.js';
import { UpdateChecker } from '../src/server/modules/updates/checker.js';
import { UpdateExecutor } from '../src/server/modules/updates/executor.js';
import { JobsService } from '../src/server/modules/updates/jobs.js';
import type {
  CoolifyApplication,
  CoolifyDeployment,
  CoolifyService,
  CoolifyServiceApplication,
} from '../src/shared/schemas.js';

const D_A = `sha256:${'a'.repeat(64)}`; // currently configured (pinned A)
const D_B = `sha256:${'b'.repeat(64)}`; // candidate (pinned B)
const TAG_A = `sha256-${'a'.repeat(64)}`;

let h: OpenDbResult;
let dir: string;
let jobs: JobsService;
let executor: UpdateExecutor;
let settings: SettingsRepo;
let outbox: Outbox;
let cfg: AppConfig;
let coolify: StubCoolify;

class StubCoolify {
  appState = {
    uuid: 'app-1',
    docker_image: 'jellyfin/jellyfin',
    docker_image_tag: TAG_A,
    status: 'running',
  };
  /** 其他 uuid 的应用状态（队列/升级过渡场景需要多资源）。 */
  extraApps = new Map<string, { docker_image: string; docker_image_tag: string; status: string }>();
  patchCalls = 0;
  startCalls = 0;
  startBehavior: 'ok' | 'timeout' = 'ok';
  deploymentStatus = 'finished';
  failDeployment = false;

  client(): CoolifyClient {
    const self = this;
    return {
      async getApplication(uuid: string) {
        if (uuid === 'app-1') return { ...self.appState } as unknown as CoolifyApplication;
        const extra = self.extraApps.get(uuid);
        if (extra == null) throw new CoolifyApiError('missing', 404);
        return {
          uuid,
          docker_image: extra.docker_image,
          docker_image_tag: extra.docker_image_tag,
          status: extra.status,
        } as unknown as CoolifyApplication;
      },
      async patchApplication(uuid: string, patch: Record<string, unknown>) {
        self.patchCalls += 1;
        if (uuid === 'app-1') {
          self.appState.docker_image_tag = patch.docker_image_tag as string;
        } else {
          const extra = self.extraApps.get(uuid);
          if (extra != null) extra.docker_image_tag = patch.docker_image_tag as string;
        }
        return {};
      },
      async startApplication() {
        self.startCalls += 1;
        if (self.startBehavior === 'timeout')
          throw new CoolifyApiError('Coolify request timed out', null);
        return { deploymentUuid: `dep-${self.startCalls}` };
      },
      async getDeployment(uuid: string) {
        return {
          deployment_uuid: uuid,
          status: self.deploymentStatus,
        } as unknown as CoolifyDeployment;
      },
      async getDeploymentsForApplication() {
        return [];
      },
    } as unknown as CoolifyClient;
  }
}

function freshExecutor(): void {
  executor = new UpdateExecutor(h.db, coolify.client(), jobs, outbox, settings, cfg, {
    pollIntervalMs: 5,
    confirmWindowMs: 2_000,
    autoConfirmDelayMs: 60_000,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-exec-'));
  h = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(h.db);
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
  settings = new SettingsRepo(h.db);
  outbox = new Outbox(h.db, () => null);
  jobs = new JobsService(h.db, settings);
  coolify = new StubCoolify();
  freshExecutor();

  // Seed an already-pinned application at digest A.
  const now = Date.now();
  const res = h.db
    .insert(resources)
    .values({
      kind: 'application',
      coolifyUuid: 'app-1',
      name: 'jellyfin',
      policy: 'notify',
      configFingerprint: 'fp',
      currentImage: `jellyfin/jellyfin:${TAG_A}`,
      managementClassified: true,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  h.db
    .insert(imageTracks)
    .values({
      resourceId: res.id,
      sourceRegistry: 'docker.io',
      sourceRepository: 'jellyfin/jellyfin',
      sourceRepositoryAuthored: 'jellyfin/jellyfin',
      sourceTag: 'latest',
      targetPlatform: 'linux/amd64',
      platformSource: 'server_default',
      configuredDigest: D_A,
      configuredReference: `jellyfin/jellyfin:${TAG_A}`,
      lastSuccessfulDigest: D_A,
      lastSuccessAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

async function resourceId(): Promise<number> {
  const row = h.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
  return row!.id;
}

async function createJobFor(digest: string): Promise<number> {
  const id = await resourceId();
  const token = jobs.issuePreviewToken(id, digest);
  const job = jobs.createManualJob(id, digest, token);
  return job.id;
}

describe('application executor', () => {
  it('runs A→B: patch, readback, deploy, success evidence', async () => {
    const jobId = await createJobFor(D_B);
    const processed = await executor.processQueue();
    expect(processed).toBe(1);
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job).toMatchObject({ status: 'success', stage: 'done' });
    expect(job?.deploymentUuid).toBe('dep-1');
    expect(coolify.patchCalls).toBe(1);
    expect(coolify.appState.docker_image_tag).toBe(`sha256-${'b'.repeat(64)}`);
    const id = await resourceId();
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track).toMatchObject({
      configuredDigest: D_B,
      lastSuccessfulDigest: D_B,
      lastSuccessSource: 'deployment',
    });
    // Success notification emitted.
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'update_success'),
    ).toBe(true);
  });

  it('keeps target config B and evidence A when deployment fails; pauses auto', async () => {
    coolify.deploymentStatus = 'failed';
    const jobId = await createJobFor(D_B);
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job?.status).toBe('failed');
    expect(job?.errorCode).toBe('deployment_failed');
    const id = await resourceId();
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    // Target config stays B (written), evidence stays A.
    expect(track?.configuredDigest).toBe(D_B);
    expect(track?.lastSuccessfulDigest).toBe(D_A);
    const res = h.db.select().from(resources).where(eq(resources.id, id)).get();
    expect(res?.blockedReason).toBe('update_failed');
    // Failure notification emitted.
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'update_failed'),
    ).toBe(true);
  });

  it('flags conflict and blocks the resource when Coolify changed externally', async () => {
    coolify.appState.docker_image_tag = '10.9.2'; // user edited in Coolify
    const jobId = await createJobFor(D_B);
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job).toMatchObject({ status: 'conflict', errorCode: 'external_change' });
    const id = await resourceId();
    const res = h.db.select().from(resources).where(eq(resources.id, id)).get();
    expect(res?.blockedReason).toBe('external_change');
    // PATCH must not have been attempted.
    expect(coolify.patchCalls).toBe(0);
  });

  it('marks unknown submit on start timeout and blocks re-submission until reconcile', async () => {
    coolify.startBehavior = 'timeout';
    const jobId = await createJobFor(D_B);
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job).toMatchObject({ status: 'unknown_submit' });
    const id = await resourceId();
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.configuredDigest).toBe(D_B); // target written before submit
    // Re-submission of the same candidate is refused.
    const token = jobs.issuePreviewToken(id, D_B);
    expect(() => jobs.createManualJob(id, D_B, token)).toThrow(/unknown/i);
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'submit_unknown'),
    ).toBe(true);
  });

  it('retries the same target B after failure without duplicate deploys', async () => {
    coolify.deploymentStatus = 'failed';
    const jobId = await createJobFor(D_B);
    await executor.processQueue();
    coolify.deploymentStatus = 'finished';
    const before = coolify.startCalls;
    const retried = jobs.retryJob(jobId);
    expect(retried.status).toBe('pending');
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job).toMatchObject({ status: 'success', candidateDigest: D_B });
    expect(job?.attempts).toBe(2);
    expect(coolify.startCalls).toBe(before + 1);
    // No duplicate job rows for the same candidate.
    const id = await resourceId();
    const rows = h.db.select().from(updateJobs).where(eq(updateJobs.resourceId, id)).all();
    expect(rows).toHaveLength(1);
  });

  it('recovers a crashed job whose patch already landed', async () => {
    const jobId = await createJobFor(D_B);
    // Simulate crash after PATCH: mark running+patching, write the tag manually.
    h.db
      .update(updateJobs)
      .set({ status: 'running', stage: 'patching', attempts: 1 })
      .where(eq(updateJobs.id, jobId))
      .run();
    coolify.appState.docker_image_tag = `sha256-${'b'.repeat(64)}`;
    const r = await executor.reconcileOnBoot();
    expect(r.requeued).toBe(1);
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job).toMatchObject({ status: 'success' });
    // PATCH skipped (already candidate): still exactly one patch call overall (0 here).
    expect(coolify.patchCalls).toBe(0);
    expect(coolify.startCalls).toBe(1);
  });

  it('keeps awaiting_confirmation jobs untouched during reconcile', async () => {
    const jobId = await createJobFor(D_B);
    h.db
      .update(updateJobs)
      .set({ status: 'running', stage: 'awaiting_confirmation' })
      .where(eq(updateJobs.id, jobId))
      .run();
    const r = await executor.reconcileOnBoot();
    expect(r.requeued).toBe(0);
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job?.status).toBe('running');
    expect(job?.stage).toBe('awaiting_confirmation');
  });
});

// --- compose child -------------------------------------------------------------

class StubCompose extends StubCoolify {
  raw = 'services:\n  web:\n    image: nginx:1.27\n  db:\n    image: postgres:16\n';
  svcUuid = 'svc-1';
  childUuid = 'child-1';
  siblingUuid = 'child-2';
  children: CoolifyServiceApplication[] = [
    {
      uuid: 'child-1',
      name: 'web',
      human_name: 'Web',
      image: 'nginx:1.27',
      fqdn: 'https://x.example.com',
      status: 'running',
      url: null,
      description: null,
    },
    {
      uuid: 'child-2',
      name: 'db',
      human_name: 'Db',
      image: 'postgres:16',
      fqdn: null,
      status: 'running',
      url: null,
      description: null,
    },
  ];
  childPatchCalls = 0;
  childStartCalls = 0;
  /** Simulated latency for service reads (race tests). */
  readDelayMs = 0;
  /** When true, service reads fail with a network-level error. */
  failReads = false;

  constructor(suffix = '') {
    super();
    if (suffix !== '') {
      this.svcUuid += suffix;
      this.childUuid += suffix;
      this.siblingUuid += suffix;
      for (const c of this.children) c.uuid += suffix;
    }
  }

  override client(): CoolifyClient {
    const self = this;
    const base = super.client();
    return {
      ...base,
      async getService(uuid: string) {
        if (self.readDelayMs > 0) await sleep(self.readDelayMs);
        if (self.failReads || uuid !== self.svcUuid) throw new CoolifyApiError('missing', 404);
        return {
          uuid,
          docker_compose_raw: self.raw,
          name: 'stack',
          status: 'running',
        } as unknown as CoolifyService;
      },
      async listServiceApplications() {
        if (self.readDelayMs > 0) await sleep(self.readDelayMs);
        if (self.failReads) throw new CoolifyApiError('read failed', null);
        return self.children.map((c) => ({ ...c }));
      },
      async patchServiceApplication(
        _svc: string,
        childUuid: string,
        patch: Record<string, unknown>,
      ) {
        self.childPatchCalls += 1;
        const c = self.children.find((x) => x.uuid === childUuid);
        if (c == null) throw new CoolifyApiError('not found', 404);
        c.image = patch.image as string;
        // Mirror the real updateCompose(): raw gets rewritten with the new image
        // (sequential jobs replace the previous digest-pinned reference).
        self.raw = self.raw.replace(
          /nginx@(sha256:[a-f0-9]{64})|nginx:1\.27/,
          patch.image as string,
        );
        return {};
      },
      async startServiceApplication() {
        self.childStartCalls += 1;
        return undefined as never;
      },
    } as unknown as CoolifyClient;
  }
}

async function seedCompose(suffix = ''): Promise<number> {
  const now = Date.now();
  const svcUuid = `svc-1${suffix}`;
  const parent = h.db
    .insert(resources)
    .values({
      kind: 'compose_service',
      coolifyUuid: svcUuid,
      name: `stack${suffix}`,
      managementClassified: true,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  const child = h.db
    .insert(resources)
    .values({
      kind: 'service_application',
      coolifyUuid: `child-1${suffix}`,
      parentId: parent.id,
      name: 'web',
      composeServiceName: 'web',
      currentImage: 'nginx:1.27',
      configFingerprint: 'fp',
      policy: 'notify',
      managementClassified: true,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  // Seed the sibling row so drift checks can compare.
  h.db
    .insert(resources)
    .values({
      kind: 'service_application',
      coolifyUuid: `child-2${suffix}`,
      parentId: parent.id,
      name: 'db',
      composeServiceName: 'db',
      currentImage: 'postgres:16',
      configFingerprint: 'fp2',
      managementClassified: true,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  h.db
    .insert(imageTracks)
    .values({
      resourceId: child.id,
      sourceRegistry: 'docker.io',
      sourceRepository: 'library/nginx',
      sourceRepositoryAuthored: 'nginx',
      sourceTag: '1.27',
      targetPlatform: 'linux/amd64',
      platformSource: 'compose',
      configuredDigest: null,
      configuredReference: 'nginx:1.27',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return child.id;
}

describe('compose child executor', () => {
  function composeExecutor(stub: StubCompose): UpdateExecutor {
    return new UpdateExecutor(h.db, stub.client(), jobs, outbox, settings, cfg, {
      pollIntervalMs: 5,
      confirmWindowMs: 2_000,
      autoConfirmDelayMs: 60_000,
    });
  }

  it('patches only the target image, submits targeted deploy, lands in awaiting_confirmation', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const childId = await seedCompose();
    const token = jobs.issuePreviewToken(childId, D_B);
    const job = jobs.createManualJob(childId, D_B, token);
    await exec.processQueue();
    const after = h.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    expect(after).toMatchObject({ status: 'running', stage: 'awaiting_confirmation' });
    // The single delayed auto-check window is persisted (submit time + delay).
    expect(after?.confirmationDueAt).toBeGreaterThan(Date.now());
    expect(after?.confirmationDueAt).toBeLessThanOrEqual(Date.now() + 60_000);
    // Target image written as authored@digest; sibling untouched.
    expect(stub.children[0]?.image).toBe(`nginx@${D_B}`);
    expect(stub.children[1]?.image).toBe('postgres:16');
    expect(stub.raw).toContain(`nginx@${D_B}`);
    expect(stub.childStartCalls).toBe(1);
    // Resource paused pending confirmation.
    const childRow = h.db.select().from(resources).where(eq(resources.id, childId)).get();
    expect(childRow).toMatchObject({
      blockedReason: 'compose_confirmation_pending',
      currentImage: `nginx@${D_B}`,
    });
    // New submissions no longer raise the manual-confirmation warning.
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'submit_unknown'),
    ).toBe(false);

    // Manual confirmation records human evidence and unblocks.
    jobs.confirmSubmission(job.id, D_B);
    const confirmed = h.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    expect(confirmed).toMatchObject({ status: 'success', confirmedManually: true });
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, childId)).get();
    expect(track).toMatchObject({
      lastSuccessfulDigest: D_B,
      lastSuccessSource: 'manual',
      configuredDigest: D_B,
    });
    const childRow2 = h.db.select().from(resources).where(eq(resources.id, childId)).get();
    expect(childRow2?.blockedReason).toBeNull();
  });

  it('refuses the write when a sibling drifted externally', async () => {
    const stub = new StubCompose();
    stub.children[1]!.image = 'postgres:17'; // sibling edited in Coolify
    const exec = composeExecutor(stub);
    const childId = await seedCompose();
    const token = jobs.issuePreviewToken(childId, D_B);
    const job = jobs.createManualJob(childId, D_B, token);
    await exec.processQueue();
    const after = h.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    expect(after).toMatchObject({ status: 'conflict', errorCode: 'sibling_drift' });
    expect(stub.childPatchCalls).toBe(0);
  });

  it('blocks manual updates on ignored resources', async () => {
    const childId = await seedCompose();
    h.db.update(resources).set({ policy: 'ignore' }).where(eq(resources.id, childId)).run();
    const token = jobs.issuePreviewToken(childId, D_B);
    expect(() => jobs.createManualJob(childId, D_B, token)).toThrow(/ignored/i);
  });
});

describe('review round 1 regressions', () => {
  it('awaiting_confirmation job does not consume global concurrency (F3)', async () => {
    // Resource A stuck in awaiting_confirmation.
    const jobA = await createJobFor(D_B);
    h.db
      .update(updateJobs)
      .set({ status: 'running', stage: 'awaiting_confirmation' })
      .where(eq(updateJobs.id, jobA))
      .run();

    // Resource B: distinct app, pinned track at A, candidate job pending.
    const now = Date.now();
    const resB = h.db
      .insert(resources)
      .values({
        kind: 'application',
        coolifyUuid: 'app-2',
        name: 'navidrome',
        policy: 'notify',
        configFingerprint: 'fp',
        managementClassified: true,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    h.db
      .insert(imageTracks)
      .values({
        resourceId: resB.id,
        sourceRegistry: 'docker.io',
        sourceRepository: 'jellyfin/jellyfin',
        sourceRepositoryAuthored: 'jellyfin/jellyfin',
        sourceTag: 'latest',
        targetPlatform: 'linux/amd64',
        platformSource: 'server_default',
        configuredDigest: D_A,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const token = jobs.issuePreviewToken(resB.id, D_B);
    const jobB = jobs.createManualJob(resB.id, D_B, token);

    await executor.processQueue(); // concurrency 1, A holds an awaiting job only

    const after = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobB.id)).get();
    // B must have been claimed (left pending queue) despite A's awaiting job.
    expect(after?.status).not.toBe('pending');
  });

  it('reports deployment success even while the container is unhealthy', async () => {
    // 部署结果与容器健康是两个概念：unhealthy 是持续运行信号，不否决部署。
    coolify.deploymentStatus = 'finished';
    (coolify.appState as { status?: string }).status = 'restarting:unhealthy';
    const jobId = await createJobFor(D_B);
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    expect(job).toMatchObject({ status: 'success' });
    expect(JSON.stringify(job?.log)).toContain('unhealthy');
    const id = await resourceId();
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.configuredDigest).toBe(D_B);
    expect(track?.lastSuccessfulDigest).toBe(D_B);
  });
});

// --- 升级过渡：队列与证据安全（plan §5 T3） ---------------------------------

describe('queue safety across the upgrade transition', () => {
  interface PendingSeed {
    uuid: string;
    managementClassified?: boolean;
    excludedInfra?: boolean;
    imageIssue?: 'unsupported_registry' | null;
  }
  const seedApp = (o: PendingSeed): number => {
    const now = Date.now();
    return h.db
      .insert(resources)
      .values({
        kind: 'application',
        coolifyUuid: o.uuid,
        name: o.uuid,
        policy: 'notify',
        configFingerprint: 'fp',
        currentImage: `jellyfin/jellyfin:${TAG_A}`,
        managementClassified: o.managementClassified ?? true,
        excludedInfra: o.excludedInfra ?? false,
        imageIssue: o.imageIssue ?? null,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!.id;
  };
  const trackFor = (id: number): void => {
    const now = Date.now();
    h.db
      .insert(imageTracks)
      .values({
        resourceId: id,
        sourceRegistry: 'docker.io',
        sourceRepository: 'jellyfin/jellyfin',
        sourceRepositoryAuthored: 'jellyfin/jellyfin',
        sourceTag: 'latest',
        targetPlatform: 'linux/amd64',
        platformSource: 'server_default',
        configuredDigest: D_A,
        configuredReference: `jellyfin/jellyfin:${TAG_A}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  };
  const rawPendingJob = (resourceId: number, digest: string, key: string): number => {
    const now = Date.now();
    return h.db
      .insert(updateJobs)
      .values({
        resourceId,
        kind: 'update',
        trigger: 'auto',
        candidateDigest: digest,
        candidateReference: `jellyfin/jellyfin:sha256-${digest.slice(7, 19)}`,
        priorDigest: D_A,
        expectedFingerprint: 'fp',
        status: 'pending',
        stage: 'queued',
        attempts: 0,
        log: [],
        idempotencyKey: key,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!.id;
  };

  it('keeps pending-sync jobs pending and still claims later eligible jobs (no starvation)', async () => {
    // 前 3 条属于待同步确认资源；第 4 条属于已分类合格资源。
    const p1 = seedApp({ uuid: 'q-p1', managementClassified: false });
    const p2 = seedApp({ uuid: 'q-p2', managementClassified: false });
    const p3 = seedApp({ uuid: 'q-p3', managementClassified: false });
    trackFor(p1);
    trackFor(p2);
    trackFor(p3);
    const okId = seedApp({ uuid: 'q-ok' });
    trackFor(okId);
    for (const u of ['q-p1', 'q-p2', 'q-p3', 'q-ok']) {
      coolify.extraApps.set(u, {
        docker_image: 'jellyfin/jellyfin',
        docker_image_tag: TAG_A,
        status: 'running',
      });
    }
    const digestOf = (i: number) => `sha256:${String(i).padStart(64, '0')}`;
    const j1 = rawPendingJob(p1, digestOf(1), 'q:1');
    const j2 = rawPendingJob(p2, digestOf(2), 'q:2');
    const j3 = rawPendingJob(p3, digestOf(3), 'q:3');
    const jOk = rawPendingJob(okId, D_B, 'q:ok');

    const processed = await executor.processQueue();
    expect(processed).toBe(1);
    // 等待项保持 pending；合格任务被领取并完成。
    expect(h.db.select().from(updateJobs).where(eq(updateJobs.id, j1)).get()?.status).toBe(
      'pending',
    );
    expect(h.db.select().from(updateJobs).where(eq(updateJobs.id, j2)).get()?.status).toBe(
      'pending',
    );
    expect(h.db.select().from(updateJobs).where(eq(updateJobs.id, j3)).get()?.status).toBe(
      'pending',
    );
    expect(h.db.select().from(updateJobs).where(eq(updateJobs.id, jOk)).get()?.status).toBe(
      'success',
    );
    // 等待项的资源没有产生任何 Coolify 写入。
    expect(coolify.patchCalls).toBe(1); // 仅 q-ok 的一次 PATCH
    expect(coolify.startCalls).toBe(1);

    // 同步完成分类后：原等待项可重新判定并执行。
    for (const id of [p1, p2, p3]) {
      h.db.update(resources).set({ managementClassified: true }).where(eq(resources.id, id)).run();
    }
    await executor.processQueue();
    const after = h.db.select().from(updateJobs).all();
    expect(after.find((j) => j.id === j1)?.status).toBe('success');
    expect(after.find((j) => j.id === j2)?.status).toBe('success');
    expect(after.find((j) => j.id === j3)?.status).toBe('success');
  });

  it('marks queued jobs blocked when the classified resource is excluded or has an image issue', async () => {
    const exId = seedApp({ uuid: 'q-ex', excludedInfra: true });
    const isId = seedApp({ uuid: 'q-is', imageIssue: 'unsupported_registry' });
    trackFor(exId);
    trackFor(isId);
    const jEx = rawPendingJob(exId, D_B, 'q:ex');
    const jIs = rawPendingJob(isId, D_B, 'q:is');

    const processed = await executor.processQueue();
    expect(processed).toBe(0);
    const ex = h.db.select().from(updateJobs).where(eq(updateJobs.id, jEx)).get();
    expect(ex).toMatchObject({ status: 'blocked' });
    expect(ex?.errorMessage).toContain('已排除');
    const is = h.db.select().from(updateJobs).where(eq(updateJobs.id, jIs)).get();
    expect(is).toMatchObject({ status: 'blocked' });
    expect(is?.errorCode).toBe('image_issue');
    expect(coolify.patchCalls).toBe(0);
    expect(coolify.startCalls).toBe(0);
  });

  it('refuses new manual jobs and retries for ineligible resources (zero side effects)', async () => {
    const exId = seedApp({ uuid: 'q-guard', excludedInfra: true });
    trackFor(exId);
    const token = jobs.issuePreviewToken(exId, D_B);
    expect(() => jobs.createManualJob(exId, D_B, token)).toThrow(/已排除/);
    // 建一条终态任务再重试：资格不满足时原任务保持原值。
    const j = rawPendingJob(exId, D_B, 'q:guard');
    h.db
      .update(updateJobs)
      .set({ status: 'failed', errorCode: 'x', errorMessage: 'y', finishedAt: Date.now() })
      .where(eq(updateJobs.id, j))
      .run();
    expect(() => jobs.retryJob(j)).toThrow(/已排除/);
    expect(h.db.select().from(updateJobs).where(eq(updateJobs.id, j)).get()?.status).toBe('failed');
  });

  it('resumes already-submitted deployments query-only, even while unclassified', async () => {
    // 已提交部署（deploymentUuid 存在）：升级/重启后继续证据恢复，零 PATCH/start。
    const id = seedApp({ uuid: 'q-resume', managementClassified: false });
    trackFor(id);
    coolify.extraApps.set('q-resume', {
      docker_image: 'jellyfin/jellyfin',
      docker_image_tag: `sha256-${'b'.repeat(64)}`, // 提交时已写入
      status: 'running',
    });
    const now = Date.now();
    const j = h.db
      .insert(updateJobs)
      .values({
        resourceId: id,
        kind: 'update',
        trigger: 'auto',
        candidateDigest: D_B,
        candidateReference: `jellyfin/jellyfin:sha256-${'b'.repeat(64)}`,
        priorDigest: D_A,
        priorReference: `jellyfin/jellyfin:${TAG_A}`,
        status: 'pending',
        stage: 'deploy_submitted',
        deploymentUuid: 'dep-resume-1',
        attempts: 1,
        log: [],
        idempotencyKey: 'q:resume',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()!.id;

    const processed = await executor.processQueue();
    expect(processed).toBe(1);
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.id, j)).get();
    expect(job).toMatchObject({ status: 'success' });
    expect(coolify.patchCalls).toBe(0);
    expect(coolify.startCalls).toBe(0);
    // 证据推进：追踪成功摘要更新，分类字段保持原值。
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    expect(track?.lastSuccessfulDigest).toBe(D_B);
    const res = h.db.select().from(resources).where(eq(resources.id, id)).get();
    expect(res?.managementClassified).toBe(false);
  });
});

// --- delayed single auto-check ---------------------------------------------------

const D_C = `sha256:${'c'.repeat(64)}`; // next upstream candidate

/** Force the persisted waiting window due without sleeping in tests. */
function dueNow(jobId: number): void {
  h.db
    .update(updateJobs)
    .set({ confirmationDueAt: Date.now() - 1 })
    .where(eq(updateJobs.id, jobId))
    .run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobRow(jobId: number): UpdateJobRow {
  const row = h.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
  if (row == null) throw new Error(`job ${jobId} missing`);
  return row;
}

describe('compose delayed auto-check', () => {
  function composeExecutor(stub: StubCompose): UpdateExecutor {
    return new UpdateExecutor(h.db, stub.client(), jobs, outbox, settings, cfg, {
      pollIntervalMs: 5,
      confirmWindowMs: 2_000,
      autoConfirmDelayMs: 60_000,
    });
  }

  /** Submit a compose update and land it in awaiting_confirmation. */
  async function submitAwaiting(
    exec: UpdateExecutor,
    suffix = '',
  ): Promise<{ jobId: number; childId: number }> {
    const childId = await seedCompose(suffix);
    const token = jobs.issuePreviewToken(childId, D_B);
    const job = jobs.createManualJob(childId, D_B, token);
    await exec.processQueue();
    const row = jobRow(job.id);
    if (row.stage !== 'awaiting_confirmation') {
      throw new Error(`expected awaiting_confirmation, got ${row.status}/${row.stage}`);
    }
    return { jobId: job.id, childId };
  }

  it('auto-confirms one successful round after the due time and frees the parent', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId, childId } = await submitAwaiting(exec);
    stub.children[0]!.status = 'running:healthy';

    // Before due: the check never runs, even when invoked directly.
    await expect(exec.processDueConfirmations()).resolves.toBe(0);
    expect(jobRow(jobId).status).toBe('running');

    // Due: exactly one read round succeeds.
    dueNow(jobId);
    await expect(exec.processDueConfirmations()).resolves.toBe(1);

    const row = jobRow(jobId);
    expect(row).toMatchObject({
      status: 'success',
      stage: 'done',
      confirmedManually: false,
      confirmationDueAt: null,
      errorCode: null,
    });
    expect(JSON.stringify(row.log)).toContain('健康检查已通过');
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, childId)).get();
    expect(track).toMatchObject({
      lastSuccessfulDigest: D_B,
      lastSuccessSource: 'runtime_observation',
      configuredDigest: D_B,
    });
    const childRow = h.db.select().from(resources).where(eq(resources.id, childId)).get();
    expect(childRow).toMatchObject({ blockedReason: null, currentImage: `nginx@${D_B}` });
    // Exactly one deduped success notification; no manual-reminder noise.
    const success = h.db
      .select()
      .from(notificationOutbox)
      .all()
      .filter((n) => n.eventType === 'update_success');
    expect(success).toHaveLength(1);
    expect(success[0]?.body).toContain('运行观察自动确认');
    expect(success[0]?.dedupeKey).toBe(`update_success:${jobId}`);

    // Parent mutex released: a sibling job for the same parent can now run.
    const token2 = jobs.issuePreviewToken(childId, D_C);
    const job2 = jobs.createManualJob(childId, D_C, token2);
    await exec.processQueue();
    expect(jobRow(job2.id).status).toBe('running');
  });

  it('accepts running:unhealthy as running and logs the suffix', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId } = await submitAwaiting(exec);
    stub.children[0]!.status = 'running:unhealthy';
    dueNow(jobId);
    await exec.processDueConfirmations();
    const row = jobRow(jobId);
    expect(row.status).toBe('success');
    expect(JSON.stringify(row.log)).toContain('unhealthy');
  });

  it.each([
    ['exited', 'container_not_running'],
    ['starting', 'container_not_running'],
    ['', 'container_not_running'],
  ])('fails the check when container status is %s', async (status, code) => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId, childId } = await submitAwaiting(exec);
    stub.children[0]!.status = status;
    dueNow(jobId);
    await exec.processDueConfirmations();
    const row = jobRow(jobId);
    expect(row).toMatchObject({ status: 'failed', errorCode: code, confirmationDueAt: null });
    const childRow = h.db.select().from(resources).where(eq(resources.id, childId)).get();
    expect(childRow?.blockedReason).toBe('update_failed');
    // Evidence keeps the prior success; target config B stays written.
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, childId)).get();
    expect(track?.lastSuccessfulDigest).toBeNull();
    expect(track?.configuredDigest).toBe(D_B);
    // Terminal: re-running the due loop never reprocesses or re-notifies.
    await expect(exec.processDueConfirmations()).resolves.toBe(0);
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .filter((n) => n.eventType === 'update_failed'),
    ).toHaveLength(1);
  });

  it('flags conflict when the live child image drifted', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId, childId } = await submitAwaiting(exec);
    stub.children[0]!.image = 'nginx:9'; // user edited in Coolify after deploy
    dueNow(jobId);
    await exec.processDueConfirmations();
    expect(jobRow(jobId)).toMatchObject({ status: 'conflict', errorCode: 'external_change' });
    const childRow = h.db.select().from(resources).where(eq(resources.id, childId)).get();
    expect(childRow?.blockedReason).toBe('external_change');
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.title === '更新冲突'),
    ).toBe(true);
  });

  it.each([
    [
      'raw missing',
      (s: StubCompose) => {
        s.raw = '   ';
      },
      'compose_raw_missing',
      'failed',
    ],
    [
      'raw invalid',
      (s: StubCompose) => {
        s.raw = 'services: [oops';
      },
      'compose_raw_invalid',
      'failed',
    ],
    [
      'target node missing',
      (s: StubCompose) => {
        s.raw = 'services:\n  db:\n    image: postgres:16\n';
      },
      'compose_service_missing',
      'failed',
    ],
    [
      'candidate only in a comment',
      (s: StubCompose) => {
        s.raw = `services:\n  web:\n    # nginx@${D_B}\n    image: nginx@${D_B}#wrong\n`;
      },
      'external_change',
      'conflict',
    ],
  ])('fails with an explicit error when %s', async (_name, mutate, code, expectStatus) => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId } = await submitAwaiting(exec);
    mutate(stub);
    dueNow(jobId);
    await exec.processDueConfirmations();
    const row = jobRow(jobId);
    expect(row.errorCode).toBe(code);
    expect(row.confirmationDueAt).toBeNull();
    expect(row.status).toBe(expectStatus ?? 'failed');
  });

  it('fails explicitly when the read round errors or the child vanished', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId, childId } = await submitAwaiting(exec);
    stub.failReads = true;
    dueNow(jobId);
    await exec.processDueConfirmations();
    expect(jobRow(jobId)).toMatchObject({ status: 'failed', errorCode: 'coolify_unreachable' });
    expect(
      h.db.select().from(resources).where(eq(resources.id, childId)).get()?.blockedReason,
    ).toBe('update_failed');

    // Disappeared child: explicit error terminal, evidence preserved.
    const stub2 = new StubCompose('-2');
    const exec2 = composeExecutor(stub2);
    const second = await submitAwaiting(exec2, '-2');
    stub2.children = stub2.children.filter((c) => c.uuid !== 'child-1-2');
    dueNow(second.jobId);
    await exec2.processDueConfirmations();
    expect(jobRow(second.jobId)).toMatchObject({ status: 'failed', errorCode: 'child_missing' });
  });

  it('a manual confirmation that races the in-flight auto check wins', async () => {
    const stub = new StubCompose();
    stub.readDelayMs = 400; // auto check is mid-read while the user confirms
    const exec = composeExecutor(stub);
    const { jobId, childId } = await submitAwaiting(exec);
    dueNow(jobId);
    const inflight = exec.processDueConfirmations();
    await sleep(80); // let the auto check start its read round
    jobs.confirmSubmission(jobId, D_B);
    await inflight;
    const row = jobRow(jobId);
    expect(row).toMatchObject({ status: 'success', confirmedManually: true });
    const track = h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, childId)).get();
    expect(track?.lastSuccessSource).toBe('manual');
    // The losing auto check emitted no success notification.
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'update_success'),
    ).toBe(false);
  });

  it('a failing check that loses the race to a manual confirm writes nothing', async () => {
    const stub = new StubCompose();
    stub.readDelayMs = 400;
    const exec = composeExecutor(stub);
    const { jobId, childId } = await submitAwaiting(exec);
    dueNow(jobId);
    const inflight = exec.processDueConfirmations();
    await sleep(80); // confirm lands while the check is mid-read
    jobs.confirmSubmission(jobId, D_B);
    // The read result would fail the check (container exited)...
    stub.children[0]!.status = 'exited';
    await inflight;
    // ...but the guarded failure must not stomp the manual success.
    expect(jobRow(jobId)).toMatchObject({
      status: 'success',
      confirmedManually: true,
      confirmationDueAt: null,
    });
    expect(
      h.db.select().from(resources).where(eq(resources.id, childId)).get()?.blockedReason,
    ).toBeNull();
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'update_failed'),
    ).toBe(false);
  });

  it('backfills legacy awaiting rows on boot, pauses old reminders and rechecks read-only', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId } = await submitAwaiting(exec);
    // Simulate a pre-upgrade row: no due time, plus a pending manual reminder.
    h.db
      .update(updateJobs)
      .set({ confirmationDueAt: null, updatedAt: Date.now() - 30_000 })
      .where(eq(updateJobs.id, jobId))
      .run();
    outbox.enqueue({
      eventType: 'submit_unknown',
      resourceId: 1,
      dedupeKey: `compose_submitted:${jobId}`,
      payload: { title: 'Compose 更新已提交，待确认', body: 'legacy', type: 'warning' },
    });

    const r = await exec.reconcileOnBoot();
    expect(r.requeued).toBe(0);
    const row = jobRow(jobId);
    expect(row.confirmationDueAt).toBeGreaterThanOrEqual(Date.now() + 29_000);
    expect(row.status).toBe('running');
    const notes = h.db.select().from(notificationOutbox).all();
    expect(notes.find((n) => n.dedupeKey === `compose_submitted:${jobId}`)?.status).toBe('paused');

    // Recovery only reads: no extra deployment is submitted by the auto check.
    const startsBefore = stub.childStartCalls;
    dueNow(jobId);
    await exec.processDueConfirmations();
    expect(stub.childStartCalls).toBe(startsBefore);
    expect(jobRow(jobId).status).toBe('success');
  });

  it('legacy terminal rows with a stale awaiting stage no longer block manual jobs', async () => {
    const exec = composeExecutor(new StubCompose());
    const { jobId, childId } = await submitAwaiting(exec);
    // Simulate pre-upgrade residue: terminal status with a stale awaiting stage.
    h.db
      .update(updateJobs)
      .set({ status: 'failed', errorCode: 'x', errorMessage: 'x' })
      .where(eq(updateJobs.id, jobId))
      .run();

    // Same-digest resubmission falls through to the normal failed-job rules
    // instead of being blocked forever as "in flight".
    const token = jobs.issuePreviewToken(childId, D_B);
    expect(jobs.createManualJob(childId, D_B, token).status).toBe('pending');
    // The resource is now genuinely busy: a second manual job is refused.
    const token2 = jobs.issuePreviewToken(childId, D_C);
    expect(() => jobs.createManualJob(childId, D_C, token2)).toThrow(/in flight/i);
  });

  it('continues checking submitted jobs while global pause blocks new deployments', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const { jobId } = await submitAwaiting(exec);
    settings.patch({ globalPaused: true });
    dueNow(jobId);
    await exec.processDueConfirmations();
    expect(jobRow(jobId).status).toBe('success');
    // New work stays blocked.
    await expect(exec.processQueue()).resolves.toBe(0);
  });
});

// --- monitoring continuity ---------------------------------------------------------

describe('monitoring continuity after auto confirmation', () => {
  function composeExecutor(stub: StubCompose): UpdateExecutor {
    return new UpdateExecutor(h.db, stub.client(), jobs, outbox, settings, cfg, {
      pollIntervalMs: 5,
      confirmWindowMs: 2_000,
      autoConfirmDelayMs: 60_000,
    });
  }

  it('upstream matching after auto-confirm; a new upstream digest opens a new auto job', async () => {
    const exec = composeExecutor(new StubCompose());
    // policy auto so scheduled checks create jobs.
    const childId = await seedCompose();
    h.db.update(resources).set({ policy: 'auto' }).where(eq(resources.id, childId)).run();
    const token = jobs.issuePreviewToken(childId, D_B);
    const job = jobs.createManualJob(childId, D_B, token);
    await exec.processQueue();
    dueNow(job.id);
    await exec.processDueConfirmations();
    expect(jobRow(job.id).status).toBe('success');

    let resolved = D_B;
    const checker = new UpdateChecker(h.db, cfg, settings, outbox, jobs, () =>
      Promise.resolve({
        digest: resolved,
        referenceKind: 'index' as const,
        platformManifestDigest: resolved,
        observedAt: Date.now(),
        manifestContentType: 'application/vnd.oci.image.index.v1+json',
      }),
    );
    // Upstream still B: matching, no new job.
    const matching = await checker.checkResource(childId, 'scheduled');
    expect(matching.outcome).toBe('matching');
    expect(h.db.select().from(updateJobs).all()).toHaveLength(1);
    // Upstream moves to C: candidate + auto job created for the same resource.
    resolved = D_C;
    const candidate = await checker.checkResource(childId, 'scheduled');
    expect(candidate.outcome).toBe('candidate');
    const all = h.db.select().from(updateJobs).all();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      resourceId: childId,
      candidateDigest: D_C,
      status: 'pending',
      trigger: 'auto',
    });
  });
});
