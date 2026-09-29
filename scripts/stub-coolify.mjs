// Offline Coolify stub for UI walkthroughs (explicit tool, not a test).
// Serves deterministic v4.3.23-shaped responses:
//   - jellyfin: pinned at digest A, upstream moved to digest B (candidate)
//   - navidrome: tag latest, no digest yet (unfixed)
//   - compose stack: two children (web managed candidate, db ignored sibling)
// Usage: node scripts/stub-coolify.mjs [port]   (default 9901)
import { createServer } from 'node:http';

const D_A = `sha256:${'a'.repeat(64)}`;
const D_B = `sha256:${'b'.repeat(64)}`;

const state = {
  jellyfinTag: `sha256-${'a'.repeat(64)}`,
  webImage: 'nginx:1.27',
  patchCalls: 0,
  startCalls: 0,
};

const jellyfin = () => ({
  id: 1,
  uuid: 'jelly-uuid',
  name: 'jellyfin',
  build_pack: 'dockerimage',
  docker_image: 'jellyfin/jellyfin',
  docker_image_tag: state.jellyfinTag,
  fqdn: 'https://jf.example.com',
  status: 'running',
  project: { uuid: 'p', name: 'media' },
  environment: { uuid: 'e', name: 'prod' },
  destination: { id: 1, name: 'homelab' },
});

const navidrome = () => ({
  id: 2,
  uuid: 'navi-uuid',
  name: 'navidrome',
  build_pack: 'dockerimage',
  docker_image: 'ghcr.io/navidrome/navidrome',
  docker_image_tag: 'latest',
  fqdn: '',
  status: 'running',
  project: { uuid: 'p', name: 'media' },
  environment: { uuid: 'e', name: 'prod' },
  destination: { id: 1, name: 'homelab' },
});

const stack = () => ({
  id: 3,
  uuid: 'stack-uuid',
  name: 'webstack',
  docker_compose_raw: `services:\n  web:\n    image: ${state.webImage}\n  db:\n    image: postgres:16\n    platform: linux/arm64\n`,
  status: 'running',
  project: { uuid: 'p', name: 'media' },
  environment: { uuid: 'e', name: 'prod' },
  destination: { id: 1, name: 'homelab' },
});

const children = () => [
  {
    uuid: 'web-child',
    name: 'web',
    human_name: 'Web',
    image: state.webImage,
    fqdn: 'https://web.example.com',
    status: 'running',
  },
  {
    uuid: 'db-child',
    name: 'db',
    human_name: 'Db',
    image: 'postgres:16',
    fqdn: '',
    status: 'running',
  },
];

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (p === '/api/v1/version') return json(res, { version: '4.3.23-stub' });
    if (p === '/api/v1/applications') return json(res, [jellyfin(), navidrome()]);
    if (p === '/api/v1/applications/jelly-uuid' && req.method === 'PATCH') {
      const patch = JSON.parse(body || '{}');
      if (patch.docker_image_tag != null) state.jellyfinTag = patch.docker_image_tag;
      return json(res, { message: 'updated' });
    }
    if (p === '/api/v1/applications/jelly-uuid') return json(res, jellyfin());
    if (p === '/api/v1/applications/jelly-uuid/start') {
      state.startCalls += 1;
      return json(res, { message: 'queued', deployment_uuid: `dep-${state.startCalls}` });
    }
    if (p.startsWith('/api/v1/deployments/dep-')) {
      return json(res, { id: 99, deployment_uuid: p.split('/').pop(), status: 'finished' });
    }
    if (p === '/api/v1/deployments/applications/jelly-uuid') {
      return json(res, [
        {
          id: 99,
          deployment_uuid: `dep-${state.startCalls}`,
          status: 'finished',
          created_at: new Date().toISOString(),
        },
      ]);
    }
    if (p === '/api/v1/services') return json(res, [stack()]);
    if (p === '/api/v1/services/stack-uuid') return json(res, stack());
    if (p === '/api/v1/services/stack-uuid/applications') return json(res, children());
    if (p === '/api/v1/services/stack-uuid/applications/web-child' && req.method === 'PATCH') {
      const patch = JSON.parse(body || '{}');
      if (patch.image != null) {
        state.webImage = patch.image;
        state.patchCalls += 1;
      }
      return json(res, { message: 'updated' });
    }
    if (p === '/api/v1/services/stack-uuid/applications/web-child/start') {
      return json(res, { message: 'Service application deploy request queued.' });
    }
    json(res, { message: `stub: unhandled ${req.method} ${p}` }, 404);
  });
});

const port = Number(process.argv[2] ?? 9901);
server.listen(port, '127.0.0.1', () => {
  console.log(
    `[stub-coolify] http://127.0.0.1:${port}  (digest A=${D_A.slice(0, 19)}… B=${D_B.slice(0, 19)}…)`,
  );
});
