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
import { imageTracks, notificationOutbox, resources, updateJobs } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import type { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import { CoolifyApiError } from '../src/server/integrations/coolify/client.js';
import { Outbox } from '../src/server/modules/notifications/outbox.js';
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
  patchCalls = 0;
  startCalls = 0;
  startBehavior: 'ok' | 'timeout' = 'ok';
  deploymentStatus = 'finished';
  failDeployment = false;

  client(): CoolifyClient {
    const self = this;
    return {
      async getApplication(uuid: string) {
        if (uuid !== 'app-1') throw new CoolifyApiError('missing', 404);
        return { ...self.appState } as unknown as CoolifyApplication;
      },
      async patchApplication(_uuid: string, patch: Record<string, unknown>) {
        self.patchCalls += 1;
        self.appState.docker_image_tag = patch.docker_image_tag as string;
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

  override client(): CoolifyClient {
    const self = this;
    const base = super.client();
    return {
      ...base,
      async getService(uuid: string) {
        if (uuid !== 'svc-1') throw new CoolifyApiError('missing', 404);
        return {
          uuid,
          docker_compose_raw: self.raw,
          name: 'stack',
          status: 'running',
        } as unknown as CoolifyService;
      },
      async listServiceApplications() {
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
        // Mirror the real updateCompose(): raw gets rewritten with the new image.
        self.raw = self.raw.replace('nginx:1.27', patch.image as string);
        return {};
      },
      async startServiceApplication() {
        self.childStartCalls += 1;
        return undefined as never;
      },
    } as unknown as CoolifyClient;
  }
}

describe('compose child executor', () => {
  function composeExecutor(stub: StubCompose): UpdateExecutor {
    return new UpdateExecutor(h.db, stub.client(), jobs, outbox, settings, cfg, {
      pollIntervalMs: 5,
      confirmWindowMs: 2_000,
    });
  }

  async function seedCompose(): Promise<number> {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-1',
        name: 'stack',
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
        coolifyUuid: 'child-1',
        parentId: parent.id,
        name: 'web',
        composeServiceName: 'web',
        currentImage: 'nginx:1.27',
        configFingerprint: 'fp',
        policy: 'notify',
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
        coolifyUuid: 'child-2',
        parentId: parent.id,
        name: 'db',
        composeServiceName: 'db',
        currentImage: 'postgres:16',
        configFingerprint: 'fp2',
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

  it('patches only the target image, submits targeted deploy, lands in awaiting_confirmation', async () => {
    const stub = new StubCompose();
    const exec = composeExecutor(stub);
    const childId = await seedCompose();
    const token = jobs.issuePreviewToken(childId, D_B);
    const job = jobs.createManualJob(childId, D_B, token);
    await exec.processQueue();
    const after = h.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    expect(after).toMatchObject({ status: 'running', stage: 'awaiting_confirmation' });
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
    // Submit-unknown style notification raised.
    expect(
      h.db
        .select()
        .from(notificationOutbox)
        .all()
        .some((n) => n.eventType === 'submit_unknown'),
    ).toBe(true);

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
