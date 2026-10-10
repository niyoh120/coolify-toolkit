// Responsive-layout fixture: serves the compiled web app from dist/web plus an
// in-memory /api/* mock with deliberately long names, full sha256 digests, long
// errors/domains/timezones and multi-page lists. Binds 127.0.0.1 only; unknown
// API paths fail loudly (recorded on the returned handle) so regressions that
// start calling new endpoints are caught instead of silently "passing".
// Pure Node (no deps), ESM. Test artifacts stay in the caller's temp dir.

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const HOST = '127.0.0.1';
const HEX = '0123456789abcdef';

function hex64(seed) {
  // Deterministic pseudo-random 64-hex-char digest from a string seed.
  let h = 2166136261;
  let out = '';
  for (let i = 0; i < 64; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619);
    out += HEX[(h >>> ((i % 8) * 4)) & 0xf];
  }
  return `sha256:${out}`;
}

function uuid(seed) {
  const h = hex64(seed).slice(7);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function makeResource(overrides = {}) {
  const id = overrides.id;
  const base = {
    id,
    kind: 'application',
    coolifyUuid: uuid(`res-${id}`),
    parentResourceId: null,
    parentName: null,
    name: `app-${id}`,
    composeServiceName: null,
    serverName: 'homelab-01',
    projectUuid: uuid(`proj-${id}`),
    checkCron: null,
    lastDeployedAt: '2025-05-01T08:00:00.000Z',
    environmentUuid: uuid(`env-${id}`),
    parentCoolifyUuid: null,
    projectName: 'homelab',
    environmentName: 'production',
    domains: null,
    currentImage: `docker.io/library/app-${id}:1.0.0@${hex64(`img-${id}`)}`,
    policy: 'manual',
    status: 'active',
    blockedReason: null,
    excludedInfra: false,
    isStopped: false,
    lastSyncedAt: '2025-05-01T07:00:00.000Z',
    updatedAt: '2025-05-01T07:30:00.000Z',
    track: null,
  };
  return { ...base, ...overrides };
}

function makeTrack(resourceId, overrides = {}) {
  return {
    id: resourceId,
    resourceId,
    sourceRegistry: 'docker.io',
    sourceRepository: `library/app-${resourceId}`,
    sourceTag: 'latest',
    targetPlatform: 'linux/amd64',
    platformSource: 'image',
    configuredReference: null,
    configuredDigest: hex64(`cfg-${resourceId}`),
    observedDigest: hex64(`obs-${resourceId}`),
    observedAt: '2025-05-01T06:00:00.000Z',
    upstreamTagUpdatedAt: '2025-04-28T12:00:00.000Z',
    observedReferenceKind: 'index',
    platformManifestDigest: hex64(`plat-${resourceId}`),
    lastSuccessfulDigest: hex64(`cfg-${resourceId}`),
    lastSuccessAt: '2025-05-01T08:05:00.000Z',
    lastSuccessDeploymentUuid: uuid(`dep-${resourceId}`),
    lastSuccessSource: 'deployment',
    pinnedAt: '2025-05-01T08:00:00.000Z',
    view: {
      configuredMatchesUpstream: false,
      hasCandidate: true,
      checkOutcome: 'candidate',
      deployState: 'success',
    },
    ...overrides,
  };
}

function makeJob(id, overrides = {}) {
  return {
    id,
    resourceId: 1,
    resourceName: 'app-1',
    resourceKind: 'application',
    kind: 'update',
    trigger: 'manual',
    candidateDigest: hex64(`cand-${id}`),
    candidateReference: `docker.io/library/app-1:latest@${hex64(`cand-${id}`)}`,
    priorDigest: hex64(`prior-${id}`),
    priorReference: `docker.io/library/app-1:1.0.0@${hex64(`prior-${id}`)}`,
    status: 'success',
    stage: 'done',
    deploymentUuid: uuid(`deploy-${id}`),
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    log: [
      { at: '2025-05-01T08:00:00.000Z', stage: 'queued', message: '任务进入队列' },
      {
        at: '2025-05-01T08:00:05.000Z',
        stage: 'deploy_submitted',
        message: `部署已提交：coolify.very-long-hostname-for-responsive-layout-testing.example.com 接受请求并返回部署 uuid ${uuid(`deploy-${id}`)}`,
      },
      { at: '2025-05-01T08:02:00.000Z', stage: 'done', message: '部署完成，摘要已固定' },
    ],
    createdAt: '2025-05-01T08:00:00.000Z',
    finishedAt: '2025-05-01T08:02:00.000Z',
    ...overrides,
  };
}

function makeNotification(id, overrides = {}) {
  return {
    id,
    eventType: 'candidate_found',
    resourceId: 1,
    resourceName: 'app-1',
    status: 'sent',
    attempts: 1,
    title: `发现候选更新：app-${id} 有新版本可`,
    body: `资源 app-${id}（服务器 homelab-server-cn-shanghai-01.internal.example.com）观察到新的上游摘要，请登录工具包确认后执行更新。完整说明：该候选由定时检查在 2025-05-01T06:00:00Z 发现，多架构 index 摘要已通过 platform manifest 校验。`,
    lastError: null,
    createdAt: '2025-05-01T06:00:00.000Z',
    sentAt: '2025-05-01T06:00:10.000Z',
    ...overrides,
  };
}

const LONG_NAME_A = 'very-long-application-name-for-responsive-layout-overflow-check';
const LONG_SERVER = 'homelab-server-cn-shanghai-01.internal.example.com';
const LONG_DOMAIN =
  'https://grafana.very-long-domain-name-for-responsive-layout-testing.example.com';
const LONG_ERROR =
  'registry.docker.io 在 30s 内未返回 manifest：Get "https://registry-1.docker.io/v2/library/app/manifests/latest": dial tcp 44.208.254.194:443 i/o timeout（重试 3 次后放弃，请检查网络或镜像代理配置）';

/** Build the full fictional dataset (fresh instance per call). */
function buildState() {
  let nextId = 1;
  const resources = [];
  const jobs = [];
  const notifications = [];
  const id = () => nextId++;

  // --- applications tab: 25 rows (2 pages at default page size 20) -------------
  // Short clean rows: compact-height assertion anchors.
  for (const name of ['redis', 'nginx', 'postgres']) {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name,
        track: makeTrack(rid, {
          sourceRepository: `library/${name}`,
          sourceTag: '7',
          view: {
            configuredMatchesUpstream: true,
            hasCandidate: false,
            checkOutcome: 'matching',
            deployState: 'success',
          },
          observedDigest: hex64(`cfg-${rid}`),
        }),
        policy: 'auto',
      }),
    );
  }
  // Long-name / long-server rows that force overflow in narrow windows.
  for (let i = 1; i <= 16; i++) {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: `${LONG_NAME_A}-${i}`,
        serverName: LONG_SERVER,
        domains: LONG_DOMAIN,
        track: makeTrack(rid, {
          sourceRepository: `team/very-long-repository-name-${i}`,
          sourceTag: 'release-2025.05',
        }),
        policy: i % 4 === 0 ? 'auto' : i % 3 === 0 ? 'notify' : 'manual',
      }),
    );
  }
  // Edge-case rows covering every status surface.
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-stopped',
        isStopped: true,
        blockedReason: 'stopped',
        track: makeTrack(rid),
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-external-change',
        blockedReason: 'external_change',
        track: makeTrack(rid),
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-excluded',
        excludedInfra: true,
        policy: 'ignore',
        track: makeTrack(rid),
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-unfixed',
        policy: 'notify',
        track: makeTrack(rid, {
          configuredDigest: null,
          configuredReference: null,
          view: {
            configuredMatchesUpstream: null,
            hasCandidate: true,
            checkOutcome: 'unfixed',
            deployState: 'unknown',
          },
        }),
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-no-tag',
        policy: 'notify',
        track: makeTrack(rid, {
          sourceTag: '',
          targetPlatform: null,
          view: {
            configuredMatchesUpstream: null,
            hasCandidate: false,
            checkOutcome: 'blocked',
            deployState: 'unknown',
          },
        }),
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-no-track',
        policy: 'ignore',
        currentImage: null,
        track: null,
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-check-error',
        policy: 'manual',
        track: makeTrack(rid, {
          view: {
            configuredMatchesUpstream: null,
            hasCandidate: false,
            checkOutcome: 'error',
            deployState: 'unknown',
          },
        }),
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-pending-confirmation',
        policy: 'manual',
        track: makeTrack(rid, {
          view: {
            configuredMatchesUpstream: false,
            hasCandidate: false,
            checkOutcome: 'matching',
            deployState: 'pending_confirmation',
          },
        }),
      }),
    );
  }

  // --- services tab: three compose parents (one huge for the modal test) -------
  const stackNames = ['stack-media-suite', 'stack-utils', 'stack-legacy'];
  for (const parentName of stackNames) {
    const pid = id();
    resources.push(
      makeResource({
        id: pid,
        kind: 'compose_service',
        name: parentName,
        serverName: LONG_SERVER,
        domains: LONG_DOMAIN,
        currentImage: null,
        track: null,
        policy: 'manual',
      }),
    );
  }
  const mediaParent = resources.find((r) => r.name === 'stack-media-suite');
  for (let i = 1; i <= 8; i++) {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        kind: 'service_application',
        name: `extremely-long-sub-container-name-media-component-${String(i).padStart(2, '0')}`,
        composeServiceName: `media-component-${i}`,
        parentResourceId: mediaParent.id,
        parentName: mediaParent.name,
        parentCoolifyUuid: mediaParent.coolifyUuid,
        serverName: LONG_SERVER,
        domains: LONG_DOMAIN,
        track: makeTrack(rid, {
          sourceRepository: `media/very-long-component-repository-${i}`,
          sourceTag: 'stable',
        }),
        policy: 'auto',
      }),
    );
  }
  const utilsParent = resources.find((r) => r.name === 'stack-utils');
  for (let i = 1; i <= 3; i++) {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        kind: 'service_application',
        name: `utils-child-${i}`,
        composeServiceName: `utils-child-${i}`,
        parentResourceId: utilsParent.id,
        parentName: utilsParent.name,
        parentCoolifyUuid: utilsParent.coolifyUuid,
        track: makeTrack(rid, {
          sourceRepository: `utils/tool-${i}`,
          view: {
            configuredMatchesUpstream: true,
            hasCandidate: false,
            checkOutcome: 'matching',
            deployState: 'success',
          },
          observedDigest: hex64(`cfg-${rid}`),
        }),
        policy: 'auto',
      }),
    );
  }
  // Orphan group: active child whose parent is not in the active list.
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        kind: 'service_application',
        name: 'orphan-child-of-removed-service',
        composeServiceName: 'orphan-child',
        parentResourceId: 9999,
        parentName: 'stack-removed-elsewhere',
        track: makeTrack(rid),
        policy: 'notify',
      }),
    );
  }
  const legacyParent = resources.find((r) => r.name === 'stack-legacy');
  for (let i = 1; i <= 2; i++) {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        kind: 'service_application',
        name: `legacy-child-${i}`,
        composeServiceName: `legacy-child-${i}`,
        parentResourceId: legacyParent.id,
        parentName: legacyParent.name,
        parentCoolifyUuid: legacyParent.coolifyUuid,
        track: makeTrack(rid, { sourceTag: 'edge' }),
        policy: 'manual',
      }),
    );
  }

  // --- jobs: 25 rows across statuses (>1 page), long errors, one awaiting -------
  for (let i = 1; i <= 25; i++) {
    const rid = resources[(i * 7) % resources.length];
    if (i === 3) {
      jobs.push(
        makeJob(id(), {
          resourceId: rid.id,
          resourceName: rid.name,
          status: 'unknown_submit',
          stage: 'awaiting_confirmation',
        }),
      );
    } else if (i === 5) {
      jobs.push(
        makeJob(id(), {
          resourceId: rid.id,
          resourceName: rid.name,
          status: 'failed',
          stage: 'deploy_submitted',
          errorCode: 'deploy_timeout',
          errorMessage: LONG_ERROR,
        }),
      );
    } else if (i % 4 === 0) {
      jobs.push(
        makeJob(id(), {
          resourceId: rid.id,
          resourceName: rid.name,
          status: 'failed',
          stage: 'patching',
          errorCode: 'coolify_api_422',
          errorMessage: `Coolify API 返回 422：deployment uuid 校验失败，服务器 ${LONG_SERVER} 的队列已满`,
        }),
      );
    } else if (i % 5 === 0) {
      jobs.push(
        makeJob(id(), {
          resourceId: rid.id,
          resourceName: rid.name,
          status: 'conflict',
          stage: 'revalidated',
          errorCode: 'external_change',
          errorMessage: '镜像引用在任务执行前被 Coolify 外部修改',
        }),
      );
    } else {
      jobs.push(makeJob(id(), { resourceId: rid.id, resourceName: rid.name }));
    }
  }

  // --- notifications: 25 rows (>1 page), long titles/bodies/errors --------------
  const events = [
    'candidate_found',
    'upstream_changed',
    'update_success',
    'update_failed',
    'submit_unknown',
  ];
  for (let i = 1; i <= 25; i++) {
    const rid = resources[(i * 5) % resources.length];
    const status =
      i % 6 === 0 ? 'failed' : i % 7 === 0 ? 'paused' : i % 3 === 0 ? 'pending' : 'sent';
    notifications.push(
      makeNotification(id(), {
        eventType: events[i % events.length],
        resourceId: rid.id,
        resourceName: rid.name,
        status,
        attempts: status === 'failed' ? 3 : 1,
        title: `【${events[i % events.length]}】${rid.name} 在 ${LONG_SERVER} 上发现候选更新，完整标题延续到很远以测试标题列的截断与展开行为 ${i}`,
        lastError:
          status === 'failed'
            ? `apprise 推送失败：POST https://apprise.internal.example.com/notify/very-long-path-for-layout-testing 返回 502 Bad Gateway（第 3 次尝试）`
            : null,
      }),
    );
  }

  const settings = {
    syncCron: '0 */6 * * *',
    checkCron: '*/30 * * * *',
    cronTimezone: 'Asia/Shanghai',
    globalPaused: true,
    deployConcurrency: 1,
    coolifyBaseUrlHost: 'coolify.very-long-hostname-for-responsive-layout-testing.example.com',
    coolifyConnected: true,
    coolifyVersion: '4.3.23',
    apprise: {
      configured: true,
      apiUrlHost: 'apprise.very-long-hostname-for-responsive-layout-testing.example.com',
      configKeyPresent: true,
      tag: 'all-homelab-servers-and-containers-very-long-tag',
      authConfigured: true,
      lastTestOk: false,
      lastTestAt: '2025-05-01T05:00:00.000Z',
      lastTestError: LONG_ERROR,
    },
  };

  const overview = () => {
    const managed = resources.filter((r) => r.policy === 'notify' || r.policy === 'auto').length;
    const candidates = resources.filter((r) => r.track?.view.hasCandidate === true).length;
    const failures = jobs.filter((j) =>
      ['failed', 'unknown_submit', 'conflict'].includes(j.status),
    ).length;
    const pending = resources.filter(
      (r) => r.track?.view.deployState === 'pending_confirmation',
    ).length;
    return {
      resourcesTotal: resources.length,
      resourcesManaged: managed,
      candidates,
      failures,
      pendingConfirmations: pending,
      lastSyncAt: '2025-05-01T07:00:00.000Z',
      lastCheckAt: '2025-05-01T06:00:00.000Z',
      globalPaused: settings.globalPaused,
    };
  };

  return { nextIdRef: { value: nextId }, resources, jobs, notifications, settings, overview };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function createResponsiveFixtureServer({ webRoot, host = '127.0.0.1', port = 0 }) {
  // 默认只绑回环（测试安全默认）；手动预览时可显式传 host/port 对外开放。
  const state = buildState();
  const unknownHits = [];
  let server = null;
  let url = null;

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw === '' ? {} : JSON.parse(raw);
  }

  function send(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  async function handleApi(req, res, pathname, query) {
    const method = req.method ?? 'GET';
    const seg = pathname.split('/').filter(Boolean); // ['api', ...]
    const json = (payload) => send(res, 200, payload);

    if (method === 'GET' && pathname === '/api/overview') return json(state.overview());
    if (method === 'GET' && pathname === '/api/settings') return json(state.settings);
    if (method === 'PATCH' && pathname === '/api/settings') {
      const body = await readBody(req);
      Object.assign(state.settings, body);
      if (body.cronTimezone != null) state.settings.cronTimezone = body.cronTimezone;
      return json({ ok: true });
    }
    if (method === 'POST' && pathname === '/api/sync') {
      return json({
        ok: true,
        sync: { resourcesSeen: state.resources.length, created: 0, externalChanges: 0, removed: 0 },
      });
    }
    if (method === 'POST' && pathname === '/api/check') {
      return json({ ok: true, checked: state.resources.filter((r) => r.track != null).length });
    }
    if (method === 'POST' && pathname === '/api/coolify/probe') {
      return json({ ok: true, version: state.settings.coolifyVersion });
    }
    if (method === 'POST' && pathname === '/api/notifications/test') return json({ ok: true });

    if (method === 'GET' && pathname === '/api/resources') {
      const kind = query.get('kind');
      const policy = query.get('policy');
      const status = query.get('status') ?? 'active';
      const parent = query.get('parent');
      const rows = state.resources
        .filter((r) => (status === 'all' ? true : r.status === status))
        .filter((r) => (kind == null || kind === '' ? true : r.kind === kind))
        .filter((r) => (policy == null || policy === '' ? true : r.policy === policy))
        .filter((r) =>
          parent == null || parent === '' ? true : String(r.parentResourceId) === parent,
        );
      return json({ resources: rows });
    }
    if (method === 'POST' && pathname === '/api/resources/batch-policy') {
      const body = await readBody(req);
      let updated = 0;
      for (const r of state.resources) {
        if (body.resourceIds.includes(r.id)) {
          r.policy = body.policy;
          updated += 1;
        }
      }
      return json({ updated });
    }

    // /api/resources/:id[...]
    if (seg[0] === 'api' && seg[1] === 'resources' && seg.length >= 3) {
      const rid = Number.parseInt(seg[2], 10);
      const resource = state.resources.find((r) => r.id === rid);
      if (resource == null)
        return send(res, 404, {
          error: { code: 'not_found', message: `resource ${seg[2]} not found` },
        });
      const rest = seg.slice(3).join('/');
      if (rest === '' && method === 'GET') {
        return json({
          resource,
          jobs: state.jobs.filter((j) => j.resourceId === rid).slice(0, 50),
        });
      }
      if (rest === '' && method === 'PATCH') {
        const body = await readBody(req);
        if (body.policy != null) resource.policy = body.policy;
        if (body.sourceTag != null && resource.track != null)
          resource.track.sourceTag = body.sourceTag;
        if (body.checkCron !== undefined) resource.checkCron = body.checkCron;
        if (body.targetPlatform !== undefined && resource.track != null)
          resource.track.targetPlatform = body.targetPlatform;
        return json({ resource });
      }
      if (rest === 'deploy-time' && method === 'GET') {
        return json({ lastDeployedAt: resource.lastDeployedAt });
      }
      if (rest === 'check' && method === 'POST') {
        if (resource.track == null) {
          return json({
            check: {
              resourceId: rid,
              outcome: 'blocked',
              observedDigest: null,
              candidate: false,
              message: '无镜像追踪',
            },
          });
        }
        resource.track.observedDigest = hex64(`obs2-${rid}`);
        resource.track.view = {
          configuredMatchesUpstream: false,
          hasCandidate: true,
          checkOutcome: 'candidate',
          deployState: resource.track.view.deployState,
        };
        return json({
          check: {
            resourceId: rid,
            outcome: 'candidate',
            observedDigest: resource.track.observedDigest,
            candidate: true,
            message: null,
          },
        });
      }
      if (rest === 'preview' && method === 'POST') {
        if (resource.track == null || resource.track.observedDigest == null) {
          return json({ preview: null, message: '无更新' });
        }
        return json({
          preview: {
            candidateDigest: resource.track.observedDigest,
            candidateReference: `${resource.track.sourceRegistry}/${resource.track.sourceRepository}:${resource.track.sourceTag}@${resource.track.observedDigest}`,
            observedAt: resource.track.observedAt,
            referenceKind: 'index',
            previewToken: `tok-${rid}-${resource.track.observedDigest.slice(7, 19)}`,
            impact: {
              kind: resource.kind === 'service_application' ? 'compose_child' : 'application',
              parentName: resource.parentName,
              note: `将更新 ${resource.parentName ?? resource.name} 的镜像引用并触发 Coolify 重新部署；同服务后续任务会排队等待人工确认。`,
            },
          },
        });
      }
      if (rest === 'update' && method === 'POST') {
        const body = await readBody(req);
        const track = resource.track;
        if (track == null || track.observedDigest == null)
          return json({ skipped: true, message: '无更新' });
        const candidate = body.skipPreview === true ? track.observedDigest : body.candidateDigest;
        const job = makeJob(state.nextIdRef.value++, {
          resourceId: rid,
          resourceName: resource.name,
          resourceKind: resource.kind,
          kind: track.configuredDigest == null ? 'initial_pin' : 'update',
          candidateDigest: candidate,
          candidateReference: `${track.sourceRegistry}/${track.sourceRepository}:${track.sourceTag}@${candidate}`,
          priorDigest: track.configuredDigest,
          status: 'pending',
          stage: 'queued',
          deploymentUuid: null,
          log: [{ at: new Date().toISOString(), stage: 'queued', message: '任务进入队列' }],
        });
        state.jobs.unshift(job);
        track.configuredDigest = candidate;
        track.configuredReference = job.candidateReference;
        track.view = {
          configuredMatchesUpstream: true,
          hasCandidate: false,
          checkOutcome: 'matching',
          deployState: 'deploying',
        };
        return json({ job });
      }
    }

    // /api/jobs/...
    if (method === 'GET' && pathname === '/api/jobs') {
      const statusParam = query.get('status');
      const statuses =
        statusParam == null || statusParam === 'all' || statusParam === ''
          ? []
          : statusParam.split(',');
      const rows =
        statuses.length === 0 ? state.jobs : state.jobs.filter((j) => statuses.includes(j.status));
      return json({ jobs: rows });
    }
    if (seg[0] === 'api' && seg[1] === 'jobs' && seg.length >= 4) {
      const jid = Number.parseInt(seg[2], 10);
      const job = state.jobs.find((j) => j.id === jid);
      if (job == null)
        return send(res, 404, { error: { code: 'not_found', message: `job ${seg[2]} not found` } });
      if (seg[3] === 'retry' && method === 'POST') {
        job.status = 'pending';
        job.stage = 'queued';
        job.attempts += 1;
        return json({ job });
      }
      if (seg[3] === 'confirm' && method === 'POST') {
        job.stage = 'done';
        job.status = 'success';
        return json({ job });
      }
    }

    // /api/notifications/...
    if (method === 'GET' && pathname === '/api/notifications') {
      return json({
        notifications: state.notifications,
        appriseConfigured: state.settings.apprise.configured,
      });
    }
    if (
      seg[0] === 'api' &&
      seg[1] === 'notifications' &&
      seg.length >= 4 &&
      seg[3] === 'redeliver' &&
      method === 'POST'
    ) {
      const nid = Number.parseInt(seg[2], 10);
      const n = state.notifications.find((x) => x.id === nid);
      if (n == null)
        return send(res, 404, {
          error: { code: 'not_found', message: `notification ${seg[2]} not found` },
        });
      n.status = 'pending';
      n.attempts += 1;
      return json({ ok: true });
    }

    unknownHits.push(`${method} ${pathname}`);
    send(res, 404, {
      error: {
        code: 'fixture_unknown_endpoint',
        message: `fixture does not implement ${method} ${pathname}`,
      },
    });
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const abs = path.resolve(webRoot, rel);
    if (abs !== webRoot && !abs.startsWith(webRoot + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await readFile(abs);
      res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  return {
    get url() {
      return url;
    },
    /** Paths the browser requested that the fixture does not implement. */
    get unknownHits() {
      return unknownHits;
    },
    start() {
      return new Promise((resolve, reject) => {
        server = createServer(async (req, res) => {
          try {
            const parsed = new URL(req.url ?? '/', `http://${HOST}`);
            if (parsed.pathname === '/api' || parsed.pathname.startsWith('/api/')) {
              await handleApi(req, res, parsed.pathname, parsed.searchParams);
            } else if (req.method === 'GET') {
              await serveStatic(res, parsed.pathname);
            } else {
              res.writeHead(405).end();
            }
          } catch (err) {
            unknownHits.push(
              `handler_error ${req.url}: ${err instanceof Error ? err.message : String(err)}`,
            );
            send(res, 500, { error: { code: 'fixture_error', message: String(err) } });
          }
        });
        server.on('error', reject);
        server.listen(port, host, () => {
          const boundPort = server.address().port;
          url = `http://${host === '0.0.0.0' || host === '::' ? HOST : host}:${boundPort}`;
          resolve({ port: boundPort, url, close: () => new Promise((done) => server.close(done)) });
        });
      });
    },
  };
}
