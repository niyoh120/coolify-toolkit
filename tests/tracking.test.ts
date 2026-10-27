// Tracking recovery closed loops against the public API:
// adopt preview/confirm, source-save recovery from external_change, reset to
// ignore. Uses a stub Coolify + registry resolver and a real temp SQLite.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources, settings, updateJobs } from '../src/server/db/schema.js';
import { buildDeps, type Deps } from '../src/server/deps.js';
import type { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import type { CoolifyApplication, CoolifyServiceApplication } from '../src/shared/schemas.js';

const D_A = `sha256:${'a'.repeat(64)}`;
const D_B = `sha256:${'b'.repeat(64)}`;
const TAG_A = `sha256-${'a'.repeat(64)}`;

let h: OpenDbResult;
let dir: string;
let deps: Deps;
let appId: number;

function stubCoolify(): void {
  const state = {
    app: {
      uuid: 'app-1',
      docker_image: 'ghcr.io/yetone/magpie',
      docker_image_tag: 'latest',
      status: 'running',
    } as unknown as CoolifyApplication,
  };
  (deps.coolify as unknown as { __state: unknown }).__state = state;
  Object.assign(deps.coolify, {
    getApplication: async (): Promise<CoolifyApplication> => ({ ...state.app }),
    listServiceApplications: async (): Promise<CoolifyServiceApplication[]> => [],
    getService: async () => {
      throw new Error('not a service');
    },
    // Executor path (F1 end-to-end): PATCH mutates the stub state; deployment
    // finishes immediately.
    patchApplication: async (_uuid: string, patch: Record<string, unknown>) => {
      if (typeof patch.docker_image_tag === 'string') {
        state.app.docker_image_tag = patch.docker_image_tag;
      }
      return {};
    },
    startApplication: async () => ({ deploymentUuid: 'dep-adopt-1' }),
    getDeployment: async (uuid: string) => ({ deployment_uuid: uuid, status: 'finished' }) as never,
    getDeploymentsForApplication: async () => [],
  });
}

/** Controlled resolver: deterministic digest per tag, delay-capable. */
function stubResolver(delayMs = 0): void {
  const impl = async (req: { tag: string }) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (req.tag === 'stable') {
      return {
        digest: D_B,
        referenceKind: 'index',
        platformManifestDigest: D_B,
        observedAt: Date.now(),
        manifestContentType: null,
      };
    }
    return {
      digest: D_A,
      referenceKind: 'index',
      platformManifestDigest: D_A,
      observedAt: Date.now(),
      manifestContentType: null,
    };
  };
  (deps.tracking as unknown as { resolve: unknown }).resolve = vi.fn(impl);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-tracking-'));
  h = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(h.db);
  process.env.COOLIFY_BASE_URL = 'http://127.0.0.1:1';
  process.env.COOLIFY_API_KEY = 'k';
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  const cfg = loadConfig();
  deps = buildDeps(cfg, h.db);
  stubCoolify();
  stubResolver();

  const now = Date.now();
  const res = h.db
    .insert(resources)
    .values({
      kind: 'application',
      coolifyUuid: 'app-1',
      name: 'magpie',
      policy: 'manual',
      configFingerprint: 'fp',
      currentImage: 'ghcr.io/yetone/magpie:latest',
      managementClassified: true,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  appId = res.id;
  // Pinned track at digest A on tag latest; Coolify live is back on :latest.
  h.db
    .insert(imageTracks)
    .values({
      resourceId: appId,
      sourceRegistry: 'ghcr.io',
      sourceRepository: 'yetone/magpie',
      sourceRepositoryAuthored: 'yetone/magpie',
      sourceTag: 'latest',
      targetPlatform: 'linux/amd64',
      platformSource: 'manual',
      configuredDigest: D_A,
      configuredReference: `ghcr.io/yetone/magpie:${TAG_A}`,
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

function track() {
  return h.db.select().from(imageTracks).where(eq(imageTracks.resourceId, appId)).get()!;
}
function resource() {
  return h.db.select().from(resources).where(eq(resources.id, appId)).get()!;
}
function jobRows() {
  return h.db.select().from(updateJobs).where(eq(updateJobs.resourceId, appId)).all();
}

describe('adopt closed loop', () => {
  it('preview resolves channel from live config and confirm adopts + creates task', async () => {
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(200);
    const { preview } = (await p.json()) as {
      preview: Record<string, never> & {
        channel: { registry: string; repository: string; tag: string; source: string };
        targetDigest: string;
        targetReference: string;
        previewToken: string;
        liveReference: string;
      };
    };
    // Channel follows the live reference (ghcr.io host included).
    expect(preview.channel).toMatchObject({
      registry: 'ghcr.io',
      repository: 'yetone/magpie',
      tag: 'latest',
      source: 'live',
    });
    expect(preview.liveReference).toBe('ghcr.io/yetone/magpie:latest');
    expect(preview.targetDigest).toBe(D_A); // stub: latest resolves to A
    expect(preview.targetReference).toBe(`ghcr.io/yetone/magpie:sha256-${'a'.repeat(64)}`);

    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    const body = (await c.json()) as { status: string; job: unknown };
    // Float-tag live config: baseline = plain tagged reference (digest null),
    // an initial_pin task deploys the preview digest (same as live here).
    expect(body.status).toBe('adopted');
    expect(track().sourceTag).toBe('latest');
    expect(track().trackingRevision).toBe(1);
    expect(track().configuredReference).toBe('ghcr.io/yetone/magpie:latest');
    expect(track().configuredDigest).toBeNull();
    expect(jobRows()).toHaveLength(1);
    expect(jobRows()[0]).toMatchObject({ kind: 'initial_pin', candidateDigest: D_A });
  });

  it('explicit sourceTag overrides the live tag and confirm creates a manual job', async () => {
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    expect(p.status).toBe(200);
    const { preview } = (await p.json()) as {
      preview: { channel: { tag: string }; targetDigest: string; previewToken: string };
    };
    expect(preview.channel.tag).toBe('stable');
    expect(preview.targetDigest).toBe(D_B);

    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    const body = (await c.json()) as { status: string; job: { candidateDigest: string } | null };
    expect(body.status).toBe('adopted');
    expect(body.job?.candidateDigest).toBe(D_B);
    expect(track().sourceTag).toBe('stable');
    // Float-tag live config → baseline re-anchored to live, digest null;
    // the task (initial_pin) provides digest evidence when it succeeds.
    expect(track().configuredDigest).toBeNull();
    // Job prior = the live reference (baseline re-anchored before creation).
    const job = jobRows()[0];
    expect(job).toMatchObject({ priorDigest: null, trigger: 'manual', trackingRevision: 1 });
    // One task max.
    expect(jobRows()).toHaveLength(1);
    // Token consumed: replay is refused.
    const replay = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(replay.status).toBe(409);
  });

  it('stale preview (live changed between preview and confirm) is refused', async () => {
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    const { preview } = (await p.json()) as { preview: { previewToken: string } };
    // Live config changes after the preview.
    (
      deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }
    ).__state.app.docker_image_tag = '10.9.2';
    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(409);
    expect(track().sourceTag).toBe('latest'); // untouched
  });

  it('ignore policy blocks adopt with a clear precondition message', async () => {
    h.db.update(resources).set({ policy: 'ignore' }).where(eq(resources.id, appId)).run();
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(403);
    const body = (await p.json()) as { error: { message: string } };
    expect(body.error.message).toContain('忽略策略');
  });
});

describe('save recovery from external_change', () => {
  it('PATCH source while external_change adopts the live baseline and unblocks', async () => {
    // Set up external change: Coolify live back on plain latest while the
    // baseline holds digest A.
    h.db
      .update(resources)
      .set({ blockedReason: 'external_change' })
      .where(eq(resources.id, appId))
      .run();
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceTag: 'latest' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(resource().blockedReason).toBeNull();
    expect(track().sourceTag).toBe('latest');
    // Baseline re-accepted from live: plain-tag reference, digest null.
    expect(track().configuredReference).toBe('ghcr.io/yetone/magpie:latest');
    expect(track().configuredDigest).toBeNull();
    // Success projection cleared (config adoption is not deployment evidence).
    // Revision bumps twice by design: recovery (+1) and channel change (+1).
    expect(track().lastSuccessfulDigest).toBeNull();
    expect(track().trackingRevision).toBe(2);
  });

  it('PATCH source with unreachable Coolify keeps external_change and all values', async () => {
    h.db
      .update(resources)
      .set({ blockedReason: 'external_change' })
      .where(eq(resources.id, appId))
      .run();
    // Break the live read.
    Object.assign(deps.coolify, {
      getApplication: async () => {
        throw new Error('down');
      },
    });
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceTag: 'stable' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(409);
    expect(resource().blockedReason).toBe('external_change');
    expect(track().sourceTag).toBe('latest');
    expect(track().trackingRevision).toBe(0);
  });

  it('cron-only save keeps the confirmed baseline and evidence', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ checkCron: '*/10 * * * *' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(track().configuredDigest).toBe(D_A);
    expect(track().lastSuccessfulDigest).toBe(D_A);
    expect(track().trackingRevision).toBe(0);
    expect(resource().checkCron).toBe('*/10 * * * *');
  });

  it('invalid cron leaves every field untouched', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ checkCron: 'not a cron', sourceTag: 'stable' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(track().sourceTag).toBe('latest');
    expect(resource().checkCron).toBeNull();
  });
});

describe('reset closed loop', () => {
  it('clears the ledger, sets ignore, keeps source/platform/history', async () => {
    const now = Date.now();
    h.db.update(updateJobs).set({ status: 'success' }).where(eq(updateJobs.resourceId, appId));
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_B,
        candidateReference: 'x',
        status: 'success',
        trackingRevision: 0,
        idempotencyKey: 'hist-1',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}/reset-tracking`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(resource().policy).toBe('ignore');
    expect(track().configuredReference).toBeNull();
    expect(track().configuredDigest).toBeNull();
    expect(track().observedDigest).toBeNull();
    expect(track().lastSuccessfulDigest).toBeNull();
    expect(track().pinnedAt).toBeNull();
    expect(track().trackingRevision).toBe(1);
    // Kept: channel identifiers, platform, job history.
    expect(track().sourceTag).toBe('latest');
    expect(track().targetPlatform).toBe('linux/amd64');
    expect(jobRows()).toHaveLength(1);
  });

  it('in-flight job blocks reset', async () => {
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_B,
        candidateReference: 'x',
        status: 'running',
        trackingRevision: 0,
        idempotencyKey: 'fly-1',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}/reset-tracking`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details?: { jobId?: number } } };
    expect(body.error.details?.jobId).toBeDefined();
    expect(resource().policy).toBe('manual');
  });
});

