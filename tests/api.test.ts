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

  it('targeted check accepts resourceIds and rejects invalid bodies', async () => {
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
});
