// Coolify API client contract tests against a stub server (v4.3.23 shapes).

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoolifyApiError, CoolifyClient } from '../src/server/integrations/coolify/client.js';

let server: Server;
let port: number;
let lastAuth: string | null = null;
let lastBody: string | null = null;
let lastMethodPath = '';

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
      if (url === '/api/v1/version') return json(200, { version: '4.3.23' });
      if (url.startsWith('/api/v1/applications?page=')) {
        const page = Number(url.slice(-1));
        if (page === 0) return json(200, { data: [app], meta: { current_page: 0, last_page: 1 } });
        return json(200, { data: [], meta: { current_page: 1, last_page: 1 } });
      }
      if (url === '/api/v1/applications/app-uuid-1') return json(200, app);
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

  it('probes the version endpoint', async () => {
    const probe = await client().probe();
    expect(probe).toEqual({ ok: true, version: '4.3.23' });
  });
});