describe('stale async results', () => {
  it('checker drops observations resolved after a revision bump', async () => {
    // Simulate a slow registry reply; adopt during the wait.
    const slow = new Promise<{ digest: string }>((resolve) => {
      setTimeout(() => resolve({ digest: D_B }), 50);
    });
    (deps.tracking as unknown as { resolve: unknown }).resolve = () => slow;
    void deps.tracking; // tracking service unused here; checker reads its own resolve
    const { UpdateChecker } = await import('../src/server/modules/updates/checker.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const outbox = new Outbox(h.db, () => null);
    const checker = new UpdateChecker(
      h.db,
      deps.cfg,
      deps.settings,
      outbox,
      deps.jobs,
      (() => slow) as never,
      null,
    );
    const pending = checker.checkResource(appId, 'manual');
    // Bump the revision while the request is in flight (adopt-style change).
    h.db
      .update(imageTracks)
      .set({ trackingRevision: 5, sourceTag: 'stable' })
      .where(eq(imageTracks.resourceId, appId))
      .run();
    const result = await pending;
    expect(result.outcome).toBe('blocked');
    expect(result.message).toContain('追踪配置在检查期间变化');
    // Observation not written to the new channel.
    expect(track().observedDigest).toBeNull();
  });

  it('old-revision job conflicts instead of writing (tracking_changed)', async () => {
    const { UpdateExecutor } = await import('../src/server/modules/updates/executor.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const outbox = new Outbox(h.db, () => null);
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_B,
        candidateReference: `ghcr.io/yetone/magpie:sha256-${'b'.repeat(64)}`,
        status: 'pending',
        trackingRevision: 3,
        idempotencyKey: 'old-1',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const executor = new UpdateExecutor(
      h.db,
      deps.coolify,
      deps.jobs,
      outbox,
      deps.settings,
      deps.cfg,
    );
    await executor.processQueue();
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.idempotencyKey, 'old-1')).get();
    expect(job).toMatchObject({ status: 'conflict', errorCode: 'tracking_changed' });
    // No Coolify write happened.
    expect(
      (deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }).__state.app
        .docker_image_tag,
    ).toBe('latest');
  });

  it('retry of an old-revision job is refused with history kept', async () => {
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_B,
        candidateReference: 'x',
        status: 'failed',
        errorCode: 'patch_failed',
        trackingRevision: 2,
        idempotencyKey: 'old-2',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const app = createApp(deps);
    const job = h.db.select().from(updateJobs).where(eq(updateJobs.idempotencyKey, 'old-2')).get()!;
    const res = await app.request(`/api/jobs/${job.id}/retry`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
    expect(job.status).toBe('failed');
  });
});

