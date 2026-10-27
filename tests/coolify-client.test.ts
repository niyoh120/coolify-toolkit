// Coolify API client contract tests against a stub server (v4.3.23 shapes).

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoolifyApiError, CoolifyClient } from '../src/server/integrations/coolify/client.js';

let server: Server;
let port: number;
let lastAuth: string | null = null;
let lastBody: string | null = null;
let lastMethodPath = '';
/** Scenario switches for the error-path stubs below. */
const mode: {
  rateMode: 'seconds' | 'date' | 'invalid' | 'none' | 'off';
  versionMode: 'ok' | '404' | 'plaintext';
} = { rateMode: 'off', versionMode: 'ok' };

const app = {
  id: 1,
  uuid: 'app-uuid-1',
  name: 'jellyfin',
  build_pack: 'dockerimage',
  docker_image: 'jellyfin/jellyfin',
  docker_image_tag: 'latest',
  fqdn: 'https://jellyfin.example.com',
  status: 'running',
  project: { uuid: 'p1', name: 'media' },
  environment: { uuid: 'e1', name: 'production' },
  destination: { id: 2, name: 'homelab' },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastAuth = req.headers.authorization ?? null;
    lastMethodPath = `${req.method} ${req.url}`;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8') || null;
      const url = req.url ?? '';
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const raw = (
        status: number,
        body: string | unknown,
        headers: Record<string, string> = {},
      ): void => {
        res.writeHead(status, headers);
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (url === '/api/v1/version') {
        if (mode.versionMode === '404') return raw(404, { message: 'no route' });
        if (mode.versionMode === 'plaintext')
          return raw(200, '4.3.20', { 'Content-Type': 'text/plain' });
        return json(200, { version: '4.3.23' });
      }
      if (url.startsWith('/api/v1/applications?page=')) {
        // 限流场景：首次列表调用即 429，驱动 sync 错误链路。
        if (mode.rateMode !== 'off') {
          if (mode.rateMode === 'seconds')
            return raw(429, { message: 'Too Many Attempts.' }, { 'Retry-After': '30' });
          if (mode.rateMode === 'date')
            return raw(
              429,
              { message: 'Too Many Attempts.' },
              {
                'Retry-After': new Date(Date.now() + 90_000).toUTCString(),
              },
            );
          if (mode.rateMode === 'invalid')
            return raw(429, { message: 'Too Many Attempts.' }, { 'Retry-After': '-5' });
          return raw(429, { message: 'Too Many Attempts.' });
        }
        const page = Number(url.slice(-1));
        if (page === 0) return json(200, { data: [app], meta: { current_page: 0, last_page: 1 } });
        return json(200, { data: [], meta: { current_page: 1, last_page: 1 } });
      }
      if (url === '/api/v1/applications/app-uuid-1') return json(200, app);
      if (url === '/api/v1/applications/rate-limited') {
        if (mode.rateMode === 'date')
          return raw(
            429,
            { message: 'Too Many Attempts.' },
            {
              'Retry-After': new Date(Date.now() + 90_000).toUTCString(),
            },
          );
        if (mode.rateMode === 'invalid')
          return raw(429, { message: 'Too Many Attempts.' }, { 'Retry-After': '-5' });
        if (mode.rateMode === 'none') return raw(429, { message: 'Too Many Attempts.' });
        return raw(429, { message: 'Too Many Attempts.' }, { 'Retry-After': '30' });
      }
      if (url === '/api/v1/applications/gateway')
        return raw(502, '<html>Bad Gateway</html>', { 'Content-Type': 'text/html' });
      if (url.startsWith('/api/v1/applications/app-uuid-1/start')) {
        return json(200, { message: 'Deployment queued.', deployment_uuid: 'dep-uuid-9' });
      }
      if (url === '/api/v1/deployments/applications/app-uuid-1') {
        // v4.3.23 实测响应形态：{ count, deployments: [...] }
        return json(200, {
          count: 1,
          deployments: [
            {
              id: 30,
              deployment_uuid: 'dep-uuid-9',
              status: 'finished',
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      if (url === '/api/v1/deployments/dep-uuid-9')
        return json(200, { id: 30, deployment_uuid: 'dep-uuid-9', status: 'finished' });
      if (url === '/api/v1/services/svc-uuid/applications') {
        return json(200, [
          {
            uuid: 'child-uuid-1',
            name: 'web',
            human_name: 'Web',
            image: 'nginx:1.27',
            fqdn: 'x.example.com',
            status: 'running',
          },
        ]);
      }
      if (url === '/api/v1/applications/missing')
        return json(404, { message: 'Application not found.' });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'boom' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e == null ? resolve() : reject(e))),
  );
});

function client(): CoolifyClient {
  return new CoolifyClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-key',
    verifyTls: true,
  });
}

