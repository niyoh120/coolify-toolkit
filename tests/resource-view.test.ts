// Pure view-model tests for the resources pages: service grouping, filtering,
// pagination, selection and outcome summaries. Plain fixtures, no DOM.

import { describe, expect, it } from 'vitest';
import type { ResourceDTO, TrackDTO, TrackView } from '../src/shared/types.js';
import {
  buildServiceGroups,
  checkBlockedHint,
  checkOutcomeFeedback,
  childNeedsAttention,
  classifyCheckOutcome,
  filterServiceGroups,
  groupSummary,
  managementReason,
  managementReasonDetail,
  paginateGroups,
  policyTone,
  projectGroupsForView,
  type ServiceFilters,
  selectableChildIds,
  selectionState,
  serviceServerNames,
  summarizeBatchChecks,
  summarizeBatchUpdates,
  updateBlockedHint,
} from '../src/web/lib/resource-view.js';

function trackView(over: Partial<TrackView> = {}): TrackView {
  return {
    configuredMatchesUpstream: true,
    hasCandidate: false,
    checkOutcome: 'matching',
    deployState: 'unknown',
    ...over,
  };
}

function track(over: Partial<TrackDTO> = {}): TrackDTO {
  return {
    id: 1,
    resourceId: 1,
    sourceRegistry: 'docker.io',
    sourceRepository: 'library/nginx',
    sourceTag: '1.27',
    targetPlatform: 'linux/amd64',
    platformSource: 'node',
    configuredReference: 'library/nginx:1.27',
    configuredDigest: `sha256:${'a'.repeat(64)}`,
    observedDigest: `sha256:${'a'.repeat(64)}`,
    observedAt: null,
    upstreamTagUpdatedAt: null,
    observedReferenceKind: null,
    platformManifestDigest: null,
    lastSuccessfulDigest: null,
    lastSuccessAt: null,
    lastSuccessDeploymentUuid: null,
    lastSuccessSource: null,
    pinnedAt: null,
    view: trackView(),
    ...over,
  };
}

let seq = 0;
function dto(over: Partial<ResourceDTO> & Pick<ResourceDTO, 'id' | 'name'>): ResourceDTO {
  seq += 1;
  return {
    kind: 'service_application',
    coolifyUuid: `uuid-${over.id ?? seq}`,
    parentResourceId: null,
    parentName: null,
    composeServiceName: null,
    serverName: 'node-a',
    projectUuid: null,
    checkCron: null,
    lastDeployedAt: null,
    environmentUuid: null,
    parentCoolifyUuid: null,
    projectName: 'proj',
    environmentName: 'prod',
    domains: null,
    currentImage: null,
    policy: 'notify',
    status: 'active',
    blockedReason: null,
    excludedInfra: false,
    isStopped: false,
    managementClassified: true,
    imageIssue: null,
    exclusionSource: null,
    lastSyncedAt: null,
    updatedAt: null,
    track: null,
    ...over,
  };
}

/** Two same-name services, an orphan parent and a standalone application. */
function fixture(): ResourceDTO[] {
  const svcA = dto({ id: 1, name: 'stack', kind: 'compose_service', serverName: 'node-a' });
  const svcB = dto({ id: 2, name: 'stack', kind: 'compose_service', serverName: 'node-b' });
  const childWeb = dto({
    id: 11,
    name: 'web',
    parentResourceId: 1,
    parentName: 'stack',
    currentImage: 'nginx:1.27',
    track: track({
      resourceId: 11,
      view: trackView({ hasCandidate: true, checkOutcome: 'candidate' }),
      observedDigest: `sha256:${'b'.repeat(64)}`,
    }),
  });
  const childDb = dto({
    id: 12,
    name: 'db',
    parentResourceId: 1,
    parentName: 'stack',
    policy: 'ignore',
  });
  const childCache = dto({
    id: 13,
    name: 'cache',
    parentResourceId: 1,
    parentName: 'stack',
    track: track({
      resourceId: 13,
      targetPlatform: null,
      view: trackView({ checkOutcome: 'blocked' }),
    }),
  });
  const childApi = dto({
    id: 21,
    name: 'api',
    parentResourceId: 2,
    parentName: 'stack',
    currentImage: 'api:v2',
    track: track({
      resourceId: 21,
      view: trackView({ hasCandidate: true, checkOutcome: 'candidate' }),
    }),
  });
  const orphanChild = dto({
    id: 31,
    name: 'lost',
    parentResourceId: 99,
    parentName: 'gone-service',
  });
  const app = dto({ id: 5, name: 'solo', kind: 'application' });
  return [svcA, svcB, childWeb, childDb, childCache, childApi, orphanChild, app];
}