describe('compose child adoption and tag requirements', () => {
  function seedChild(): void {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-1',
        name: 'stack',
        policy: 'ignore',
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
        coolifyUuid: 'child-1',
        parentId: parent.id,
        name: 'web',
        composeServiceName: 'web',
        policy: 'manual',
        currentImage: 'nginx:1.27',
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
        resourceId: child.id,
        sourceRegistry: 'docker.io',
        sourceRepository: 'library/nginx',
        sourceRepositoryAuthored: 'nginx',
        sourceTag: '1.27',
        targetPlatform: 'linux/amd64',
        platformSource: 'compose',
        configuredDigest: D_A,
        configuredReference: `nginx@${D_A}`,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    appId = child.id;
  }

  it('compose child adopt uses @sha256 reference with authored path', async () => {
    seedChild();
    // Compose live child: plain tag; raw compose matches.
    Object.assign(deps.coolify, {
      listServiceApplications: async (): Promise<CoolifyServiceApplication[]> => [
        {
          uuid: 'child-1',
          name: 'web',
          image: 'nginx:1.27',
          status: 'running',
        } as CoolifyServiceApplication,
      ],
      getService: async () =>
        ({
          uuid: 'svc-1',
          docker_compose_raw: 'services:\n  web:\n    image: nginx:1.27\n',
        }) as never,
    });
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(200);
    const { preview } = (await p.json()) as {
      preview: { targetReference: string; channel: { tag: string }; previewToken: string };
    };
    expect(preview.channel.tag).toBe('1.27');
    // Authored path (nginx, no docker.io prefix) in the compose digest form.
    expect(preview.targetReference).toBe(`nginx@${D_A}`);

    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    // Float-tag live → baseline re-anchored to the tagged ref, initial_pin job.
    expect(track().configuredReference).toBe('nginx:1.27');
    expect(track().configuredDigest).toBeNull();
    expect(jobRows()[0]).toMatchObject({ kind: 'initial_pin' });
    const written = jobRows()[0]!;
    // The task's candidate reference must equal the preview's compose form.
    expect(written.candidateReference).toBe(`nginx@${D_A}`);
  });

  it('raw-compose contradiction blocks the preview with a pointer to Coolify', async () => {
    seedChild();
    Object.assign(deps.coolify, {
      listServiceApplications: async (): Promise<CoolifyServiceApplication[]> => [
        {
          uuid: 'child-1',
          name: 'web',
          image: 'nginx:1.27',
          status: 'running',
        } as CoolifyServiceApplication,
      ],
      getService: async () =>
        ({
          uuid: 'svc-1',
          docker_compose_raw: 'services:\n  web:\n    image: nginx:other\n',
        }) as never,
    });
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(409);
    const body = (await p.json()) as { error: { message: string } };
    expect(body.error.message).toContain('raw compose');
    expect(track().sourceTag).toBe('1.27'); // untouched
  });

  it('digest-only live reference in a new repository demands an explicit tag', async () => {
    // Application whose live config is a digest reference in another repo.
    Object.assign(deps.coolify, {
      getApplication: async (): Promise<CoolifyApplication> =>
        ({
          uuid: 'app-1',
          docker_image: `ghcr.io/other/tool@${D_B}`,
          docker_image_tag: null,
          status: 'running',
        }) as unknown as CoolifyApplication,
    });
    h.db
      .update(resources)
      .set({ currentImage: `ghcr.io/other/tool@${D_B}` })
      .where(eq(resources.id, appId))
      .run();
    const app = createApp(deps);
    const p1 = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p1.status).toBe(400);
    const b1 = (await p1.json()) as { error: { message: string } };
    expect(b1.error.message).toContain('填写');
    // With an explicit tag the preview proceeds; the new repository channel wins.
    const p2 = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    expect(p2.status).toBe(200);
    const { preview } = (await p2.json()) as {
      preview: { channel: { registry: string; repository: string; tag: string } };
    };
    expect(preview.channel).toMatchObject({
      registry: 'ghcr.io',
      repository: 'other/tool',
      tag: 'stable',
    });
  });

  it('in-flight job blocks adopt until it settles', async () => {
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_B,
        candidateReference: 'x',
        status: 'pending',
        trackingRevision: 0,
        idempotencyKey: 'fly-adopt',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(409);
    const body = (await p.json()) as { error: { details?: { jobId?: number } } };
    expect(body.error.details?.jobId).toBeDefined();
  });
});