describe('coolify client', () => {
  it('sends bearer auth and paginates {data,meta} envelopes', async () => {
    const apps = await client().listApplications();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ uuid: 'app-uuid-1', docker_image_tag: 'latest' });
    expect(lastAuth).toBe('Bearer test-key');
  });

  it('validates application details through the schema', async () => {
    const a = await client().getApplication('app-uuid-1');
    expect(a.build_pack).toBe('dockerimage');
    expect(a.destination?.name).toBe('homelab');
  });

  it('patches applications and reads back the deployment uuid from start', async () => {
    const c = client();
    await c.patchApplication('app-uuid-1', { docker_image_tag: `sha256-${'a'.repeat(64)}` });
    expect(lastMethodPath).toBe('PATCH /api/v1/applications/app-uuid-1');
    expect(JSON.parse(lastBody ?? '{}')).toEqual({ docker_image_tag: `sha256-${'a'.repeat(64)}` });
    const started = await c.startApplication('app-uuid-1');
    expect(started.deploymentUuid).toBe('dep-uuid-9');
    expect(lastMethodPath).toBe('POST /api/v1/applications/app-uuid-1/start?latest=true');
  });

  it('reads deployments history and detail', async () => {
    const c = client();
    const history = await c.getDeploymentsForApplication('app-uuid-1');
    expect(history[0]?.deployment_uuid).toBe('dep-uuid-9');
    const detail = await c.getDeployment('dep-uuid-9');
    expect(detail.status).toBe('finished');
  });

  it('lists compose service applications (bare array shape)', async () => {
    const children = await client().listServiceApplications('svc-uuid');
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      uuid: 'child-uuid-1',
      image: 'nginx:1.27',
      fqdn: 'x.example.com',
    });
  });

  it('maps 404 to a CoolifyApiError with status', async () => {
    const err = await client()
      .getApplication('missing')
      .catch((e) => e);
    expect(err).toBeInstanceOf(CoolifyApiError);
    expect(err.statusCode).toBe(404);
  });

  it('maps upstream 429 to a 503 rate-limit error with seconds hint and details', async () => {
    mode.rateMode = 'seconds';
    const err = await client()
      .getApplication('rate-limited')
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(CoolifyApiError);
    const e = err as CoolifyApiError & { code: string; status: number };
    expect(e.code).toBe('coolify_rate_limited');
    expect(e.status).toBe(503);
    expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBe(30);
    expect(e.details).toEqual({ upstreamStatus: 429, retryAfterSeconds: 30 });
  });

  it('converts an HTTP-date Retry-After to remaining seconds', async () => {
    mode.rateMode = 'date';
    const err = await client()
      .getApplication('rate-limited')
      .then(
        () => null,
        (e: unknown) => e,
      );
    const e = err as CoolifyApiError;
    expect(e.code).toBe('coolify_rate_limited');
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.retryAfterSeconds).toBeLessThanOrEqual(90);
  });

  it('drops an invalid Retry-After but keeps the rate-limit code', async () => {
    mode.rateMode = 'invalid';
    const err = await client()
      .getApplication('rate-limited')
      .then(
        () => null,
        (e: unknown) => e,
      );
    const e = err as CoolifyApiError;
    expect(e.code).toBe('coolify_rate_limited');
    expect(e.retryAfterSeconds).toBeUndefined();
    expect(e.details).toEqual({ upstreamStatus: 429 });
  });

  it('rejects non-finite and non-HTTP-date Retry-After values', async () => {
    const { retryAfterSeconds } = await import('../src/server/integrations/coolify/client.js');
    const now = Date.parse('2026-01-01T00:00:00Z');
    // 400-digit number parses to Infinity → dropped.
    expect(retryAfterSeconds('9'.repeat(400), now)).toBeUndefined();
    // Negative digits are a non-HTTP-date string (loose parse would read them
    // as an extended year far in the future) → dropped.
    expect(retryAfterSeconds('-9999', now)).toBeUndefined();
    expect(retryAfterSeconds('-5', now)).toBeUndefined();
    expect(retryAfterSeconds('not-a-date', now)).toBeUndefined();
    expect(retryAfterSeconds('', now)).toBeUndefined();
    // Well-formed HTTP-date in the past → dropped (no wait needed).
    expect(retryAfterSeconds('Wed, 01 Jan 2025 00:00:00 GMT', now)).toBeUndefined();
    // Valid forms still work — identical results across server timezones
    // (asctime carries no GMT suffix, so it must be parsed explicitly as UTC).
    expect(retryAfterSeconds('42', now)).toBe(42);
    expect(retryAfterSeconds('0', now)).toBe(0);
    expect(retryAfterSeconds('Thu, 01 Jan 2026 00:01:30 GMT', now)).toBe(90);
    expect(retryAfterSeconds('Thursday, 01-Jan-26 00:01:30 GMT', now)).toBe(90);
    expect(retryAfterSeconds('Thu Jan  1 00:01:30 2026', now)).toBe(90);
    // Out-of-range fields must be rejected, not rolled over by Date.UTC
    // (32 Jan → 1 Feb would yield ~2678400s; 00:99 → 01:39 would yield ~5940s).
    expect(retryAfterSeconds('Thu, 32 Jan 2026 00:01:30 GMT', now)).toBeUndefined();
    expect(retryAfterSeconds('Thu, 01 Jan 2026 00:99:00 GMT', now)).toBeUndefined();
    expect(retryAfterSeconds('Thu, 01 Jan 2026 25:00:00 GMT', now)).toBeUndefined();
    expect(retryAfterSeconds('Thu, 01 Jan 2026 00:01:60 GMT', now)).toBeUndefined();
    // Non-calendar dates (2026 is not a leap year).
    expect(retryAfterSeconds('Thu, 29 Feb 2026 00:00:00 GMT', now)).toBeUndefined();
    expect(retryAfterSeconds('Thu Feb 29 00:00:00 2026', now)).toBeUndefined();
    // Leap-year Feb 29 is a real calendar date.
    expect(retryAfterSeconds('Tue, 29 Feb 2028 00:00:00 GMT', now)).toBeGreaterThan(0);
    // RFC 850 two-digit years follow the 50-year window relative to `now`
    // (fixed now = 2026). '66 resolves to 2066 (40y ahead): a valid future
    // date, so the remaining wait is huge rather than 90 — assert positive.
    const y2066 = retryAfterSeconds('Friday, 01-Jan-66 00:01:30 GMT', now);
    expect(y2066).toBeGreaterThan(0);
    // Same wall-clock in an unambiguous 4-digit year must match exactly.
    expect(y2066).toBe(retryAfterSeconds('Thu, 01 Jan 2066 00:01:30 GMT', now));
    // '77 resolves to 2077 (51y ahead, outside the 50-year window) → wraps to
    // 1977, which is in the past → dropped.
    expect(retryAfterSeconds('Saturday, 01-Jan-77 00:01:30 GMT', now)).toBeUndefined();
  });

  it('keeps non-rate-limit errors on the legacy 502 shape with statusCode', async () => {
    const err = await client()
      .getApplication('gateway')
      .then(
        () => null,
        (e: unknown) => e,
      );
    const e = err as CoolifyApiError;
    expect(e.code).toBe('coolify_unavailable');
    expect(e.status).toBe(502);
    expect(e.statusCode).toBe(502);
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  it('probe reports ok:false when the version endpoint errors (non-2xx)', async () => {
    mode.versionMode = '404';
    const failing = await client().probe();
    expect(failing).toEqual({ ok: false, version: null });
    mode.versionMode = 'plaintext';
    const ok = await client().probe();
    expect(ok).toEqual({ ok: true, version: '4.3.20' });
    mode.versionMode = 'ok';
  });

  it('probes the version endpoint', async () => {
    const probe = await client().probe();
    expect(probe).toEqual({ ok: true, version: '4.3.23' });
  });

  it('passes rate-limit errors through sync as 503 with a validated Retry-After header', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { openDatabase } = await import('../src/server/db/client.js');
    const { migrate } = await import('../src/server/db/migrate.js');
    const { SettingsRepo } = await import('../src/server/db/settings-repo.js');
    const { InventorySync } = await import('../src/server/modules/inventory/sync.js');
    const { createApp } = await import('../src/server/app.js');

    mode.rateMode = 'seconds';
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-sync-429-'));
    const handle = openDatabase(path.join(dir, 'db.sqlite'));
    migrate(handle.db);
    const settings = new SettingsRepo(handle.db);
    const cfg = {
      coolifyBaseUrl: `http://127.0.0.1:${port}`,
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
    const sync = new InventorySync(handle.db, client(), cfg, settings);
    const app = createApp({
      cfg,
      db: handle.db,
      coolify: client(),
      apprise: null,
      settings,
      sync,
      checker: {} as never,
      jobs: {} as never,
      executor: {} as never,
      tracking: {} as never,
      outbox: {} as never,
    });
    const res = await app.request('/api/sync', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    const body = (await res.json()) as {
      error: {
        code: string;
        details: { upstreamStatus: number; retryAfterSeconds: number } | null;
      };
    };
    expect(body.error.code).toBe('coolify_rate_limited');
    expect(body.error.details).toEqual({ upstreamStatus: 429, retryAfterSeconds: 30 });
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('omits Retry-After on rate-limit responses without a usable hint', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { openDatabase } = await import('../src/server/db/client.js');
    const { migrate } = await import('../src/server/db/migrate.js');
    const { SettingsRepo } = await import('../src/server/db/settings-repo.js');
    const { InventorySync } = await import('../src/server/modules/inventory/sync.js');
    const { createApp } = await import('../src/server/app.js');

    mode.rateMode = 'none';
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-sync-429b-'));
    const handle = openDatabase(path.join(dir, 'db.sqlite'));
    migrate(handle.db);
    const settings = new SettingsRepo(handle.db);
    const cfg = {
      coolifyBaseUrl: `http://127.0.0.1:${port}`,
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
    const sync = new InventorySync(handle.db, client(), cfg, settings);
    const app = createApp({
      cfg,
      db: handle.db,
      coolify: client(),
      apprise: null,
      settings,
      sync,
      checker: {} as never,
      jobs: {} as never,
      executor: {} as never,
      tracking: {} as never,
      outbox: {} as never,
    });
    const res = await app.request('/api/sync', { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBeNull();
    const body = (await res.json()) as {
      error: { code: string; details: { upstreamStatus: number } | null };
    };
    expect(body.error.code).toBe('coolify_rate_limited');
    expect(body.error.details).toEqual({ upstreamStatus: 429 });
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
