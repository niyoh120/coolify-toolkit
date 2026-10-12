// Pure view-model for the resources pages: service grouping, filtering,
// pagination, selection and check-outcome summaries. No React, no fetch —
// unit-testable against plain ResourceDTO fixtures.

import type { CheckOutcome, Policy, ResourceDTO } from '../../shared/types.js';

// --- management state (display mirror of the server-side gates) -------------------

/**
 * Three-tier resources view (plan §3):
 *  - unexcluded (default): classified, config-excluded resources hidden;
 *    pending-sync records stay visible with an explicit hint.
 *  - managed: classified, config-excluded-free, no image issue, and a
 *    notify/manual/auto policy on an image-bearing resource.
 *  - excluded: classified + config-excluded; read-only.
 */
export type ExclusionView = 'unexcluded' | 'managed' | 'excluded';

/** Legacy rows awaiting their first classified sync ("待同步确认"). */
export function isPendingSync(r: ResourceDTO): boolean {
  return !r.managementClassified;
}

/** Classified and config-excluded (own UUID or inherited from the parent). */
export function isConfigExcluded(r: ResourceDTO): boolean {
  return r.managementClassified && r.excludedInfra;
}

/** Classified with a structured image problem. */
export function hasImageIssue(r: ResourceDTO): boolean {
  return r.managementClassified && r.imageIssue != null;
}

/** Which tier the row belongs to (pending rows live in the default view). */
export function belongsToView(r: ResourceDTO, view: ExclusionView): boolean {
  switch (view) {
    case 'unexcluded':
      return !isConfigExcluded(r);
    case 'managed':
      return (
        r.managementClassified &&
        !r.excludedInfra &&
        r.imageIssue == null &&
        (r.policy === 'notify' || r.policy === 'manual' || r.policy === 'auto') &&
        r.kind !== 'compose_service'
      );
    case 'excluded':
      return isConfigExcluded(r);
  }
}

/** Short badge reason; null when the resource is fully manageable. */
export function managementReason(r: ResourceDTO): string | null {
  if (isPendingSync(r)) return '待同步确认';
  if (isConfigExcluded(r)) return '已排除';
  if (r.imageIssue != null) {
    switch (r.imageIssue.code) {
      case 'unsupported_registry':
        return r.imageIssue.registry != null
          ? `暂不支持的镜像仓库：${r.imageIssue.registry}`
          : '暂不支持的镜像仓库';
      case 'unresolved_variable':
        return '镜像变量未解析';
      case 'missing_image':
        return '镜像信息缺失';
      case 'invalid_reference':
        return '镜像引用无效';
    }
  }
  return null;
}

/** Longer accessible explanation for tooltips/details; null when manageable. */
export function managementReasonDetail(r: ResourceDTO): string | null {
  if (isPendingSync(r)) {
    return '该记录尚未经现行同步规则分类（历史数据）。完成一次资源同步后自动确认管理状态；在此之前配置只读、新管理操作暂停。';
  }
  if (isConfigExcluded(r)) {
    if (r.exclusionSource === 'parent') {
      return '继承父服务的配置排除（EXCLUDED_RESOURCE_UUIDS）。调整配置并重启、同步后解除。';
    }
    return '自身命中 EXCLUDED_RESOURCE_UUIDS 配置名单。调整配置并重启、同步后解除。';
  }
  if (r.imageIssue != null) {
    switch (r.imageIssue.code) {
      case 'unsupported_registry':
        return '该镜像仓库在当前支持范围外（docker.io / ghcr.io / lscr.io）。核对 Coolify 镜像配置后同步。';
      case 'unresolved_variable':
        return '镜像引用含未展开的变量。请核对 Coolify 实际镜像配置，修复后同步。';
      case 'missing_image':
        return 'Coolify 未返回镜像信息。核对资源配置后同步。';
      case 'invalid_reference':
        return '镜像引用格式无效。核对 Coolify 镜像配置后同步。';
    }
  }
  return null;
}

/** True when management config (policy/track/cron) must render read-only. */
export function isConfigReadOnly(r: ResourceDTO): boolean {
  return managementReason(r) != null;
}

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

/**
 * Project full active groups onto one view tier (plan §3). Returns groups whose
 * `children` are the view-projected set (search/condition filters then apply
 * within it):
 *  - unexcluded: hide config-excluded children; hide a group whose parent is
 *    config-excluded (direct-link details remain available); hide a group
 *    whose every active child is excluded; pending/image-issue children stay;
 *    originally empty services keep their empty-group behavior.
 *  - excluded: show excluded children; an excluded parent shows its full
 *    active children as context (read-only).
 *  - managed: only managed children; empty groups collapse.
 *
 * Group summaries should still be computed over the FULL active children —
 * callers look the original group up by key (excluded/pending counts live
 * there).
 */