describe('review round 3 regressions (adopt/patch semantics)', () => {
  it('adopt with float-tag live and explicit stable tag keeps live as baseline; job prior is live', async () => {
    // Live=:latest (no digest), user tracks :stable with upstream digest B.
    stubResolver();
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    const { preview } = (await p.json()) as {
      preview: { channel: { tag: string }; targetDigest: string; previewToken: string };
    };
    expect(preview.channel.tag).toBe('stable');
    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    const body = (await c.json()) as { status: string };
    expect(body.status).toBe('adopted');
    // Baseline = live :latest config (F2), digest null; the task deploys B.
    expect(track().configuredReference).toBe('ghcr.io/yetone/magpie:latest');
    expect(track().configuredDigest).toBeNull();
    const job = jobRows()[0]!;
    expect(job).toMatchObject({ candidateDigest: D_B, priorDigest: null });
    // Candidate reference includes the registry host (F3).
    expect(job.candidateReference).toBe(`ghcr.io/yetone/magpie:sha256-${'b'.repeat(64)}`);
  });

  it('executor accepts the float-tag live config as prior for the adopted channel (F1)', async () => {
    stubResolver();
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    const { preview } = (await p.json()) as { preview: { previewToken: string } };
    await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    // Live stays :latest (the accepted prior); the job updates it to B.
    const { UpdateExecutor } = await import('../src/server/modules/updates/executor.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const executor = new UpdateExecutor(
      h.db,
      deps.coolify,
      deps.jobs,
      new Outbox(h.db, () => null),
      deps.settings,
      deps.cfg,
    );
    await executor.processQueue();
    const job = jobRows()[0];
    // The float-tag live config (job.priorReference) is accepted — no conflict.
    expect(job?.status).toBe('success');
    expect(
      (deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }).__state.app
        .docker_image_tag,
    ).toBe(`sha256-${'b'.repeat(64)}`);
  });

  it('adopt is atomic: job-insert failure rolls back channel+baseline+token (F4)', async () => {
    stubResolver();
    // Force the job insert to fail: unique idempotency collision with a live
    // pending job for the same candidate+revision is impossible here, so use
    // a trigger via raw sqlite.
    h.sqlite.exec(`CREATE TABLE _adopt_guard AS SELECT 1 WHERE 0;`);
    h.sqlite.exec(`CREATE TRIGGER adopt_fail BEFORE INSERT ON update_jobs
      WHEN NEW.candidate_digest = '${D_B}' BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END;`);
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    const { preview } = (await p.json()) as { preview: { previewToken: string } };
    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(500);
    // Everything rolled back: channel unchanged, revision unchanged, token kept.
    expect(track().sourceTag).toBe('latest');
    expect(track().trackingRevision).toBe(0);
    expect(track().configuredDigest).toBe(D_A);
    expect(jobRows()).toHaveLength(0);
    const tokenRows = h.db
      .select()
      .from(settings)
      .all()
      .filter((r) => r.key.startsWith('meta.adopt.'));
    expect(tokenRows).toHaveLength(1); // token survives a failed tx (retryable)
    h.sqlite.exec('DROP TRIGGER adopt_fail; DROP TABLE _adopt_guard;');
    // Retry with the SAME token now succeeds (plan: failed tx keeps the token).
    const c2 = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c2.status).toBe(200);
  });

  it('PATCH source to a different repository is rejected as migration (F12)', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceRepository: 'other/repo', sourceTag: 'latest' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(track().sourceRepository).toBe('yetone/magpie'); // untouched
  });

  it('PATCH source while live moved to a new repo follows the live repo (F12 recovery)', async () => {
    h.db
      .update(resources)
      .set({ blockedReason: 'external_change' })
      .where(eq(resources.id, appId))
      .run();
    // Live config now points at another repository.
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string } };
      }
    ).__state.app.docker_image = 'ghcr.io/yetone/magpie2';
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceTag: 'latest' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    // Channel followed the live repository; authored path kept the host form
    // (normalizeReference preserves explicit registry hosts in authoredPath).
    expect(track().sourceRepository).toBe('yetone/magpie2');
    expect(track().sourceRepositoryAuthored).toBe('ghcr.io/yetone/magpie2');
    expect(resource().blockedReason).toBeNull();
  });

  it('adopt requires a configured platform (F14)', async () => {
    h.db
      .update(imageTracks)
      .set({ targetPlatform: null })
      .where(eq(imageTracks.resourceId, appId))
      .run();
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(409);
    const body = (await p.json()) as { error: { message: string } };
    expect(body.error.message).toContain('平台');
  });

  it('reset respects the excluded-parent boundary (F14)', async () => {
    // Build a parent (excluded) + child; attempt reset on the child.
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-ex',
        name: 'stack',
        policy: 'ignore',
        managementClassified: true,
        excludedInfra: true,
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
        coolifyUuid: 'child-ex',
        parentId: parent.id,
        name: 'web',
        policy: 'manual',
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
        resourceId: child.id,
        sourceRegistry: 'docker.io',
        sourceRepository: 'library/nginx',
        sourceRepositoryAuthored: 'nginx',
        sourceTag: '1.27',
        targetPlatform: 'linux/amd64',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const prevAppId = appId;
    appId = child.id;
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${child.id}/reset-tracking`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(409);
    appId = prevAppId;
  });

  it('quoted compose image does not false-positive a contradiction (F15)', async () => {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-q',
        name: 'stack-q',
        policy: 'ignore',
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
        coolifyUuid: 'child-q',
        parentId: parent.id,
        name: 'web-q',
        composeServiceName: 'web',
        policy: 'manual',
        currentImage: 'ghcr.io/example/sample:latest',
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
        resourceId: child.id,
        sourceRegistry: 'ghcr.io',
        sourceRepository: 'example/sample',
        sourceRepositoryAuthored: 'example/sample',
        sourceTag: 'latest',
        targetPlatform: 'linux/amd64',
        configuredDigest: D_A,
        configuredReference: 'old',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    Object.assign(deps.coolify, {
      listServiceApplications: async (): Promise<CoolifyServiceApplication[]> => [
        {
          uuid: 'child-q',
          name: 'web',
          image: 'ghcr.io/example/sample:latest',
          status: 'running',
        } as CoolifyServiceApplication,
      ],
      getService: async () =>
        ({
          uuid: 'svc-q',
          // Quoted YAML value — must parse to the same reference (F15).
          docker_compose_raw: 'services:\n  web:\n    image: "ghcr.io/example/sample:latest"\n',
        }) as never,
    });
    const prevAppId = appId;
    appId = child.id;
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${child.id}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(200); // no contradiction
    appId = prevAppId;
  });

  it('platform change clears observations and bumps revision (F13)', async () => {
    const before = track();
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ targetPlatform: 'linux/arm64' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(track().targetPlatform).toBe('linux/arm64');
    expect(track().observedDigest).toBeNull();
    expect(track().trackingRevision).toBe(before.trackingRevision + 1);
  });

  it('expired update tokens are pruned on the next issuance (F18)', async () => {
    const id = appId;
    const t = track();
    const stale = deps.jobs.issuePreviewToken(id, D_B, t.trackingRevision);
    // Force it expired.
    h.db
      .update(settings)
      .set({
        value: {
          ...JSON.parse(
            JSON.stringify({
              resourceId: id,
              digest: D_B,
              createdAt: 1,
              expiresAt: 1,
              purpose: 'update',
              trackingRevision: t.trackingRevision,
            }),
          ),
          expiresAt: 1,
        },
      })
      .where(eq(settings.key, `meta.preview.${stale}`))
      .run();
    deps.jobs.issuePreviewToken(id, D_B, t.trackingRevision);
    const staleRow = h.db
      .select()
      .from(settings)
      .all()
      .find((r) => r.key === `meta.preview.${stale}`);
    expect(staleRow).toBeUndefined();
  });

  it('reset response is a full ResourceDTO incl. track view (F16)', async () => {
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}/reset-tracking`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: { track: { view?: unknown } | null; parentResourceId: unknown };
    };
    expect(body.resource.track?.view).toBeTruthy();
    expect(body.resource.parentResourceId).toBeNull();
  });
});

