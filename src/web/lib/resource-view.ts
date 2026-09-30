// Pure view-model for the resources pages: service grouping, filtering,
// pagination, selection and check-outcome summaries. No React, no fetch —
// unit-testable against plain ResourceDTO fixtures.

import type { CheckOutcome, Policy, ResourceDTO } from '../../shared/types.js';

// --- service grouping ---------------------------------------------------------

/** One service group: a compose_service parent plus its active sub-containers. */
export interface ServiceGroup {
  /** Parent service row; null for the orphan group (parent not in the active list). */
  parent: ResourceDTO | null;
  /** Stable group key: `svc-<id>` or `orphan-<parentResourceId|uuid>`. */
  key: string;
  /** Orphan groups show the stored parent name as a display fallback. */
  parentName: string | null;
  /** All active children belonging to this group (unfiltered). */
  children: ResourceDTO[];
  orphan: boolean;
}

/** Group with its filtered visible children. */
export interface FilteredServiceGroup {
  group: ServiceGroup;
  visibleChildren: ResourceDTO[];
}

const byNameId = (a: ResourceDTO, b: ResourceDTO): number =>
  a.name.localeCompare(b.name) || a.id - b.id;

/**
 * Group active rows into service groups. Same-name services stay separate
 * (grouping is by local parent id). Children whose parent row is not in the
 * active list land in per-parent orphan groups, sorted after normal groups.
 * Input is expected to be the active resource list.
 */
export function buildServiceGroups(resources: ResourceDTO[]): ServiceGroup[] {
  const parentRows = resources
    .filter((r) => r.kind === 'compose_service')
    .slice()
    .sort(byNameId);
  const childRows = resources.filter((r) => r.kind === 'service_application');
  const parentById = new Map(parentRows.map((p) => [p.id, p]));
  const childrenByParent = new Map<number, ResourceDTO[]>();
  const orphanGroups = new Map<string, ServiceGroup>();
  for (const child of childRows.slice().sort(byNameId)) {
    const pid = child.parentResourceId;
    if (pid != null && parentById.has(pid)) {
      const list = childrenByParent.get(pid);
      if (list == null) childrenByParent.set(pid, [child]);
      else list.push(child);
      continue;
    }
    const key = pid != null ? `orphan-${pid}` : `orphan-${child.coolifyUuid}`;
    let group = orphanGroups.get(key);
    if (group == null) {
      group = { parent: null, key, parentName: child.parentName, children: [], orphan: true };
      orphanGroups.set(key, group);
    }
    group.children.push(child);
  }
  const normal: ServiceGroup[] = parentRows.map((p) => ({
    parent: p,
    key: `svc-${p.id}`,
    parentName: p.name,
    children: childrenByParent.get(p.id) ?? [],
    orphan: false,
  }));
  const orphans = [...orphanGroups.values()].sort(
    (a, b) => (a.parentName ?? '').localeCompare(b.parentName ?? '') || a.key.localeCompare(b.key),
  );
  return [...normal, ...orphans];
}

// --- filtering ------------------------------------------------------------------

export interface ServiceFilters {
  search: string;
  policy: '' | Policy;
  managed: 'all' | 'managed';
  status: 'all' | 'running' | 'stopped';
  server: string;
}

export const DEFAULT_SERVICE_FILTERS: ServiceFilters = {
  search: '',
  policy: '',
  managed: 'all',
  status: 'all',
  server: '',
};

/** Whether any child-scoped condition (policy/managed/status) is active. */
function childConditionsActive(f: ServiceFilters): boolean {
  return f.policy !== '' || f.managed !== 'all' || f.status !== 'all';
}

function childPassesConditions(r: ResourceDTO, f: ServiceFilters): boolean {
  if (f.policy !== '' && r.policy !== f.policy) return false;
  if (f.managed === 'managed' && r.policy === 'ignore') return false;
  if (f.status === 'running' && r.isStopped) return false;
  if (f.status === 'stopped' && !r.isStopped) return false;
  return true;
}

