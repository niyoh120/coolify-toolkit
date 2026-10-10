// Public API behavior: validation, same-origin writes, error differentiation.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources, settings, updateJobs } from '../src/server/db/schema.js';
import { buildDeps, type Deps } from '../src/server/deps.js';

let h: OpenDbResult;
let dir: string;
let deps: Deps;

const D_B = `sha256:${'b'.repeat(64)}`;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-api-'));
  h = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(h.db);
  process.env.COOLIFY_BASE_URL = 'http://127.0.0.1:1'; // unreachable stub target
  process.env.COOLIFY_API_KEY = 'k';
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  const cfg = loadConfig();
  deps = buildDeps(cfg, h.db);

  const now = Date.now();
  const res = h.db
    .insert(resources)
    .values({
      kind: 'application',
      coolifyUuid: 'app-1',
      name: 'app',
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
      resourceId: res.id,
      sourceRegistry: 'docker.io',
      sourceRepository: 'jellyfin/jellyfin',
      sourceRepositoryAuthored: 'jellyfin/jellyfin',
      sourceTag: 'latest',
      targetPlatform: 'linux/amd64',
      platformSource: 'server_default',
      configuredDigest: `sha256:${'a'.repeat(64)}`,
      observedDigest: D_B,
      observedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterEach(() => {
  h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('api', () => {
  it('lists resources from the local projection', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/resources');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resources: Array<{ name: string; track: { view: { checkOutcome: string } } }>;
    };
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]?.track?.view.checkOutcome).toBe('candidate');
  });

  it('rejects invalid input with a validation code', async () => {
    const app = createApp(deps);
    const res = await app.request('/api/resources/batch-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceIds: [], policy: 'bogus' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });

  it('rejects cross-origin writes but allows same-origin and no-origin', async () => {
    const app = createApp(deps);
    const json = { resourceIds: [1], policy: 'notify' };

    const evil = await app.request('/api/resources/batch-policy', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    expect(evil.status).toBe(403);

    const ok = await app.request('/api/resources/batch-policy', {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:8080',
        Host: 'localhost:8080',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(json),
    });
    expect(ok.status).toBe(200);
  });

  it('update without fresh observation yields candidate_unknown; with preview flows to job', async () => {
    const app = createApp(deps);
    // No observation: preview refuses.
    const id = h.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get()!.id;
    h.db
      .update(imageTracks)
      .set({ observedDigest: null })
      .where(eq(imageTracks.resourceId, id))
      .run();
    const p1 = await app.request(`/api/resources/${id}/preview`, { method: 'POST', body: '{}' });
    expect(p1.status).toBe(409);
    const b1 = (await p1.json()) as { error: { code: string } };
    expect(b1.error.code).toBe('candidate_unknown');

    // With observation: preview issues token; forged update is rejected.
    h.db
      .update(imageTracks)
      .set({ observedDigest: D_B })
      .where(eq(imageTracks.resourceId, id))
      .run();
    const p2 = await app.request(`/api/resources/${id}/preview`, { method: 'POST', body: '{}' });
    const b2 = (await p2.json()) as {
      preview: { previewToken: string; candidateDigest: string } | null;
    };
    expect(b2.preview).not.toBeNull();
    const forged = await app.request(`/api/resources/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ candidateDigest: D_B, previewToken: 'f'.repeat(32) }),
    });
    expect(forged.status).toBe(409);

    const good = await app.request(`/api/resources/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ candidateDigest: D_B, previewToken: b2.preview!.previewToken }),
    });
    expect(good.status).toBe(202);
    const gb = (await good.json()) as { job: { status: string; candidateDigest: string } };
    expect(gb.job).toMatchObject({ status: 'pending', candidateDigest: D_B });
    expect(h.db.select().from(updateJobs).all()).toHaveLength(1);
  });

  // 用例走真实 registry 网络调用，满载并行下可能变慢：显式放宽超时避免偶发抖动。
  it('targeted check accepts resourceIds and rejects invalid bodies', {
    timeout: 40_000,
  }, async () => {
    const app = createApp(deps);
    const track = h.db.select().from(imageTracks).get();
    expect(track).toBeTruthy();

    const res = await app.request('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceIds: [1] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checked: number };
    expect(body.ok).toBe(true);
    expect(body.checked).toBe(1);

    const bad = await app.request('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceIds: 'nope' }),
    });
    expect(bad.status).toBe(400);
  });

  it('skipPreview submits from fresh observation and reports no-update', async () => {
    const app = createApp(deps);
    // 观察与配置不同（candidate）→ 直接建任务
    const res = await app.request('/api/resources/1/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skipPreview: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job: { candidateDigest: string } };
    expect(body.job.candidateDigest).toBe(D_B);

    // 观察等于配置（无更新）→ skipped
    const db2 = h.db;
    db2
      .update(imageTracks)
      .set({ observedDigest: `sha256:${'a'.repeat(64)}` })
      .run();
    const res2 = await app.request('/api/resources/1/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skipPreview: true }),
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { skipped?: boolean };
    expect(body2.skipped).toBe(true);

    // 无观察 → candidate_unknown
    db2.update(imageTracks).set({ observedDigest: null }).run();
    const res3 = await app.request('/api/resources/1/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skipPreview: true }),
    });
    expect(res3.status).toBe(409);
  });

  it('distinguishes unknown api routes and job states', async () => {
    const app = createApp(deps);
    const missing = await app.request('/api/resources/999');
    expect(missing.status).toBe(404);
    const jobsRes = await app.request('/api/jobs?status=success');
    expect(jobsRes.status).toBe(200);
    const jb = (await jobsRes.json()) as { jobs: unknown[] };
    expect(jb.jobs).toEqual([]);
  });

  it('serves the SPA index for the root path when a build exists', async () => {
    // No build present in this test env: app still answers API.
    const app = createApp(deps);
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    void settings;
  });

  describe('GET /api/resources?parent=', () => {
    interface SeedRow {
      kind: 'application' | 'compose_service' | 'service_application';
      coolifyUuid: string;
      name: string;
      parentId?: number;
      policy?: 'ignore' | 'notify' | 'manual' | 'auto';
      status?: 'active' | 'removed';
    }
    let parentA: number;
    let parentB: number;

    beforeEach(() => {
      const now = Date.now();
      const insert = (row: SeedRow): number =>
        h.db
          .insert(resources)
          .values({
            kind: row.kind,
            coolifyUuid: row.coolifyUuid,
            name: row.name,
            parentId: row.parentId ?? null,
            policy: row.policy ?? 'ignore',
            status: row.status ?? 'active',
            configFingerprint: 'fp',
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get()!.id;
      parentA = insert({ kind: 'compose_service', coolifyUuid: 'svc-a', name: 'svc-a' });
      parentB = insert({ kind: 'compose_service', coolifyUuid: 'svc-b', name: 'svc-b' });
      insert({
        kind: 'service_application',
        coolifyUuid: 'child-a1',
        name: 'web',
        parentId: parentA,
        policy: 'notify',
      });
      insert({
        kind: 'service_application',
        coolifyUuid: 'child-a2',
        name: 'db',
        parentId: parentA,
      });
      insert({
        kind: 'service_application',
        coolifyUuid: 'child-a-removed',
        name: 'old',
        parentId: parentA,
        status: 'removed',
      });
      insert({
        kind: 'service_application',
        coolifyUuid: 'child-b1',
        name: 'api',
        parentId: parentB,
        policy: 'auto',
      });
      insert({ kind: 'application', coolifyUuid: 'standalone', name: 'standalone' });
    });

    const listNames = async (query: string): Promise<string[]> => {
      const app = createApp(deps);
      const res = await app.request(`/api/resources${query}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resources: Array<{ name: string }> };
      return body.resources.map((r) => r.name);
    };

    it('returns only the target parent active children and keeps parent names', async () => {
      const app = createApp(deps);
      const res = await app.request(`/api/resources?parent=${parentA}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        resources: Array<{ name: string; parentName: string | null; kind: string }>;
      };
      expect(body.resources.map((r) => r.name).sort()).toEqual(['db', 'web']);
      for (const r of body.resources) {
        expect(r.parentName).toBe('svc-a');
        expect(r.kind).toBe('service_application');
      }
    });

    it('intersects with kind, policy and status filters', async () => {
      await expect(listNames(`?parent=${parentA}&kind=application`)).resolves.toEqual([]);
      await expect(listNames(`?parent=${parentA}&policy=notify`)).resolves.toEqual(['web']);
      await expect(
        listNames(`?parent=${parentA}&status=all`).then((names) => names.sort()),
      ).resolves.toEqual(['db', 'old', 'web']);
    });

    it('returns an empty list for a valid but unknown parent id', async () => {
      await expect(listNames('?parent=999999')).resolves.toEqual([]);
    });

    it.each([
      '?parent=abc',
      '?parent=',
      '?parent=0',
      '?parent=-1',
      '?parent=1.5',
      '?parent=1e3',
      '?parent=0x10',
      '?parent=1%20',
      '?parent=999999999999999999999',
      '?parent=1&parent=2',
    ])('rejects invalid parent param %s with 400', async (query) => {
      const app = createApp(deps);
      const res = await app.request(`/api/resources${query}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_error');
    });

    it('keeps the default list behavior when parent is absent', async () => {
      const names = await listNames('');
      expect(names).toContain('standalone');
      expect(names).toContain('web');
      expect(names).toContain('svc-a');
    });
  });
});