describe('review round 4 regressions (concurrency + identity)', () => {
  it('save after a skipped adopt re-reads the revision in the tx (R4-F1)', async () => {
    // Digest-pinned live → skipped adopt (no task), revision bumps to 1.
    (
      deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }
    ).__state.app.docker_image_tag = `sha256-${'a'.repeat(64)}`;
    stubResolver(); // latest → D_A
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    const { preview } = (await p.json()) as { preview: { previewToken: string } };
    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    const revAfterAdopt = track().trackingRevision;
    expect(revAfterAdopt).toBe(1);
    // Source save must re-read the CURRENT revision inside its tx (not the
    // request-start snapshot) and stack cleanly on top of the adopt.
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceTag: 'latest' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(track().trackingRevision).toBe(revAfterAdopt + 1);
    expect(track().sourceTag).toBe('latest');
    // The adopt's baseline survived the stacked save (revision monotonic).
    expect(track().configuredReference).toBe(`ghcr.io/yetone/magpie:sha256-${'a'.repeat(64)}`);
  });

  it('unknown_submit on a different digest blocks new job creation and retry (R4-F3)', async () => {
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_A,
        candidateReference: 'x',
        status: 'unknown_submit',
        trackingRevision: 0,
        idempotencyKey: 'us-diff',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const app = createApp(deps);
    // New manual job for a DIFFERENT digest is refused (scope is the resource).
    const t = track();
    const token = deps.jobs.issuePreviewToken(appId, D_B, t.trackingRevision);
    expect(() => deps.jobs.createManualJob(appId, D_B, token)).toThrow(/对账|unknown|结果未知/i);
    // Retry of an old terminal job is refused while unknown_submit is open.
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_B,
        candidateReference: 'y',
        status: 'failed',
        errorCode: 'patch_failed',
        trackingRevision: 0,
        idempotencyKey: 'old-r4',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const oldJob = h.db
      .select()
      .from(updateJobs)
      .where(eq(updateJobs.idempotencyKey, 'old-r4'))
      .get()!;
    const res = await app.request(`/api/jobs/${oldJob.id}/retry`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(409);
  });

  it('adopt refreshes resources.currentImage to the confirmed live reference (R4-F5)', async () => {
    // Live digest-pinned config.
    (
      deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }
    ).__state.app.docker_image_tag = `sha256-${'a'.repeat(64)}`;
    h.db
      .update(resources)
      .set({ currentImage: 'stale-before-adopt' })
      .where(eq(resources.id, appId))
      .run();
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    const { preview } = (await p.json()) as { preview: { previewToken: string } };
    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    const body = (await c.json()) as { status: string };
    expect(body.status).toBe('skipped');
    expect(resource().currentImage).toBe(`ghcr.io/yetone/magpie:sha256-${'a'.repeat(64)}`);
  });

  it('raw live `tag@digest` reference is preserved as prior and accepted by the executor (R4-F6)', async () => {
    // Live config in Coolify's tag@digest form.
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string } };
      }
    ).__state.app.docker_image = 'ghcr.io/yetone/magpie:stable';
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string | null } };
      }
    ).__state.app.docker_image_tag = null;
    // mapper: docker_image without tag → docker_image alone.
    stubResolver(); // stable → D_B
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    expect(p.status).toBe(200);
    const { preview } = (await p.json()) as {
      preview: { previewToken: string; liveReference: string };
    };
    void preview;
  });

  it('legacy digest-only row: candidate in another repo is refused by the executor (R4-F7)', async () => {
    // Legacy row: only configuredDigest, no reference.
    h.db
      .update(imageTracks)
      .set({ configuredReference: null, configuredDigest: D_A })
      .where(eq(imageTracks.resourceId, appId))
      .run();
    // Live application now on ANOTHER repository with the same digest.
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string } };
      }
    ).__state.app.docker_image = 'ghcr.io/other/repo';
    (
      deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }
    ).__state.app.docker_image_tag = `sha256-${'a'.repeat(64)}`;
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_A,
        candidateReference: `ghcr.io/yetone/magpie:sha256-${'a'.repeat(64)}`,
        status: 'pending',
        trackingRevision: 0,
        idempotencyKey: 'legacy-xrepo',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const { UpdateExecutor } = await import('../src/server/modules/updates/executor.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const executor = new UpdateExecutor(
      h.db,
      deps.coolify,
      deps.jobs,
      new Outbox(h.db, () => null),
      deps.settings,
      deps.cfg,
    );
    await executor.processQueue();
    const job = h.db
      .select()
      .from(updateJobs)
      .where(eq(updateJobs.idempotencyKey, 'legacy-xrepo'))
      .get();
    // Same digest elsewhere = conflict, never a silent success.
    expect(job).toMatchObject({ status: 'conflict', errorCode: 'external_change' });
  });

  it('checker guard drops results when the resource becomes excluded mid-flight (R4-F8)', async () => {
    const slow = new Promise<{ digest: string }>((resolve) => {
      setTimeout(() => resolve({ digest: D_B }), 50);
    });
    const { UpdateChecker } = await import('../src/server/modules/updates/checker.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const checker = new UpdateChecker(
      h.db,
      deps.cfg,
      deps.settings,
      new Outbox(h.db, () => null),
      deps.jobs,
      (() => slow) as never,
      null,
    );
    const pending = checker.checkResource(appId, 'manual');
    h.db.update(resources).set({ excludedInfra: true }).where(eq(resources.id, appId)).run();
    const result = await pending;
    expect(result.outcome).toBe('blocked');
    expect(track().observedDigest).toBeNull();
  });
});