const NO_FILTERS: ServiceFilters = {
  search: '',
  policy: '',
  managed: 'all',
  status: 'all',
  server: '',
};

describe('service group view model', () => {
  it('groups by parent id so same-name services stay independent; orphan group trails', () => {
    const groups = buildServiceGroups(fixture());
    expect(groups.map((g) => g.key)).toEqual(['svc-1', 'svc-2', 'orphan-99']);
    expect(groups[0]?.children.map((c) => c.name)).toEqual(['cache', 'db', 'web']);
    expect(groups[1]?.children.map((c) => c.name)).toEqual(['api']);
    expect(groups[2]).toMatchObject({ orphan: true, parent: null, parentName: 'gone-service' });
    // application rows never join service grouping
    expect(groups.flatMap((g) => g.children.map((c) => c.id))).not.toContain(5);
  });

  it('search on child name keeps only the matching group header and children', () => {
    const groups = buildServiceGroups(fixture());
    const filtered = filterServiceGroups(groups, { ...NO_FILTERS, search: 'web' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.group.key).toBe('svc-1');
    expect(filtered[0]?.visibleChildren.map((c) => c.name)).toEqual(['web']);
  });

  it('search on service name keeps the whole group with condition-passing children', () => {
    const groups = buildServiceGroups(fixture());
    const filtered = filterServiceGroups(groups, { ...NO_FILTERS, search: 'stack' });
    expect(filtered.map((g) => g.group.key)).toEqual(['svc-1', 'svc-2']);
    expect(filtered[0]?.visibleChildren).toHaveLength(3);
  });

  it('policy filter evaluates on child fields and drops groups without matches', () => {
    const groups = buildServiceGroups(fixture());
    const filtered = filterServiceGroups(groups, { ...NO_FILTERS, policy: 'ignore' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.group.key).toBe('svc-1');
    expect(filtered[0]?.visibleChildren.map((c) => c.name)).toEqual(['db']);
  });

  it('server filter prefers the parent service field', () => {
    const groups = buildServiceGroups(fixture());
    const filtered = filterServiceGroups(groups, { ...NO_FILTERS, server: 'node-b' });
    expect(filtered.map((g) => g.group.key)).toEqual(['svc-2']);
    expect(serviceServerNames(groups)).toEqual(['node-a', 'node-b']);
  });

  it('empty services survive only without child-scoped conditions', () => {
    const resources = [
      dto({ id: 1, name: 'empty-svc', kind: 'compose_service' }),
      dto({ id: 2, name: 'full-svc', kind: 'compose_service' }),
      dto({ id: 12, name: 'worker', parentResourceId: 2, parentName: 'full-svc' }),
    ];
    const groups = buildServiceGroups(resources);
    const plain = filterServiceGroups(groups, NO_FILTERS);
    expect(plain.map((g) => g.group.key)).toEqual(['svc-1', 'svc-2']);
    const policySet = filterServiceGroups(groups, { ...NO_FILTERS, policy: 'notify' });
    expect(policySet.map((g) => g.group.key)).toEqual(['svc-2']);
    // 搜索命中空服务名 → 保留空组；未命中 → 隐藏。
    const hit = filterServiceGroups(groups, { ...NO_FILTERS, search: 'empty-svc' });
    expect(hit.map((g) => g.group.key)).toEqual(['svc-1']);
    const miss = filterServiceGroups(groups, { ...NO_FILTERS, search: 'no-match' });
    expect(miss).toEqual([]);
  });

  it('policyTone maps all policies to shared badge tones', () => {
    expect(policyTone('auto')).toBe('accent');
    expect(policyTone('notify')).toBe('info');
    expect(policyTone('manual')).toBe('info');
    expect(policyTone('ignore')).toBe('neutral');
  });

  it('paginates whole groups so a service and its children never split', () => {
    const groups = buildServiceGroups(fixture());
    const page1 = paginateGroups(groups, 1, 2);
    const page2 = paginateGroups(groups, 2, 2);
    expect(page1.map((g) => g.key)).toEqual(['svc-1', 'svc-2']);
    expect(page2.map((g) => g.key)).toEqual(['orphan-99']);
    expect(page1[0]?.children).toHaveLength(3);
    // out-of-range page clamps to the last valid one
    expect(paginateGroups(groups, 9, 2)).toHaveLength(1);
  });

  it('current-page selection covers collapsed groups and excludes orphan groups', () => {
    const groups = buildServiceGroups(fixture());
    const page1 = paginateGroups(groups, 1, 2);
    const ids = selectableChildIds(page1.map((g) => ({ group: g, visibleChildren: g.children })));
    expect(ids.sort((a, b) => a - b)).toEqual([11, 12, 13, 21]);
    const orphanPage = paginateGroups(groups, 2, 2);
    expect(
      selectableChildIds(orphanPage.map((g) => ({ group: g, visibleChildren: g.children }))),
    ).toEqual([]);
    const selected = [11, 12];
    expect(selectionState(ids, selected)).toBe('some');
    expect(selectionState([11, 12, 13], [11, 12, 13])).toBe('all');
    expect(selectionState([], selected)).toBe('none');
  });

  it('summarizes group totals, candidates and attention from children', () => {
    const groups = buildServiceGroups(fixture());
    const first = groupSummary(groups[0]!.children);
    expect(first).toEqual({
      total: 3,
      candidates: 1,
      attention: 2,
      excluded: 0,
      pendingSync: 0,
    });
    expect(childNeedsAttention(groups[0]!.children[1]!)).toBe(true); // ignore policy + no track
    expect(groupSummary(groups[1]!.children)).toEqual({
      total: 1,
      candidates: 1,
      attention: 0,
      excluded: 0,
      pendingSync: 0,
    });
  });

  it('classifies check outcomes by business result and renders feedback text', () => {
    expect(classifyCheckOutcome('matching')).toBe('succeeded');
    expect(classifyCheckOutcome('candidate')).toBe('succeeded');
    expect(classifyCheckOutcome('unfixed')).toBe('succeeded');
    expect(classifyCheckOutcome('blocked')).toBe('blocked');
    expect(classifyCheckOutcome('error')).toBe('failed');
    expect(checkOutcomeFeedback('web', 'blocked', '目标平台待配置')).toEqual({
      text: 'web：已跳过（目标平台待配置）',
      tone: 'neutral',
    });
    expect(checkOutcomeFeedback('web', 'error', null).text).toBe('web：检查失败（未知错误）');
    expect(summarizeBatchChecks({ succeeded: 2, blocked: 1, failed: 1 })).toBe(
      '检查完成：成功 2，跳过 1，失败 1',
    );
    expect(summarizeBatchUpdates({ submitted: 3, skipped: 1, failed: 0 })).toBe(
      '更新完成：已提交 3，跳过 1，失败 0',
    );
  });

  it('update eligibility mirrors the known frontend conditions', () => {
    const rows = fixture();
    const web = rows.find((r) => r.id === 11)!;
    const db = rows.find((r) => r.id === 12)!;
    const cache = rows.find((r) => r.id === 13)!;
    expect(updateBlockedHint(web)).toBeNull();
    expect(updateBlockedHint(db)).toBe('忽略策略的资源不检查更新');
    expect(updateBlockedHint(cache)).toBe('目标平台待配置');
    const noObservation = dto({
      id: 41,
      name: 'fresh',
      track: track({
        resourceId: 41,
        observedDigest: null,
        view: trackView({ checkOutcome: 'blocked' }),
      }),
    });
    expect(updateBlockedHint(noObservation)).toBe('暂无上游观察结果，先检查更新');
  });
});

// --- 三档筛选与管理状态展示（plan §3/§4） -------------------------------------

describe('three-tier view projection', () => {
  /** 组：未排除父级 + 全部子排除；组：排除父级；含待同步/镜像问题的组。 */
  function exclusionFixture(): ResourceDTO[] {
    const svcOk = dto({ id: 1, name: 'ok-svc', kind: 'compose_service' });
    const okChild = dto({ id: 11, name: 'web', parentResourceId: 1, parentName: 'ok-svc' });
    const excludedChild = dto({
      id: 12,
      name: 'db',
      parentResourceId: 1,
      parentName: 'ok-svc',
      excludedInfra: true,
      exclusionSource: 'self',
    });
    const svcExcluded = dto({
      id: 2,
      name: 'ex-svc',
      kind: 'compose_service',
      excludedInfra: true,
      exclusionSource: 'self',
    });
    const ctxChildA = dto({
      id: 21,
      name: 'a',
      parentResourceId: 2,
      parentName: 'ex-svc',
      excludedInfra: true,
      exclusionSource: 'parent',
    });
    const ctxChildB = dto({ id: 22, name: 'b', parentResourceId: 2, parentName: 'ex-svc' });
    const svcPending = dto({ id: 3, name: 'pending-svc', kind: 'compose_service' });
    const pendingChild = dto({
      id: 31,
      name: 'p',
      parentResourceId: 3,
      parentName: 'pending-svc',
      managementClassified: false,
    });
    const issueChild = dto({
      id: 32,
      name: 'i',
      parentResourceId: 3,
      parentName: 'pending-svc',
      imageIssue: { code: 'unsupported_registry', registry: 'gcr.io' },
    });
    return [
      svcOk,
      okChild,
      excludedChild,
      svcExcluded,
      ctxChildA,
      ctxChildB,
      svcPending,
      pendingChild,
      issueChild,
    ];
  }

  it('unexcluded view: excluded children hidden, pending/image-issue stay, excluded parents hide their group', () => {
    const groups = buildServiceGroups(exclusionFixture());
    const projected = projectGroupsForView(groups, 'unexcluded');
    const keys = projected.map((g) => g.key);
    expect(keys).toContain('svc-1');
    expect(keys).toContain('svc-3'); // 待同步 + 镜像问题保持可见
    expect(keys).not.toContain('svc-2'); // 父级排除 → 整组隐藏
    const g1 = projected.find((g) => g.key === 'svc-1')!;
    expect(g1.children.map((c) => c.name)).toEqual(['web']); // 已排除子项隐藏
  });

  it('unexcluded view hides a group whose every active child is excluded', () => {
    const svc = dto({ id: 1, name: 'all-ex', kind: 'compose_service' });
    const a = dto({
      id: 11,
      name: 'a',
      parentResourceId: 1,
      parentName: 'all-ex',
      excludedInfra: true,
      exclusionSource: 'self',
    });
    const b = dto({
      id: 12,
      name: 'b',
      parentResourceId: 1,
      parentName: 'all-ex',
      excludedInfra: true,
      exclusionSource: 'self',
    });
    const projected = projectGroupsForView(buildServiceGroups([svc, a, b]), 'unexcluded');
    expect(projected).toHaveLength(0);
  });

  it('empty services keep their empty-group behavior in the default view', () => {
    const svc = dto({ id: 1, name: 'empty', kind: 'compose_service' });
    const projected = projectGroupsForView(buildServiceGroups([svc]), 'unexcluded');
    expect(projected).toHaveLength(1);
    expect(projectGroupsForView(buildServiceGroups([svc]), 'managed')).toHaveLength(0);
  });

  it('excluded view: excluded children visible with unexcluded parent header; excluded parent shows full context', () => {
    const groups = buildServiceGroups(exclusionFixture());
    const projected = projectGroupsForView(groups, 'excluded');
    const g1 = projected.find((g) => g.key === 'svc-1')!;
    expect(g1.parent?.id).toBe(1); // 未排除父级作组头
    expect(g1.children.map((c) => c.name)).toEqual(['db']);
    const g2 = projected.find((g) => g.key === 'svc-2')!;
    expect(g2.parent?.id).toBe(2);
    expect(g2.children.map((c) => c.name)).toEqual(['a', 'b']); // 全部子容器上下文
    expect(projected.find((g) => g.key === 'svc-3')).toBeUndefined();
  });

  it('managed view keeps only classified, non-excluded, issue-free notify/manual/auto children', () => {
    const svc = dto({ id: 1, name: 'svc', kind: 'compose_service' });
    const rows = [
      svc,
      dto({ id: 11, name: 'auto', parentResourceId: 1, parentName: 'svc', policy: 'auto' }),
      dto({ id: 12, name: 'ign', parentResourceId: 1, parentName: 'svc', policy: 'ignore' }),
      dto({
        id: 13,
        name: 'iss',
        parentResourceId: 1,
        parentName: 'svc',
        imageIssue: { code: 'missing_image', registry: null },
      }),
      dto({
        id: 14,
        name: 'pend',
        parentResourceId: 1,
        parentName: 'svc',
        managementClassified: false,
      }),
    ];
    const projected = projectGroupsForView(buildServiceGroups(rows), 'managed');
    expect(projected).toHaveLength(1);
    expect(projected[0]!.children.map((c) => c.name)).toEqual(['auto']);
  });
});

describe('management reason display', () => {
  it('renders precise reasons per image issue code', () => {
    expect(
      managementReason(
        dto({ id: 1, name: 'x', imageIssue: { code: 'unsupported_registry', registry: 'gcr.io' } }),
      ),
    ).toBe('暂不支持的镜像仓库：gcr.io');
    expect(
      managementReason(
        dto({ id: 2, name: 'x', imageIssue: { code: 'unresolved_variable', registry: null } }),
      ),
    ).toBe('镜像变量未解析');
    expect(
      managementReason(
        dto({ id: 3, name: 'x', imageIssue: { code: 'missing_image', registry: null } }),
      ),
    ).toBe('镜像信息缺失');
    expect(
      managementReason(
        dto({ id: 4, name: 'x', imageIssue: { code: 'invalid_reference', registry: null } }),
      ),
    ).toBe('镜像引用无效');
  });

  it('renders pending-sync and exclusion reasons with attribution', () => {
    expect(managementReason(dto({ id: 5, name: 'x', managementClassified: false }))).toBe(
      '待同步确认',
    );
    expect(managementReason(dto({ id: 6, name: 'x', excludedInfra: true }))).toBe('已排除');
    expect(
      managementReasonDetail(
        dto({ id: 7, name: 'x', excludedInfra: true, exclusionSource: 'parent' }),
      ),
    ).toContain('继承父服务');
    expect(
      managementReasonDetail(dto({ id: 8, name: 'x', managementClassified: false })),
    ).toContain('只读');
  });

  it('checkBlockedHint follows the server gate order', () => {
    expect(checkBlockedHint(dto({ id: 9, name: 'x', managementClassified: false }))).toContain(
      '待同步确认',
    );
    expect(checkBlockedHint(dto({ id: 10, name: 'x', excludedInfra: true }))).toBe('已排除');
    expect(
      checkBlockedHint(
        dto({ id: 11, name: 'x', imageIssue: { code: 'unsupported_registry', registry: null } }),
      ),
    ).toBe('暂不支持的镜像仓库');
  });
});
