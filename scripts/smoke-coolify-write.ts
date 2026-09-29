// Explicit Coolify WRITE sandbox smoke. NOT part of tests; touches the real
// instance by creating disposable toolkit-smoke-* resources and cleaning only
// those tracked UUIDs. Requires explicit opt-in: SMOKE_WRITE_APPROVED=yes
//
//   SMOKE_WRITE_APPROVED=yes SMOKE_PROJECT_UUID=... SMOKE_SERVER_UUID=... \
//     npx tsx scripts/smoke-coolify-write.ts
//
// Scope (matches plan §Test Plan):
//  1. lightweight dockerimage application: pin A -> deploy B -> readback.
//  2. compose service with two lightweight children: child image PATCH writes
//     raw compose; sibling + domains preserved; targeted start queued-only.
// The script never touches pre-existing resource UUIDs.
import '../src/server/sdk-env.js';
import { loadConfig } from '../src/server/config.js';
import { coolifyDigestTag } from '../src/server/integrations/registry/reference.js';

if (process.env.SMOKE_WRITE_APPROVED !== 'yes') {
  console.error('Refusing to run: set SMOKE_WRITE_APPROVED=yes to enable Coolify write smoke.');
  process.exit(1);
}

const cfg = loadConfig();
const API = `${cfg.coolifyBaseUrl}/api/v1`;
const HEADERS = {
  Authorization: `Bearer ${cfg.coolifyApiKey}`,
  'Content-Type': 'application/json',
};

type Json = Record<string, unknown> | string | null;

async function api(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = text;
  }

  return { status: res.status, json };
}

function asList(json: Json): Array<{ uuid: string; name: string; image: string | null }> {
  if (Array.isArray(json))
    return json as Array<{ uuid: string; name: string; image: string | null }>;
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data)
    ? (data as Array<{ uuid: string; name: string; image: string | null }>)
    : [];
}

const created: { kind: string; uuid: string }[] = [];
const D_B = `sha256:${'8'.repeat(64)}`;

async function cleanup(): Promise<void> {
  for (const { kind, uuid } of created) {
    try {
      const { status } = await api(`/${kind}/${uuid}`, 'DELETE');
      console.log(`cleanup ${kind} ${uuid}: ${status === 404 ? 'already gone' : `http ${status}`}`);
    } catch (err) {
      console.log(
        `cleanup ${kind} ${uuid}: MANUAL CHECK (${err instanceof Error ? err.message : err})`,
      );
    }
  }
}

let failures = 0;
try {
  const ver = await api('/version');
  if (ver.status !== 200) throw new Error('instance unreachable');
  console.log(`instance version: ${String(ver.json).slice(0, 20)}`);

  // --- 1. application A -> B ----------------------------------------------
  const appRes = await api('/applications/dockerimage', 'POST', {
    project_uuid: process.env.SMOKE_PROJECT_UUID,
    server_uuid: process.env.SMOKE_SERVER_UUID,
    docker_name: 'toolkit-smoke-app',
    docker_image: 'nginx',
    docker_image_tag: 'latest',
    domain: 'http://toolkit-smoke.test',
  });
  const appUuid = (appRes.json as { uuid?: string } | null)?.uuid;
  if (appRes.status !== 200 || appUuid == null) {
    throw new Error(`application create failed: http ${appRes.status}`);
  }
  created.push({ kind: 'applications', uuid: appUuid });
  console.log(`application ${appUuid} created`);

  // Pin digest B (valid digest format; pulling an unknown digest fails upstream
  // and is the negative case — config retention is verified on the toolkit side).
  const patchRes = await api(`/applications/${appUuid}`, 'PATCH', {
    docker_image_tag: coolifyDigestTag(D_B),
  });
  console.log(`patch digest tag: http ${patchRes.status}`);
  const startRes = await api(`/applications/${appUuid}/start?latest=true`, 'POST');
  console.log(
    `start: http ${startRes.status} deployment=${startRes.json?.deployment_uuid ?? 'none'}`,
  );
  const rb = await api(`/applications/${appUuid}`);
  const ok =
    (rb.json as { docker_image_tag?: string } | null)?.docker_image_tag === coolifyDigestTag(D_B);
  console.log(`${ok ? 'OK ' : 'FAIL'} readback tag equals written digest`);
  if (!ok) failures += 1;

  // --- 2. compose service with two children -------------------------------
  const raw = [
    'services:',
    '  web:',
    '    image: nginx:1.27',
    '  sidecar:',
    '    image: busybox:1.36',
    '    platform: linux/amd64',
  ].join('\n');
  const svcRes = await api('/services', 'POST', {
    project_uuid: process.env.SMOKE_PROJECT_UUID,
    server_uuid: process.env.SMOKE_SERVER_UUID,
    environment_name: 'production',
    docker_compose_raw: Buffer.from(raw).toString('base64'),
    name: 'toolkit-smoke-stack',
    domain: 'http://toolkit-smoke-svc.test',
  });
  const svcUuid = (svcRes.json as { uuid?: string } | null)?.uuid;
  if (svcRes.status !== 200 || svcUuid == null) {
    throw new Error(`service create failed: http ${svcRes.status}`);
  }
  created.push({ kind: 'services', uuid: svcUuid });

  const kids = await api(`/services/${svcUuid}/applications`);
  const children = asList(kids.json);
  const web = children.find((c) => c.name === 'web');
  if (web != null) {
    await api(`/services/${svcUuid}/applications/${web.uuid}`, 'PATCH', { image: `nginx@${D_B}` });
    const after = await api(`/services/${svcUuid}/applications`);
    const list = asList(after.json);
    const webAfter = list.find((c) => c.name === 'web');
    const sidecarAfter = list.find((c) => c.name === 'sidecar');
    const svcAfter = await api(`/services/${svcUuid}`);
    const rawAfter = Buffer.from(
      String((svcAfter.json as { docker_compose_raw?: string } | null)?.docker_compose_raw ?? ''),
      'base64',
    ).toString('utf8');
    const checks: Array<[string, boolean]> = [
      ['web image written', webAfter?.image === `nginx@${D_B}`],
      ['sidecar untouched', sidecarAfter?.image === 'busybox:1.36'],
      ['raw contains target', rawAfter.includes(`nginx@${D_B}`)],
      ['raw sidecar intact', rawAfter.includes('busybox:1.36')],
    ];
    for (const [name, okc] of checks) {
      console.log(`${okc ? 'OK ' : 'FAIL'} ${name}`);
      if (!okc) failures += 1;
    }
    const st = await api(`/services/${svcUuid}/applications/${web.uuid}/start?latest=true`, 'POST');
    console.log(`targeted start: http ${st.status} (evidence level: queued-only)`);
  }
} catch (err) {
  failures += 1;
  console.error('smoke error:', err instanceof Error ? err.message : err);
} finally {
  await cleanup();
  console.log(`write smoke finished; failures=${failures}; created=${created.length}`);
  if (created.length > 0) {
    console.log('verify in Coolify UI that all toolkit-smoke-* resources are gone.');
  }
}
process.exit(failures > 0 ? 1 : 0);