export function projectGroupsForView(groups: ServiceGroup[], view: ExclusionView): ServiceGroup[] {
  const result: ServiceGroup[] = [];
  for (const group of groups) {
    const parentExcluded = group.parent != null && isConfigExcluded(group.parent);
    if (view === 'excluded') {
      const visible = group.children.filter((c) => isConfigExcluded(c));
      // 确认排除的父级展示全部子容器上下文；否则仅列出已排除子项。
      const context = parentExcluded ? group.children : visible;
      if (context.length === 0) continue;
      result.push({ ...group, children: context });
      continue;
    }
    if (view === 'managed') {
      // managed 是子容器级条件：空组折叠。
      const visible = group.children.filter((c) => belongsToView(c, 'managed'));
      if (visible.length === 0) continue;
      result.push({ ...group, children: visible });
      continue;
    }
    // unexcluded（默认）：父级确认排除 → 整组隐藏；否则隐藏已排除子项。
    if (parentExcluded) continue;
    if (group.children.length === 0) {
      // 原本无 active 子容器的服务保留空组行为。
      result.push(group);
      continue;
    }
    const visible = group.children.filter((c) => !isConfigExcluded(c));
    if (visible.length === 0) {
      // 父级未排除且全部子容器均已确认排除 → 默认隐藏该组。
      continue;
    }
    result.push({ ...group, children: visible });
  }
  return result;
}

// --- filtering ------------------------------------------------------------------

export interface ServiceFilters {
  search: string;
  /** 子容器策略条件：由服务 Tab「按子容器策略筛选」下拉驱动，单测覆盖过滤行为。 */
  policy: '' | Policy;
  /** 旧「受管」双轨条件：已被三档视图（ExclusionView.managed）取代，仅为兼容保留。 */
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
  /**
   * Children needing configuration/attention (blocked, untracked, image
   * issues…). Config-excluded and pending-sync children are counted in their
   * own buckets instead.
   */
  attention: number;
  /** Confirmed config-excluded children. */
  excluded: number;
  /** Legacy children awaiting their first classified sync. */
  pendingSync: number;
}

/** Front-end mirror of the checker eligibility surface, for hints only. */
export function childNeedsAttention(r: ResourceDTO): boolean {
  // 待同步与排除各自单列，避免重复计数。
  if (isPendingSync(r) || isConfigExcluded(r)) return false;
  return (
    r.imageIssue != null ||
    r.blockedReason != null ||
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
    excluded: children.filter(isConfigExcluded).length,
    pendingSync: children.filter(isPendingSync).length,
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
  // 顺序与服务端 managementGate 一致：待确认 → 配置排除 → 镜像问题。
  const reason = managementReason(r);
  if (reason != null) {
    return isPendingSync(r) ? '待同步确认：完成一次资源同步后才能检查' : reason;
  }
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

// --- confirmation eligibility & batch snapshot -----------------------------------

/** Why the row cannot run 「确认更新完成」 right now; null when confirmable. */
export function confirmBlockedHint(r: ResourceDTO): string | null {
  if (r.status !== 'active') return '资源已移除';
  if (r.pendingConfirmation == null) return '暂无待确认的更新任务';
  return null;
}

/** One frozen confirm target: only the exact job+digest pair is confirmed. */
export interface ConfirmItem {
  resourceId: number;
  resourceName: string;
  /** 父服务名；重名子容器用它在弹窗中定位。 */
  parentName: string | null;
  jobId: number;
  candidateDigest: string;
}

export interface ConfirmSkip {
  resourceId: number;
  name: string;
  reason: string;
}

export interface ConfirmSnapshot {
  /** Rows actually confirmable at snapshot time, in selection order. */
  items: ConfirmItem[];
  /** Selected rows skipped because they hold no pending task. */
  skipped: ConfirmSkip[];
}

/**
 * Freeze the confirm targets for the current selection: only selected rows
 * carrying an active pendingConfirmation enter the snapshot, so tasks started
 * later or rows hidden by filters can never join the batch.
 */
export function buildConfirmSnapshot(rows: ResourceDTO[], selectedIds: number[]): ConfirmSnapshot {
  const items: ConfirmItem[] = [];
  const skipped: ConfirmSkip[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of selectedIds) {
    const row = byId.get(id);
    if (row == null) continue; // vanished between render and snapshot
    if (row.pendingConfirmation == null || row.status !== 'active') {
      skipped.push({
        resourceId: row.id,
        name: row.name,
        reason: confirmBlockedHint(row) ?? '暂无待确认的更新任务',
      });
      continue;
    }
    items.push({
      resourceId: row.id,
      resourceName: row.name,
      parentName: row.parentName,
      jobId: row.pendingConfirmation.jobId,
      candidateDigest: row.pendingConfirmation.candidateDigest,
    });
  }
  return { items, skipped };
}

export interface BatchConfirmStats {
  confirmed: number;
  skipped: number;
  failed: number;
}

export function summarizeBatchConfirmations(stats: BatchConfirmStats): string {
  return `确认完成：已确认 ${stats.confirmed}，跳过 ${stats.skipped}，失败 ${stats.failed}`;
}

/** A confirmation request that lost a race (state already changed) is a skip. */
export function isStaleConfirmError(status: number): boolean {
  return status === 409 || status === 404;
}

export function confirmItemFeedback(item: ConfirmItem): string {
  return `${item.resourceName}：已记录人工确认`;
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