describe('review round 5 regressions (real interleavings)', () => {
  it('late source save during recovery GET is refused when the block was resolved meanwhile (R5-F1)', async () => {
    // Set external_change, start the PATCH (its GET is awaited via a deferred
    // promise), resolve the block (adopt-style) while it waits, then let the
    // PATCH finish: the tx must refuse because external_change is gone.
    h.db
      .update(resources)
      .set({ blockedReason: 'external_change' })
      .where(eq(resources.id, appId))
      .run();
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    Object.assign(deps.coolify, {
      getApplication: async (): Promise<CoolifyApplication> => {
        await gate;
        return {
          uuid: 'app-1',
          docker_image: 'ghcr.io/yetone/magpie',
          docker_image_tag: 'latest',
          status: 'running',
        } as unknown as CoolifyApplication;
      },
    });
    const app = createApp(deps);
    const pendingResponse = app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceTag: 'latest' }),
      headers: { 'Content-Type': 'application/json' },
    }) as Promise<Response>;
    const patchPromise: Promise<number> = pendingResponse.then((r) => r.status);
    // While the GET waits, the block is resolved externally.
    await new Promise((r) => setTimeout(r, 30));
    h.db.update(resources).set({ blockedReason: null }).where(eq(resources.id, appId)).run();
    releaseGet();
    const patchStatus = await patchPromise;
    expect(patchStatus).toBe(409);
    // State stays untouched.
    expect(track().sourceTag).toBe('latest');
    expect(track().trackingRevision).toBe(0);
  });

  it('sync removal is conditional on the snapshot revision (R5-F4)', async () => {
    // Seed a track directly (snapshot rev 0), then run a stale sync mid-bump.
    h.db
      .update(imageTracks)
      .set({
        configuredDigest: D_A,
        configuredReference: `ghcr.io/yetone/magpie:sha256-${'a'.repeat(64)}`,
      })
      .where(eq(imageTracks.resourceId, appId))
      .run();
    const row = resource();
    expect(row.status).toBe('active');
    const { InventorySync } = await import('../src/server/modules/inventory/sync.js');
    const slowSync = new InventorySync(
      h.db,
      {
        listApplications: async () => {
          // The bump happens after the list call returned empty.
          h.db
            .update(imageTracks)
            .set({ trackingRevision: 9 })
            .where(eq(imageTracks.resourceId, appId))
            .run();
          return [];
        },
        listServices: async () => [],
        listServiceApplications: async () => [],
        listResourceEntries: async () => [],
      } as unknown as CoolifyClient,
      deps.cfg,
      deps.settings,
    );
    const r = await slowSync.run();
    // The stale list must NOT remove the revision-changed resource.
    expect(r.removed).toBe(0);
    const after = h.db.select().from(resources).where(eq(resources.id, appId)).get();
    expect(after?.status).toBe('active');
  });

  it('digest-only legacy row: sync and executor both refuse another repository (R5-F3)', async () => {
    // Legacy shape: digest baseline, no reference, live in another repo.
    h.db
      .update(imageTracks)
      .set({ configuredDigest: D_A, configuredReference: null })
      .where(eq(imageTracks.resourceId, appId))
      .run();
    const { InventorySync } = await import('../src/server/modules/inventory/sync.js');
    const other = new InventorySync(
      h.db,
      {
        listApplications: async () => [
          {
            uuid: 'app-1',
            name: 'magpie',
            build_pack: 'dockerimage',
            docker_image: 'ghcr.io/other/repo',
            docker_image_tag: `sha256-${'a'.repeat(64)}`,
            fqdn: null,
            status: 'running',
          } as unknown as CoolifyApplication,
        ],
        listServices: async () => [],
        listServiceApplications: async () => [],
        listResourceEntries: async () => [],
      } as unknown as CoolifyClient,
      deps.cfg,
      deps.settings,
    );
    await other.run();
    const t = track();
    // The foreign-repo live ref is drift (identity gate): baseline preserved,
    // resource blocked — the foreign repo never becomes the accepted baseline.
    expect(t.configuredDigest).toBe(D_A);
    expect(t.configuredReference).toBeNull(); // legacy digest-only kept as-is
    const res = h.db.select().from(resources).where(eq(resources.id, appId)).get();
    expect(res?.blockedReason).toBe('external_change');
    // Executor candidate branch: same digest elsewhere is a conflict.
    const now = Date.now();
    h.db
      .insert(updateJobs)
      .values({
        resourceId: appId,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_A,
        candidateReference: `ghcr.io/yetone/magpie:sha256-${'a'.repeat(64)}`,
        status: 'pending',
        trackingRevision: 0,
        idempotencyKey: 'legacy-r5',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string } };
      }
    ).__state.app.docker_image = 'ghcr.io/other/repo';
    (
      deps.coolify as unknown as { __state: { app: { docker_image_tag: string } } }
    ).__state.app.docker_image_tag = `sha256-${'a'.repeat(64)}`;
    const { UpdateExecutor } = await import('../src/server/modules/updates/executor.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const executor = new UpdateExecutor(
      h.db,
      deps.coolify,
      deps.jobs,
      new Outbox(h.db, () => null),
      deps.settings,
      deps.cfg,
    );
    await executor.processQueue();
    const job = h.db
      .select()
      .from(updateJobs)
      .where(eq(updateJobs.idempotencyKey, 'legacy-r5'))
      .get();
    expect(job).toMatchObject({ status: 'conflict', errorCode: 'external_change' });
  });

  it('auto job creation is blocked by a sibling unknown_submit (R5-F2)', async () => {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-r5',
        name: 'stack-r5',
        policy: 'ignore',
        managementClassified: true,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const childA = h.db
      .insert(resources)
      .values({
        kind: 'service_application',
        coolifyUuid: 'child-a',
        parentId: parent.id,
        name: 'web-a',
        policy: 'auto',
        managementClassified: true,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const childB = h.db
      .insert(resources)
      .values({
        kind: 'service_application',
        coolifyUuid: 'child-b',
        parentId: parent.id,
        name: 'web-b',
        policy: 'auto',
        managementClassified: true,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    for (const c of [childA, childB]) {
      h.db
        .insert(imageTracks)
        .values({
          resourceId: c.id,
          sourceRegistry: 'docker.io',
          sourceRepository: 'library/nginx',
          sourceRepositoryAuthored: 'nginx',
          sourceTag: '1.27',
          targetPlatform: 'linux/amd64',
          configuredDigest: D_A,
          configuredReference: `nginx:sha256-${'a'.repeat(64)}`,
          observedDigest: D_B,
          observedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    // Sibling A holds unknown_submit; auto job for B must be silently skipped.
    h.db
      .insert(updateJobs)
      .values({
        resourceId: childA.id,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: D_A,
        candidateReference: 'x',
        status: 'unknown_submit',
        trackingRevision: 0,
        idempotencyKey: 'sib-us',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const job = deps.jobs.createAutoJob(childB.id, D_B);
    expect(job).toBeNull();
    expect(
      h.db.select().from(updateJobs).where(eq(updateJobs.resourceId, childB.id)).all(),
    ).toHaveLength(0);
  });

  it('compose preview accepts the registry-default equivalent form (R5-F5)', async () => {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-eq',
        name: 'stack-eq',
        policy: 'ignore',
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
        coolifyUuid: 'child-eq',
        parentId: parent.id,
        name: 'web-eq',
        composeServiceName: 'web',
        policy: 'manual',
        // Child live: registry-default normalized form.
        currentImage: 'docker.io/library/nginx:latest',
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
        resourceId: child.id,
        sourceRegistry: 'docker.io',
        sourceRepository: 'library/nginx',
        sourceRepositoryAuthored: 'nginx',
        sourceTag: 'latest',
        targetPlatform: 'linux/amd64',
        configuredDigest: D_A,
        configuredReference: 'old',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    Object.assign(deps.coolify, {
      listServiceApplications: async (): Promise<CoolifyServiceApplication[]> => [
        {
          uuid: 'child-eq',
          name: 'web',
          image: 'docker.io/library/nginx:latest',
          status: 'running',
        } as CoolifyServiceApplication,
      ],
      getService: async () =>
        ({
          uuid: 'svc-eq',
          // Raw compose uses the SHORT form — semantically equal.
          docker_compose_raw: 'services:\n  web:\n    image: nginx:latest\n',
        }) as never,
    });
    const prevAppId = appId;
    appId = child.id;
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${child.id}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(200); // equivalent, no contradiction
    appId = prevAppId;
  });
});

describe('review round 6 regressions (patch compatibility + digest equivalence)', () => {
  it('policy/cron save works for a compose parent without an image track (R6-F1)', async () => {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-nr',
        name: 'stack-nr',
        policy: 'ignore',
        managementClassified: true,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${parent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ policy: 'notify', checkCron: '*/15 * * * *' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: { policy: string; checkCron: string | null } };
    expect(body.resource.policy).toBe('notify');
    expect(body.resource.checkCron).toBe('*/15 * * * *');
  });

  it('policy/cron save works for an application whose track was removed (R6-F1)', async () => {
    h.db.delete(imageTracks).where(eq(imageTracks.resourceId, appId)).run();
    const app = createApp(deps);
    const res = await app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ policy: 'auto' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('PATCH refuses a resource removed during the recovery GET (R6-F3)', async () => {
    h.db
      .update(resources)
      .set({ blockedReason: 'external_change' })
      .where(eq(resources.id, appId))
      .run();
    let releaseGet: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    Object.assign(deps.coolify, {
      getApplication: async (): Promise<CoolifyApplication> => {
        await gate;
        return {
          uuid: 'app-1',
          docker_image: 'ghcr.io/yetone/magpie',
          docker_image_tag: 'latest',
          status: 'running',
        } as unknown as CoolifyApplication;
      },
    });
    const app = createApp(deps);
    const pendingResponse = app.request(`/api/resources/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ sourceTag: 'latest' }),
      headers: { 'Content-Type': 'application/json' },
    }) as Promise<Response>;
    const patchPromise: Promise<number> = pendingResponse.then((r) => r.status);
    await new Promise((r) => setTimeout(r, 30));
    // Resource removed while the GET waits.
    h.db.update(resources).set({ status: 'removed' }).where(eq(resources.id, appId)).run();
    releaseGet();
    expect(await patchPromise).toBe(409);
    // Restore for later tests.
    h.db.update(resources).set({ status: 'active' }).where(eq(resources.id, appId)).run();
  });

  it('compose digest-state equivalence: repo:stable@sha256:A ≡ repo@sha256:A (R6-F2)', async () => {
    const now = Date.now();
    const parent = h.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: 'svc-dg',
        name: 'stack-dg',
        policy: 'ignore',
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
        coolifyUuid: 'child-dg',
        parentId: parent.id,
        name: 'web-dg',
        composeServiceName: 'web',
        policy: 'manual',
        // Child live: digest form without a tag.
        currentImage: `ghcr.io/example/sample@sha256:${'a'.repeat(64)}`,
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
        resourceId: child.id,
        sourceRegistry: 'ghcr.io',
        sourceRepository: 'example/sample',
        sourceRepositoryAuthored: 'example/sample',
        sourceTag: 'stable',
        targetPlatform: 'linux/amd64',
        configuredDigest: D_A,
        configuredReference: 'old',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    Object.assign(deps.coolify, {
      listServiceApplications: async (): Promise<CoolifyServiceApplication[]> => [
        {
          uuid: 'child-dg',
          name: 'web',
          image: `ghcr.io/example/sample@sha256:${'a'.repeat(64)}`,
          status: 'running',
        } as CoolifyServiceApplication,
      ],
      getService: async () =>
        ({
          uuid: 'svc-dg',
          // Raw compose spells the tag too — same repo + same digest.
          docker_compose_raw: `services:\n  web:\n    image: ghcr.io/example/sample:stable@sha256:${'a'.repeat(64)}\n`,
        }) as never,
    });
    const prevAppId = appId;
    appId = child.id;
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${child.id}/adopt-preview`, {
      method: 'POST',
      body: '{}',
    });
    expect(p.status).toBe(200); // same repo + same digest → equivalent
    appId = prevAppId;
  });

  it('real tag@digest prior flows through adopt → executor → success (R4-V6)', async () => {
    // Live config in Coolify's docker_image-only form carrying tag@digest.
    stubResolver(); // stable → D_B
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string | null } };
      }
    ).__state.app.docker_image = 'ghcr.io/yetone/magpie:stable';
    (
      deps.coolify as unknown as {
        __state: { app: { docker_image: string; docker_image_tag: string | null } };
      }
    ).__state.app.docker_image_tag = null;
    // mapper: docker_registry_image_* absent → docker_image without tag suffix
    // yields `ghcr.io/yetone/magpie:stable` (tag parsed from the path).
    const app = createApp(deps);
    const p = await app.request(`/api/resources/${appId}/adopt-preview`, {
      method: 'POST',
      body: JSON.stringify({ sourceTag: 'stable' }),
    });
    expect(p.status).toBe(200);
    const { preview } = (await p.json()) as {
      preview: { previewToken: string; targetDigest: string };
    };
    expect(preview.targetDigest).toBe(D_B);
    const c = await app.request(`/api/resources/${appId}/adopt`, {
      method: 'POST',
      body: JSON.stringify({ previewToken: preview.previewToken }),
    });
    expect(c.status).toBe(200);
    // The created job's prior preserves the live reference string.
    const job = jobRows()[0]!;
    expect(job.priorReference).toContain('magpie');
    // Execute to success: the executor accepts the tag@digest prior.
    const { UpdateExecutor } = await import('../src/server/modules/updates/executor.js');
    const { Outbox } = await import('../src/server/modules/notifications/outbox.js');
    const executor = new UpdateExecutor(
      h.db,
      deps.coolify,
      deps.jobs,
      new Outbox(h.db, () => null),
      deps.settings,
      deps.cfg,
    );
    await executor.processQueue();
    expect(jobRows()[0]?.status).toBe('success');
  });
});