function childMatchesSearch(r: ResourceDTO, q: string): boolean {
  if (r.name.toLowerCase().includes(q)) return true;
  if (r.currentImage?.toLowerCase().includes(q) === true) return true;
  return (r.track?.sourceRepository ?? '').toLowerCase().includes(q);
}

/** Distinct server names across groups (parent field first) for the filter dropdown. */
export function serviceServerNames(groups: ServiceGroup[]): string[] {
  const names = new Set<string>();
  for (const g of groups) {
    const name = g.parent?.serverName ?? g.children[0]?.serverName ?? null;
    if (name != null) names.add(name);
  }
  return [...names].sort();
}

/**
 * Filter groups to their visible children. Search keeps the whole group when
 * the service name matches; child name/image matches keep the group header
 * with only matching children. Policy/managed/status conditions evaluate on
 * child fields; server uses the parent field first. Empty services survive
 * only when no child-scoped condition is set.
 */
export function filterServiceGroups(
  groups: ServiceGroup[],
  filters: ServiceFilters,
): FilteredServiceGroup[] {
  const q = filters.search.trim().toLowerCase();
  const childCond = childConditionsActive(filters);
  const result: FilteredServiceGroup[] = [];
  for (const group of groups) {
    const groupServer = group.parent?.serverName ?? group.children[0]?.serverName ?? null;
    if (filters.server !== '' && groupServer !== filters.server) continue;
    const serviceName = group.parent?.name ?? group.parentName ?? '';
    const serviceHit = q !== '' && serviceName.toLowerCase().includes(q);
    let visibleChildren: ResourceDTO[];
    if (q === '' || serviceHit) {
      visibleChildren = group.children.filter((c) => childPassesConditions(c, filters));
    } else {
      visibleChildren = group.children.filter(
        (c) => childPassesConditions(c, filters) && childMatchesSearch(c, q),
      );
    }
    if (visibleChildren.length === 0) {
      // 空服务仅在未设置任何子容器条件时保留空态（含服务名搜索命中的情形）；
      // 搜索未命中或子容器条件筛空时整组隐藏。
      if (group.children.length === 0 && !childCond && (q === '' || serviceHit)) {
        result.push({ group, visibleChildren });
      }
      continue;
    }
    result.push({ group, visibleChildren });
  }
  return result;
}

// --- pagination -----------------------------------------------------------------

/** Clamp page into the valid range and slice; polling shrink stays consistent. */
export function paginateGroups<T>(items: T[], page: number, pageSize: number): T[] {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  return items.slice((current - 1) * pageSize, current * pageSize);
}

// --- selection ------------------------------------------------------------------

/**
 * Selectable ids across the given (current page) filtered groups. Orphan
 * groups are excluded: their group-level actions stay disabled.
 */
export function selectableChildIds(groups: FilteredServiceGroup[]): number[] {
  const ids: number[] = [];
  for (const { group, visibleChildren } of groups) {
    if (group.orphan) continue;
    for (const c of visibleChildren) ids.push(c.id);
  }
  return ids;
}

export type SelectionState = 'none' | 'some' | 'all';

export function selectionState(ids: number[], selected: number[]): SelectionState {
  if (ids.length === 0) return 'none';
  let hits = 0;
  for (const id of ids) {
    if (selected.includes(id)) hits += 1;
  }
  if (hits === 0) return 'none';
  return hits === ids.length ? 'all' : 'some';
}

// --- group summary ---------------------------------------------------------------

export interface GroupSummary {
  /** All active children in the group (unfiltered). */
  total: number;
  /** Children with a candidate update. */
  candidates: number;
  /** Children needing configuration/attention (blocked, excluded, untracked…). */
  attention: number;
}

