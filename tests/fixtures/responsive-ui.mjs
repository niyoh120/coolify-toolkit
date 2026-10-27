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
    // fixture 代表「已同步资源」：显式已分类，默认值不掩盖真实状态。
    managementClassified: true,
    imageIssue: null,
    exclusionSource: null,
    lastSyncedAt: '2025-05-01T07:00:00.000Z',
    updatedAt: '2025-05-01T07:30:00.000Z',
    track: null,
    pendingConfirmation: null,
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
  // 成功证据来源只属于成功/运行中（等待确认）的任务；失败与冲突行不带徽标。
  const status = overrides.status ?? 'success';
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
    confirmationDueAt: null,
    successSource:
      overrides.successSource ??
      (status === 'success' || status === 'running' ? 'deployment' : null),
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
        exclusionSource: 'self',
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
        name: 'edge-pending-sync',
        // 待同步确认：历史记录尚未分类，配置只读、默认视图可见。
        managementClassified: false,
        policy: 'notify',
        track: makeTrack(rid),
      }),
    );
  }
  const pendingSyncRow = resources.find((r) => r.name === 'edge-pending-sync');
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-image-issue',
        currentImage: 'gcr.io/fictional/chrome:latest',
        imageIssue: { code: 'unsupported_registry', registry: 'gcr.io' },
        policy: 'manual',
        track: null,
      }),
    );
  }
  {
    const rid = id();
    resources.push(
      makeResource({
        id: rid,
        name: 'edge-var-image',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 字面量测试数据
        currentImage: '${WEB_IMAGE}',
        imageIssue: { code: 'unresolved_variable', registry: null },
        policy: 'manual',
        track: null,
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
        track: makeTrack(
          rid,
          i <= 2
            ? {
                sourceRepository: `media/very-long-component-repository-${i}`,
                sourceTag: 'stable',
                view: {
                  configuredMatchesUpstream: true,
                  hasCandidate: false,
                  checkOutcome: 'matching',
                  deployState: 'pending_confirmation',
                },
              }
            : {
                sourceRepository: `media/very-long-component-repository-${i}`,
                sourceTag: 'stable',
              },
        ),
        policy: 'auto',
        pendingConfirmation:
          i <= 2
            ? {
                jobId: 900000 + i,
                candidateDigest: hex64(`pend-${rid}`),
                confirmationDueAt: '2025-05-01T08:01:30.000Z',
              }
            : null,
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
  // --- services pagination: 22 more small groups (3 pages at page size 10) -----
  // Name sort lands between stack-media-suite and stack-utils, so earlier
  // scenarios that address stack-media-suite by name keep working.
  for (let i = 1; i <= 22; i++) {
    const num = String(i).padStart(2, '0');
    const pid = id();
    resources.push(
      makeResource({
        id: pid,
        kind: 'compose_service',
        name: `stack-page-${num}`,
        serverName: 'homelab-01',
        currentImage: null,
        track: null,
        policy: 'auto',
      }),
    );
    const cid = id();
    resources.push(
      makeResource({
        id: cid,
        kind: 'service_application',
        name: `page-child-${num}`,
        composeServiceName: `page-child-${num}`,
        parentResourceId: pid,
        parentName: `stack-page-${num}`,
        parentCoolifyUuid: uuid(`res-${pid}`),
        serverName: 'homelab-01',
        track: makeTrack(cid, {
          sourceRepository: `page/tool-${num}`,
          view: {
            configuredMatchesUpstream: true,
            hasCandidate: false,
            checkOutcome: 'matching',
            deployState: 'success',
          },
          observedDigest: hex64(`cfg-${cid}`),
        }),
        policy: 'auto',
      }),
    );
  }
  // pendingConfirmation carriers must have matching live jobs so the confirm
  // endpoint can succeed (mirrors the real server contract).
  for (const pendChild of resources.filter((r) => r.pendingConfirmation != null)) {
    jobs.push(
      makeJob(pendChild.pendingConfirmation.jobId, {
        resourceId: pendChild.id,
        resourceName: pendChild.name,
        resourceKind: 'service_application',
        candidateDigest: pendChild.pendingConfirmation.candidateDigest,
        status: 'running',
        stage: 'awaiting_confirmation',
        deploymentUuid: null,
        successSource: null,
        confirmationDueAt: pendChild.pendingConfirmation.confirmationDueAt,
      }),
    );
  }
  for (let i = 1; i <= 25; i++) {
    const rid = resources[(i * 7) % resources.length];
    if (i === 3) {
      jobs.push(
        makeJob(id(), {
          resourceId: rid.id,
          resourceName: rid.name,
          status: 'running',
          stage: 'awaiting_confirmation',
          deploymentUuid: null,
          successSource: null,
          confirmationDueAt: '2025-05-01T08:01:30.000Z',
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
  // 待同步确认资源的 failed 任务：验证升级过渡期重试被 409 拒绝且给出可见反馈。
  if (pendingSyncRow != null) {
    jobs.push(
      makeJob(id(), {
        resourceId: pendingSyncRow.id,
        resourceName: pendingSyncRow.name,
        status: 'failed',
        stage: 'deploy_submitted',
        errorCode: 'deploy_timeout',
        errorMessage: LONG_ERROR,
      }),
    );
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
    const pending = resources.filter((r) => r.pendingConfirmation != null).length;
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

  // 真实后端任务列表按 id 倒序返回（desc update_jobs.id）；fixture 保持一致，
  // 让最新种子任务（含待同步资源的 failed 任务）落在历史页第一页。
  jobs.sort((a, b) => b.id - a.id);
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
  // 恢复场景的运行时控制（默认全关）。仅供 verify-responsive 脚本通过
  // POST /api/__fixture/resources-control 调整；页面自身永不触碰。
  const resourceControl = {
    delayMs: 0,
    failRequests: 0,
    shrinkTo: null,
  };
  // 采纳场景控制：预览强制失败 / 确认延迟（仅 verify-responsive 经控制端点调整）。
  const adoptControl = {
    forceError: false,
    confirmDelayMs: 0,
  };
  // 操作反馈场景控制（仅 verify-responsive 经控制端点调整）：
  // sync：可控延迟 + JSON 502 / HTML 503 / 限流 / 网络拒绝；probe：业务失败。
  const syncControl = {
    delayMs: 0,
    mode: 'ok', // 'ok' | 'json502' | 'html503' | 'rate-limit' | 'rate-limit-no-retry' | 'network'
    hits: 0,
  };
  const probeControl = { ok: true };
  const notifControl = { redeliverOk: true, notifyTestOk: true };
  const settingsControl = { failSave: false };
  const updateHits = [];
  let resourcesGetHits = 0;
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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function handleApi(req, res, pathname, query) {
    const method = req.method ?? 'GET';
    const seg = pathname.split('/').filter(Boolean); // ['api', ...]
    const json = (payload) => send(res, 200, payload);

    // 测试控制端点：调整资源列表响应行为（延迟/强制失败/数据缩水）。
    if (pathname === '/api/__fixture/adopt-control') {
      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body.forceError === 'boolean') adoptControl.forceError = body.forceError;
        if (typeof body.confirmDelayMs === 'number')
          adoptControl.confirmDelayMs = Math.max(0, Math.floor(body.confirmDelayMs));
      }
      return json({ control: adoptControl });
    }
    if (pathname === '/api/__fixture/resources-control') {
      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body.delayMs === 'number') resourceControl.delayMs = Math.max(0, body.delayMs);
        if (typeof body.failRequests === 'number')
          resourceControl.failRequests = Math.max(0, Math.floor(body.failRequests));
        if ('shrinkTo' in body) {
          resourceControl.shrinkTo =
            typeof body.shrinkTo === 'number' ? Math.max(0, Math.floor(body.shrinkTo)) : null;
        }
      }
      return json({
        control: {
          delayMs: resourceControl.delayMs,
          failRequests: resourceControl.failRequests,
          shrinkTo: resourceControl.shrinkTo,
          getHits: resourcesGetHits,
        },
      });
    }

    if (pathname === '/api/__fixture/sync-control') {
      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body.delayMs === 'number') syncControl.delayMs = Math.max(0, body.delayMs);
        if (typeof body.mode === 'string') syncControl.mode = body.mode;
        if (body.resetHits === true) syncControl.hits = 0;
      }
      return json({ control: { ...syncControl, hits: syncControl.hits } });
    }
    if (pathname === '/api/__fixture/update-hits') {
      return json({ hits: updateHits.length });
    }
    if (pathname === '/api/__fixture/action-control') {
      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body.probeOk === 'boolean') probeControl.ok = body.probeOk;
        if (typeof body.redeliverOk === 'boolean') notifControl.redeliverOk = body.redeliverOk;
        if (typeof body.notifyTestOk === 'boolean') notifControl.notifyTestOk = body.notifyTestOk;
      }
      return json({
        control: {
          probeOk: probeControl.ok,
          redeliverOk: notifControl.redeliverOk,
          notifyTestOk: notifControl.notifyTestOk,
        },
      });
    }
    if (pathname === '/api/__fixture/settings-control') {
      if (method === 'POST') {
        const body = await readBody(req);
        if (typeof body.failSave === 'boolean') settingsControl.failSave = body.failSave;
      }
      return json({ control: { failSave: settingsControl.failSave } });
    }

    if (method === 'GET' && pathname === '/api/overview') return json(state.overview());
    if (method === 'GET' && pathname === '/api/settings') return json(state.settings);
    if (method === 'PATCH' && pathname === '/api/settings') {
      const body = await readBody(req);
      // 可控保存失败：模拟服务端 cron 校验拒绝（先校验后落库，坏值不落库）。
      if (settingsControl.failSave) {
        return send(res, 400, {
          error: { code: 'validation_error', message: 'Invalid cron expression or timezone' },
        });
      }
      Object.assign(state.settings, body);
      if (body.cronTimezone != null) state.settings.cronTimezone = body.cronTimezone;
      return json({ ok: true });
    }
    if (method === 'POST' && pathname === '/api/sync') {
      // 可控故障：JSON 502 / HTML 503 / 限流（带或不带 Retry-After）/ 网络拒绝；
      // hits 计数供脚本断言「快速重复点击只产生一个请求」。
      syncControl.hits += 1;
      if (syncControl.delayMs > 0) await sleep(syncControl.delayMs);
      if (syncControl.mode === 'json502') {
        return send(res, 502, {
          error: { code: 'coolify_unavailable', message: 'fixture: coolify upstream failed' },
        });
      }
      if (syncControl.mode === 'html503') {
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>503 Service Unavailable</body></html>');
        return;
      }
      if (syncControl.mode === 'rate-limit' || syncControl.mode === 'rate-limit-no-retry') {
        const headers = { 'content-type': 'application/json; charset=utf-8' };
        if (syncControl.mode === 'rate-limit') headers['retry-after'] = '45';
        res.writeHead(503, headers);
        res.end(
          JSON.stringify({
            error: {
              code: 'coolify_rate_limited',
              message: 'Coolify /applications?page=0: Too Many Attempts.',
              details:
                syncControl.mode === 'rate-limit'
                  ? { upstreamStatus: 429, retryAfterSeconds: 45 }
                  : { upstreamStatus: 429 },
            },
          }),
        );
        return;
      }
      if (syncControl.mode === 'network') {
        res.destroy();
        return;
      }
      const partial =
        syncControl.mode === 'partial'
          ? {
              resourcesSeen: state.resources.length,
              created: 0,
              externalChanges: 0,
              removed: 0,
              errors: ['service svc-edge-1: child list failed: fixture forced'],
            }
          : {
              resourcesSeen: state.resources.length,
              created: 0,
              externalChanges: 0,
              removed: 0,
              errors: [],
            };
      return json({ ok: true, sync: partial });
    }
    if (method === 'POST' && pathname === '/api/check') {
      return json({ ok: true, checked: state.resources.filter((r) => r.track != null).length });
    }
    if (method === 'POST' && pathname === '/api/coolify/probe') {
      if (probeControl.ok) return json({ ok: true, version: state.settings.coolifyVersion });
      return json({ ok: false, version: null });
    }
    if (method === 'POST' && pathname === '/api/notifications/test') {
      // 可控测试通知：失败时模拟服务端行为（先落库 lastTestOk=false，再抛 502）。
      if (!notifControl.notifyTestOk) {
        state.settings.apprise.lastTestOk = false;
        state.settings.apprise.lastTestAt = new Date().toISOString();
        state.settings.apprise.lastTestError = 'fixture: apprise unreachable';
        return send(res, 502, {
          error: { code: 'apprise_error', message: 'fixture: apprise unreachable' },
        });
      }
      state.settings.apprise.lastTestOk = true;
      state.settings.apprise.lastTestAt = new Date().toISOString();
      state.settings.apprise.lastTestError = null;
      return json({ ok: true });
    }

    if (method === 'GET' && pathname === '/api/resources') {
      resourcesGetHits += 1;
      // 恢复场景控制：强制失败（覆盖 react-query 的 1 次重试需连续两次）→ 延迟 → 缩水。
      if (resourceControl.failRequests > 0) {
        resourceControl.failRequests -= 1;
        return send(res, 503, {
          error: { code: 'fixture_forced_failure', message: '恢复场景强制失败的资源列表请求' },
        });
      }
      if (resourceControl.delayMs > 0) await sleep(resourceControl.delayMs);
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
      const limited =
        resourceControl.shrinkTo == null ? rows : rows.slice(0, resourceControl.shrinkTo);
      return json({ resources: limited });
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
      if (rest === 'adopt-preview' && method === 'POST') {
        if (resource.track == null)
          return send(res, 409, { error: { code: 'blocked', message: '无镜像追踪' } });
        const body = await readBody(req);
        if (adoptControl.forceError === true) {
          return send(res, 502, {
            error: { code: 'registry_error', message: 'fixture 强制失败的采纳预览' },
          });
        }
        const tag = body.sourceTag ?? resource.track.sourceTag ?? 'latest';
        const digest = hex64(`adopt-${rid}-${tag}`);
        return json({
          preview: {
            liveReference:
              resource.currentImage ??
              `${resource.track.sourceRegistry}/${resource.track.sourceRepository}:${tag}`,
            configuredReference: resource.track.configuredReference,
            configuredDigest: resource.track.configuredDigest,
            channel: {
              source: body.sourceTag != null ? 'user_tag' : 'live',
              registry: resource.track.sourceRegistry,
              repository: resource.track.sourceRepository,
              repositoryAuthored: `${resource.track.sourceRegistry}/${resource.track.sourceRepository}`,
              tag,
            },
            targetReference: `${resource.track.sourceRegistry}/${resource.track.sourceRepository}:${tag}@${digest}`,
            targetDigest: digest,
            referenceKind: 'index',
            resolvedAt: new Date().toISOString(),
            platform: resource.track.targetPlatform,
            impact: {
              kind: resource.kind === 'service_application' ? 'compose_child' : 'application',
              parentName: resource.parentName,
              note: '采纳后创建一条普通更新任务，按既有执行器部署。',
            },
            previewToken: `adopt-tok-${rid}-${tag}`,
          },
        });
      }
      if (rest === 'adopt' && method === 'POST') {
        const body = await readBody(req);
        if (adoptControl.confirmDelayMs > 0) await sleep(adoptControl.confirmDelayMs);
        if (resource.track == null)
          return send(res, 409, { error: { code: 'blocked', message: '无镜像追踪' } });
        if (
          body.previewToken == null ||
          !String(body.previewToken).startsWith(`adopt-tok-${rid}-`)
        ) {
          return send(res, 409, {
            error: { code: 'conflict', message: '采纳预览已过期或不匹配；请重新预览' },
          });
        }
        const tag = String(body.previewToken).split('-').pop();
        const digest = hex64(`adopt-${rid}-${tag}`);
        resource.track.sourceTag = tag;
        resource.track.trackingRevision = (resource.track.trackingRevision ?? 0) + 1;
        resource.track.observedDigest = digest;
        resource.track.configuredReference = `${resource.track.sourceRegistry}/${resource.track.sourceRepository}:${tag}@${digest}`;
        resource.track.configuredDigest = digest;
        resource.track.view = {
          configuredMatchesUpstream: true,
          hasCandidate: false,
          checkOutcome: 'matching',
          deployState: 'success',
        };
        if (resource.blockedReason === 'external_change') resource.blockedReason = null;
        return json({
          status: 'skipped',
          message: '已采纳当前镜像为新追踪渠道；现场摘要已与该渠道一致，无需部署。',
          job: null,
          resource,
        });
      }
      if (rest === 'reset-tracking' && method === 'POST') {
        if (resource.track == null)
          return send(res, 409, { error: { code: 'blocked', message: '无镜像追踪' } });
        resource.policy = 'ignore';
        resource.track.configuredReference = null;
        resource.track.configuredDigest = null;
        resource.track.observedDigest = null;
        resource.track.lastSuccessfulDigest = null;
        resource.track.lastSuccessAt = null;
        resource.track.pinnedAt = null;
        resource.track.view = {
          configuredMatchesUpstream: null,
          hasCandidate: false,
          checkOutcome: 'unfixed',
          deployState: 'unknown',
        };
        if (
          resource.blockedReason === 'external_change' ||
          resource.blockedReason === 'update_failed'
        ) {
          resource.blockedReason = null;
        }
        return json({
          resource,
          message: '已重置追踪并忽略：后续检查与自动初始化暂停，Coolify 配置与任务历史保留。',
        });
      }
      if (rest === 'update' && method === 'POST') {
        updateHits.push(rid);
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
        job.successSource = null;
        job.confirmationDueAt = null;
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
        // 升级过渡守卫：待同步确认（未分类）资源的重试拒绝并返回 409，
        // 与服务端 JobsService.retryJob 行为一致。
        const owner = state.resources.find((r) => r.id === job.resourceId);
        if (owner != null && owner.managementClassified === false) {
          return send(res, 409, {
            error: {
              code: 'blocked',
              message: '待同步确认：完成一次资源同步后才能确定管理状态',
            },
          });
        }
        job.status = 'pending';
        job.stage = 'queued';
        job.attempts += 1;
        return json({ job });
      }
      if (seg[3] === 'confirm' && method === 'POST') {
        job.stage = 'done';
        job.status = 'success';
        job.successSource = 'manual';
        job.confirmationDueAt = null;
        // Mirror the server: the confirmed task leaves the pending set.
        const owner = state.resources.find((r) => r.pendingConfirmation?.jobId === job.id);
        if (owner != null) {
          owner.pendingConfirmation = null;
          if (owner.track?.view != null) owner.track.view.deployState = 'success';
        }
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
      if (notifControl.redeliverOk) return json({ ok: true });
      return json({ ok: false });
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
    /** /api/sync 请求计数：断言「重复点击只产生一个请求」用。 */
    get syncHits() {
      return syncControl.hits;
    },
    /** /api/resources/:id/update POST 计数：断言写操作确实发生。 */
    get updateHits() {
      return updateHits.length;
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