/** Front-end mirror of the checker eligibility surface, for hints only. */
export function childNeedsAttention(r: ResourceDTO): boolean {
  return (
    r.blockedReason != null ||
    r.excludedInfra ||
    r.track == null ||
    r.track.sourceTag === '' ||
    r.track.targetPlatform == null ||
    r.track.view.checkOutcome === 'error' ||
    r.track.view.checkOutcome === 'blocked'
  );
}

export function groupSummary(children: ResourceDTO[]): GroupSummary {
  return {
    total: children.length,
    candidates: children.filter((r) => r.track?.view.hasCandidate === true).length,
    attention: children.filter(childNeedsAttention).length,
  };
}

// --- eligibility hints (display only; backend stays authoritative) -----------------

export type PolicyBadgeTone = 'accent' | 'info' | 'neutral';

/** Shared policy badge tone so all three views render identically. */
export function policyTone(policy: Policy): PolicyBadgeTone {
  if (policy === 'auto') return 'accent';
  if (policy === 'notify' || policy === 'manual') return 'info';
  return 'neutral';
}

/** Why the resource cannot run a check right now; null when checkable. */
export function checkBlockedHint(r: ResourceDTO): string | null {
  if (r.status !== 'active') return '资源已移除';
  if (r.excludedInfra) return '已排除（基础设施）';
  if (r.policy === 'ignore') return '忽略策略的资源不检查更新';
  if (r.blockedReason === 'external_change') return '外部修改，需重新确认';
  if (r.track == null) return '无镜像追踪';
  if (r.track.sourceTag === '') return '追踪 tag 待配置';
  if (r.track.targetPlatform == null || r.track.targetPlatform === '') return '目标平台待配置';
  return null;
}

/** Why the resource cannot submit an update right now; null when updatable. */
export function updateBlockedHint(r: ResourceDTO): string | null {
  const base = checkBlockedHint(r);
  if (base != null) return base;
  const track = r.track;
  if (track == null || track.observedDigest == null) return '暂无上游观察结果，先检查更新';
  const hasCandidate = track.view.hasCandidate || track.configuredDigest == null;
  if (!hasCandidate) return '当前没有可执行的更新';
  return null;
}

// --- check outcome feedback ---------------------------------------------------------

export type FeedbackTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

export interface CheckFeedbackLine {
  text: string;
  tone: FeedbackTone;
}

/** Human-readable per-item feedback for one check result. */
export function checkOutcomeFeedback(
  name: string,
  outcome: CheckOutcome,
  message: string | null,
): CheckFeedbackLine {
  switch (outcome) {
    case 'matching':
      return { text: `${name}：与上游一致，无更新`, tone: 'success' };
    case 'candidate':
      return { text: `${name}：发现候选更新`, tone: 'warning' };
    case 'unfixed':
      return { text: `${name}：已获取上游摘要，等待初始化`, tone: 'info' };
    case 'blocked':
      return { text: `${name}：已跳过（${message ?? '不满足检查条件'}）`, tone: 'neutral' };
    case 'error':
      return { text: `${name}：检查失败（${message ?? '未知错误'}）`, tone: 'danger' };
  }
}

export type CheckBusinessResult = 'succeeded' | 'blocked' | 'failed';

/** Batch statistics count by business outcome: blocked (HTTP 200) is a skip. */
export function classifyCheckOutcome(outcome: CheckOutcome): CheckBusinessResult {
  if (outcome === 'blocked') return 'blocked';
  if (outcome === 'error') return 'failed';
  return 'succeeded';
}

export interface BatchCheckStats {
  succeeded: number;
  blocked: number;
  failed: number;
}

export function summarizeBatchChecks(stats: BatchCheckStats): string {
  return `检查完成：成功 ${stats.succeeded}，跳过 ${stats.blocked}，失败 ${stats.failed}`;
}

export interface BatchUpdateStats {
  submitted: number;
  skipped: number;
  failed: number;
}

export function summarizeBatchUpdates(stats: BatchUpdateStats): string {
  return `更新完成：已提交 ${stats.submitted}，跳过 ${stats.skipped}，失败 ${stats.failed}`;
}
