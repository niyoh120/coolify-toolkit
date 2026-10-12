// Resources page: applications tab (flat application rows) and services tab
// (service-grouped list with per-group children, batch actions on children).
// Tab state lives in the hash route; switching tabs remounts the view.
// Search / filters / page size / page / service-group expansion persist per
// tab in localStorage (resources.*.v1 keys, see lib/resource-preferences.ts)
// and survive tab switches, reloads and revisits. Selection, confirm dialogs
// and batch feedback stay component-transient on purpose (batch safety).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type { Policy, ResourceDTO } from '../../shared/types.js';
import { ResourceTabsBar } from '../components/ResourceTabsBar.js';
import { ChildResourcesTable } from '../components/resources/ChildResourcesTable.js';
import {
  type BatchLines,
  type FeedbackLine,
  useBatchRunner,
  useCheckOne,
  useFeedbackLines,
  useUpdateOne,
} from '../components/resources/useBatchRunner.js';
import {
  BlockedBadge,
  CheckBadge,
  DeployBadge,
  ManagementBadge,
  POLICY_LABEL,
  shortDigest,
} from '../components/status.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Modal,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  StatusPill,
  Table,
  Td,
  Th,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { decodeString, usePersistedState } from '../lib/persisted-state.js';
import {
  APP_PREF_KEYS,
  decodeExclusionView,
  decodeExpanded,
  decodePage,
  decodePageSize,
  decodePolicyFilter,
  decodeServiceFilters,
  decodeStatusFilter,
  encodeExpanded,
  encodeJson,
  PAGE_SIZES,
  type PolicyFilter,
  SERVICE_PREF_KEYS,
  type StatusFilter,
} from '../lib/resource-preferences.js';
import {
  belongsToView,
  buildConfirmSnapshot,
  buildServiceGroups,
  type ConfirmItem,
  checkBlockedHint,
  DEFAULT_SERVICE_FILTERS,
  type ExclusionView,
  type FilteredServiceGroup,
  filterServiceGroups,
  groupSummary,
  isConfigExcluded,
  isConfigReadOnly,
  isPendingSync,
  paginateGroups,
  policyTone,
  projectGroupsForView,
  type ServiceFilters,
  selectableChildIds,
  selectionState,
  serviceServerNames,
  updateBlockedHint,
} from '../lib/resource-view.js';
import { useRouter } from '../main.js';

type PendingBatch =
  | { kind: 'check' }
  | { kind: 'update' }
  | { kind: 'policy'; policy: Policy }
  | {
      kind: 'confirm';
      /** 冻结的任务快照：只有这批 job+digest 会被确认。 */
      items: ConfirmItem[];
      skippedCount: number;
      selectedCount: number;
    }
  | null;

/** 三档筛选的选择器（应用/服务列表共用）。 */
const POLICY_SELECT_OPTIONS: readonly Policy[] = ['ignore', 'notify', 'manual', 'auto'];
function ViewSegmented({
  value,
  onChange,
  ariaLabel,
}: {
  value: ExclusionView;
  onChange: (v: ExclusionView) => void;
  ariaLabel: string;
}) {
  return (
    <Segmented<ExclusionView>
      ariaLabel={ariaLabel}
      value={value}
      onChange={onChange}
      options={[
        { value: 'unexcluded', label: '全部' },
        { value: 'managed', label: '受管' },
        { value: 'excluded', label: '已排除' },
      ]}
    />
  );
}

/** 默认视图下的待同步说明条。 */
function PendingSyncHint({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div
      role="note"
      className="rounded border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-3 py-2 text-[12px] text-[var(--color-info)]"
    >
      含待同步确认资源 {count}{' '}
      项：这些记录尚未经现行同步规则分类（历史数据），配置只读、新管理操作已暂停。点击「同步资源」完成一次资源同步后自动确认。
    </div>
  );
}

function FeedbackArea({ batch, lines }: { batch: BatchLines | null; lines: FeedbackLine[] }) {
  if (batch == null && lines.length === 0) return null;
  return (
    <div className="break-words rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
      {batch != null && (
        <>
          <div className="font-medium text-[var(--color-text-primary)]">{batch.summary}</div>
          {batch.detail.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              {batch.detail.map((line) => (
                <div key={line.id}>{line.text}</div>
              ))}
            </div>
          )}
        </>
      )}
      {lines.map((line) => (
        <div key={line.id}>{line.text}</div>
      ))}
    </div>
  );
}

export function ResourcesPage({ tab }: { tab: 'applications' | 'services' }) {
  return (
    <div
      className={
        // 应用 Tab 是页面级表格：满高 flex 链让表格自适应屏幕高度；服务 Tab 是卡片列表，保持文档流。
        tab === 'applications' ? 'flex h-full min-h-0 flex-col gap-4' : 'flex flex-col gap-4'
      }
    >
      <ResourceTabsBar active={tab} />
      {tab === 'services' ? <ServicesView /> : <ApplicationsView />}
    </div>
  );
}

/** 确认弹窗中的资源名列表预览：前 8 个 + 剩余数量。 */
function previewNames(list: ResourceDTO[]): string {
  return (
    list
      .slice(0, 8)
      .map((r) => r.name)
      .join('、') + (list.length > 8 ? ` 等 ${list.length} 项` : '')
  );
}

/** Single-row confirm target built from the row's live pendingConfirmation. */
function confirmSnapshotItem(rows: ResourceDTO[], id: number): ConfirmItem | null {
  const row = rows.find((r) => r.id === id);
  if (row == null || row.pendingConfirmation == null) return null;
  return {
    resourceId: row.id,
    resourceName: row.name,
    parentName: row.parentName,
    jobId: row.pendingConfirmation.jobId,
    candidateDigest: row.pendingConfirmation.candidateDigest,
  };
}

// --- applications tab -------------------------------------------------------------

function ApplicationsView() {
  const { navigate } = useRouter();
  // 浏览偏好（筛选/每页/页码）持久化到 localStorage；勾选与弹窗保持临时状态。
  const [view, setView] = usePersistedState<ExclusionView>({
    key: APP_PREF_KEYS.view,
    defaultValue: 'unexcluded',
    encode: encodeJson,
    decode: decodeExclusionView,
  });
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilter>({
    key: APP_PREF_KEYS.status,
    defaultValue: 'all',
    encode: encodeJson,
    decode: decodeStatusFilter,
  });
  const [policyFilter, setPolicyFilter] = usePersistedState<PolicyFilter>({
    key: APP_PREF_KEYS.policy,
    defaultValue: '',
    encode: encodeJson,
    decode: decodePolicyFilter,
  });
  const [server, setServer] = usePersistedState<string>({
    key: APP_PREF_KEYS.server,
    defaultValue: '',
    encode: encodeJson,
    decode: decodeString,
  });
  const [search, setSearch] = usePersistedState<string>({
    key: APP_PREF_KEYS.search,
    defaultValue: '',
    encode: encodeJson,
    decode: decodeString,
  });
  const [pageSize, setPageSize] = usePersistedState<number>({
    key: APP_PREF_KEYS.pageSize,
    defaultValue: 20,
    encode: encodeJson,
    decode: decodePageSize,
  });
  const [page, setPage] = usePersistedState<number>({
    key: APP_PREF_KEYS.page,
    defaultValue: 1,
    encode: encodeJson,
    decode: decodePage,
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch>(null);
  const [feedbackLines, pushFeedback] = useFeedbackLines();
  const batchRunner = useBatchRunner();

  const { data, isLoading, error } = useQuery({
    queryKey: ['resources', 'applications'],
    queryFn: () => api.resources({ kind: 'application' }),
  });
  const resources = data?.resources ?? [];
  const nameOf = (id: number): string => resources.find((r) => r.id === id)?.name ?? `资源 #${id}`;
  const checkOne = useCheckOne(nameOf, pushFeedback);
  const updateOne = useUpdateOne(nameOf, pushFeedback);
  // 筛选/分页/每页变化在各自处理器里清空选择，避免隐藏资源混入批量操作。
  const clearSelection = (): void => setSelected([]);

  // 轮询/视图切换后清理失效选择：只保留未排除且仍存在的 id。
  // （hooks 规则：早退 return 之前调用。）
  const resourceKey = resources.map((r) => r.id).join(',');
  useEffect(() => {
    setSelected((prev) => {
      if (prev.length === 0) return prev;
      const present = new Set(resourceKey.split(',').filter(Boolean));
      const next = prev.filter((id) => present.has(String(id)));
      return next.length === prev.length ? prev : next;
    });
  }, [resourceKey]);

  // 三档视图先投影；再叠加状态/策略/服务器/搜索条件。纯计算放在早退之前，
  // 让下方的页码回写 effect 保持「hooks 全部在 return 前」的固定顺序。
  const rows = resources
    .filter((r) => belongsToView(r, view))
    .filter((r) =>
      statusFilter === 'all' ? true : statusFilter === 'stopped' ? r.isStopped : !r.isStopped,
    )
    .filter((r) => (policyFilter === '' ? true : r.policy === policyFilter))
    .filter((r) => (server === '' ? true : r.serverName === server));
  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.track?.sourceRepository ?? '').toLowerCase().includes(q),
      )
    : rows;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // 有效页码同时驱动列表切片与分页控件；越界页码在成功渲染上立即收敛。
  const effectivePage = Math.min(Math.max(1, page), totalPages);
  const pagedRows = filtered.slice((effectivePage - 1) * pageSize, effectivePage * pageSize);

  // 持久化页码回写：仅在查询成功后按筛选后总数修正（空结果回到第 1 页）；
  // 首轮加载与请求失败期间保持恢复出的页码，区分首轮空数组占位与成功空结果。
  // 越界修正等同视图切换：清空勾选，避免隐藏资源留在批量范围内。
  useEffect(() => {
    if (isLoading || error != null) return;
    if (page !== effectivePage) {
      setPage(effectivePage);
      setSelected([]);
    }
  }, [effectivePage, error, isLoading, page, setPage]);

  // 服务器条件选项：至少包含当前持久化的非空值，失效或被筛选隐藏的条件
  // 保持可见、可通过「全部服务器」清除。
  const knownServers = [
    ...new Set(rows.map((r) => r.serverName).filter((n): n is string => n != null)),
  ].sort();
  const serverChoices =
    server !== '' && !knownServers.includes(server) ? [server, ...knownServers] : knownServers;

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;

  // 排除视图只读：不提供选择与操作。
  const readOnly = view === 'excluded';
  const pendingSyncTotal = resources.filter(isPendingSync).length;

  // 受影响数量：检查更新/执行更新只统计真正会执行的资源。
  const selectedRows = filtered.filter((r) => selected.includes(r.id));
  const checkableRows = selectedRows.filter((r) => checkBlockedHint(r) == null);
  const updatableRows = selectedRows.filter((r) => updateBlockedHint(r) == null);

  const toggle = (id: number, checked: boolean): void => {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  };
  const toggleAll = (checked: boolean): void =>
    setSelected((prev) => {
      const pageIds = pagedRows.map((r) => r.id);
      if (checked) return [...new Set([...prev, ...pageIds])];
      return prev.filter((id) => !pageIds.includes(id));
    });
  const confirmBatch = (): void => {
    const pending = pendingBatch;
    setPendingBatch(null);
    if (pending == null) return;
    if (pending.kind === 'check') {
      void batchRunner.runChecks(
        checkableRows.map((r) => r.id),
        nameOf,
      );
    } else if (pending.kind === 'update') {
      void batchRunner.runUpdates(
        updatableRows.map((r) => r.id),
        nameOf,
      );
    } else if (pending.kind === 'policy') {
      // 受限项（待同步/排除/镜像问题）提交前过滤，弹窗列出跳过原因；后端仍整批原子预检兜底。
      void batchRunner.runPolicy(
        selectedRows.filter((r) => !isConfigReadOnly(r)).map((r) => r.id),
        pending.policy,
      );
    }
    setSelected([]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* 工具栏：搜索 + 三档视图/状态/策略/服务器 + 每页条数 */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
            clearSelection();
          }}
          placeholder="按名称搜索应用"
          ariaLabel="搜索应用"
        />
        <ViewSegmented
          ariaLabel="按管理范围筛选"
          value={view}
          onChange={(v) => {
            setView(v);
            setPage(1);
            clearSelection();
          }}
        />
        <Segmented<StatusFilter>
          ariaLabel="按运行状态筛选"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
            clearSelection();
          }}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'running', label: '运行中' },
            { value: 'stopped', label: '已停止' },
          ]}
        />
        <Select
          value={policyFilter}
          onChange={(e) => {
            setPolicyFilter(e.target.value as PolicyFilter);
            setPage(1);
            clearSelection();
          }}
          aria-label="按策略筛选"
        >
          <option value="">全部策略</option>
          {POLICY_SELECT_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {POLICY_LABEL[p]}
            </option>
          ))}
        </Select>
        <Select
          value={server}
          onChange={(e) => {
            setServer(e.target.value);
            setPage(1);
            clearSelection();
          }}
          aria-label="按服务器筛选"
        >
          <option value="">全部服务器</option>
          {serverChoices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]">
          每页
          <Select
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
              clearSelection();
            }}
            aria-label="每页条数"
            className="!w-auto"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} 条
              </option>
            ))}
          </Select>
        </span>
      </div>

      {view === 'unexcluded' && <PendingSyncHint count={pendingSyncTotal} />}
      {view === 'excluded' && (
        <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          已排除资源配置只读：命中 EXCLUDED_RESOURCE_UUIDS
          名单（自身或父服务）。调整配置并重启、同步后解除。
        </div>
      )}

      <FeedbackArea batch={batchRunner.result} lines={feedbackLines} />

      {selected.length > 0 && !readOnly && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[13px]">
          已选 {selected.length} 项：
          <Button
            variant="ghost"
            disabled={batchRunner.busy}
            onClick={() => setPendingBatch({ kind: 'check' })}
          >
            检查更新
          </Button>
          <Button
            variant="outline"
            disabled={batchRunner.busy}
            title="跳过预览，直接按最新观察到的摘要提交更新"
            onClick={() => setPendingBatch({ kind: 'update' })}
          >
            执行更新
          </Button>
          <span className="mx-1 h-4 w-px bg-[var(--color-border-strong)]" aria-hidden="true" />
          <Select
            value=""
            aria-label="批量设置策略"
            className="!w-auto"
            disabled={batchRunner.busy}
            onChange={(e) => {
              const v = e.target.value as Policy | '';
              if (v !== '') setPendingBatch({ kind: 'policy', policy: v });
            }}
          >
            <option value="">设置策略…</option>
            {POLICY_SELECT_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
              </option>
            ))}
          </Select>
        </div>
      )}

      <Modal
        open={pendingBatch != null}
        title="批量操作确认"
        onClose={() => setPendingBatch(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingBatch(null)}>
              取消
            </Button>
            <Button
              variant="accent"
              disabled={
                batchRunner.busy ||
                (pendingBatch?.kind === 'policy' &&
                  selectedRows.filter((r) => !isConfigReadOnly(r)).length === 0)
              }
              onClick={confirmBatch}
            >
              确认执行
            </Button>
          </>
        }
      >
        {pendingBatch?.kind === 'check' && (
          <>
            <p>将对 {checkableRows.length} 项资源检查更新（查询上游最新摘要）。</p>
            {checkableRows.length > 0 && (
              <p className="text-[12px]">{previewNames(checkableRows)}</p>
            )}
            {checkableRows.length < selectedRows.length && (
              <p className="text-[12px]">
                其余 {selectedRows.length - checkableRows.length}
                项不满足检查条件（忽略策略、无追踪、缺 tag/平台或被阻塞），自动跳过。
              </p>
            )}
            {checkableRows.length === 0 && <p>没有可执行的资源，请调整选择。</p>}
          </>
        )}
        {pendingBatch?.kind === 'update' && (
          <>
            <p>
              将对 {updatableRows.length}
              项资源提交更新（跳过预览，直接按最新观察到的摘要提交部署任务）。
            </p>
            {updatableRows.length > 0 && (
              <p className="text-[12px]">{previewNames(updatableRows)}</p>
            )}
            {updatableRows.length < selectedRows.length && (
              <p className="text-[12px]">
                其余 {selectedRows.length - updatableRows.length}
                项无候选更新或不满足条件，自动跳过。
              </p>
            )}
            {updatableRows.length === 0 && <p>没有可执行的资源，请调整选择。</p>}
          </>
        )}
        {pendingBatch?.kind === 'policy' && (
          <>
            <p>
              将把 {selectedRows.filter((r) => !isConfigReadOnly(r)).length}
              项资源的策略设置为「
              {POLICY_LABEL[pendingBatch.policy]}
              」。
            </p>
            <p className="text-[12px]">
              {previewNames(selectedRows.filter((r) => !isConfigReadOnly(r)))}
            </p>
            {selectedRows.some((r) => isConfigReadOnly(r)) && (
              <p className="text-[12px]">
                跳过 {selectedRows.filter((r) => isConfigReadOnly(r)).length}{' '}
                项受限资源（待同步确认/已排除/镜像问题，配置只读）。
              </p>
            )}
          </>
        )}
      </Modal>

      <Card className="flex min-h-0 flex-1 flex-col">
        {filtered.length === 0 ? (
          <Empty>
            {rows.length === 0
              ? '暂无应用。请确认 Coolify 连接后点击「刷新」重新同步。新发现资源默认忽略，需要手动选择通知或自动策略。'
              : '没有匹配的应用，请调整搜索或筛选条件。'}
          </Empty>
        ) : (
          <Table ariaLabel="应用列表" fill>
            <thead>
              <tr>
                {!readOnly && (
                  <Th className="w-8">
                    <input
                      type="checkbox"
                      aria-label="全选当前页"
                      checked={
                        pagedRows.length > 0 && pagedRows.every((r) => selected.includes(r.id))
                      }
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </Th>
                )}
                <Th className="min-w-[10rem] max-w-[16rem]">名称</Th>
                <Th className="min-w-[6rem] max-w-[10rem]">服务器</Th>
                <Th className="min-w-[10rem] max-w-[15rem]">追踪来源</Th>
                <Th className="min-w-[6.5rem]">配置摘要</Th>
                <Th className="min-w-[6.5rem]">上游摘要</Th>
                <Th className="min-w-[5rem]">是否有更新</Th>
                <Th className="min-w-[5rem]">部署</Th>
                <Th className="min-w-[4.5rem]">状态</Th>
                <Th className="min-w-[4.5rem]">策略</Th>
                <Th className="min-w-[11rem]">操作</Th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((r) => (
                <tr key={r.id} className="hover:bg-[var(--color-bg-overlay)]/40">
                  {!readOnly && (
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${r.name}`}
                        checked={selected.includes(r.id)}
                        onChange={(e) => toggle(r.id, e.target.checked)}
                      />
                    </Td>
                  )}
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium break-words text-[var(--color-accent)] hover:underline"
                      onClick={() => navigate({ page: 'resource', id: r.id })}
                    >
                      {r.name}
                    </button>
                    <div className="flex flex-wrap gap-1 pt-1">
                      <BlockedBadge blockedReason={r.blockedReason} />
                      <ManagementBadge resource={r} />
                    </div>
                  </Td>
                  <Td className="break-words text-[12px] text-[var(--color-text-secondary)]">
                    {r.serverName ?? '—'}
                  </Td>
                  <Td>
                    {r.track == null ? (
                      '—'
                    ) : (
                      <span className="mono break-all text-[12px]">
                        {r.track.sourceRegistry}/{r.track.sourceRepository}:
                        {r.track.sourceTag === '' ? (
                          <Badge tone="warning">待配置</Badge>
                        ) : (
                          r.track.sourceTag
                        )}
                      </span>
                    )}
                  </Td>
                  <Td>{shortDigest(r.track?.configuredDigest)}</Td>
                  <Td>{shortDigest(r.track?.observedDigest)}</Td>
                  <Td>
                    <CheckBadge track={r.track} />
                  </Td>
                  <Td>
                    <DeployBadge track={r.track} />
                  </Td>
                  <Td>
                    <StatusPill tone={r.isStopped ? 'danger' : 'success'}>
                      {r.isStopped ? '已停止' : '运行中'}
                    </StatusPill>
                  </Td>
                  <Td>
                    <Badge tone={policyTone(r.policy)}>{POLICY_LABEL[r.policy]}</Badge>
                  </Td>
                  <Td>
                    {readOnly ? (
                      <span
                        className="text-[12px] text-[var(--color-text-muted)]"
                        title="已排除资源只读"
                      >
                        只读
                      </span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          variant="ghost"
                          disabled={
                            checkBlockedHint(r) != null ||
                            (checkOne.isPending && checkOne.variables === r.id)
                          }
                          title={checkBlockedHint(r) ?? '检查上游是否有新版本'}
                          onClick={() => checkOne.mutate(r.id)}
                        >
                          {checkOne.isPending && checkOne.variables === r.id
                            ? '检查中…'
                            : '检查更新'}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={
                            updateBlockedHint(r) != null ||
                            (updateOne.isPending && updateOne.variables === r.id)
                          }
                          title={updateBlockedHint(r) ?? '跳过预览，直接按最新观察到的摘要提交更新'}
                          onClick={() => updateOne.mutate(r.id)}
                        >
                          {updateOne.isPending && updateOne.variables === r.id
                            ? '提交中…'
                            : '执行更新'}
                        </Button>
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          page={effectivePage}
          pageSize={pageSize}
          total={filtered.length}
          onChange={(p) => {
            setPage(p);
            clearSelection();
          }}
        />
      </Card>
    </div>
  );
}

// --- services tab -------------------------------------------------------------------

function ServicesView() {
  const { navigate } = useRouter();
  // 浏览偏好（筛选/每页/页码/展开集合）持久化到 localStorage；勾选与弹窗保持临时状态。
  const [view, setView] = useState<ExclusionView>('unexcluded');
  const [filters, setFilters] = usePersistedState<ServiceFilters>({
    key: SERVICE_PREF_KEYS.filters,
    defaultValue: DEFAULT_SERVICE_FILTERS,
    encode: encodeJson,
    decode: decodeServiceFilters,
  });
  const [pageSize, setPageSize] = usePersistedState<number>({
    key: SERVICE_PREF_KEYS.pageSize,
    defaultValue: 20,
    encode: encodeJson,
    decode: decodePageSize,
  });
  const [page, setPage] = usePersistedState<number>({
    key: SERVICE_PREF_KEYS.page,
    defaultValue: 1,
    encode: encodeJson,
    decode: decodePage,
  });
  // 展开状态：已展开的组 key 集合；undefined 表示「尚未定制」，
  // 所有组跟随默认全展开（与历史行为一致）。定制后缺席的 key 为折叠，
  // 后续新出现的组也视为折叠；被筛选隐藏的组保留其展开状态。
  const [expanded, setExpanded] = usePersistedState<ReadonlySet<string> | undefined>({
    key: SERVICE_PREF_KEYS.expanded,
    defaultValue: undefined,
    encode: encodeExpanded,
    decode: decodeExpanded,
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch>(null);
  const [feedbackLines] = useFeedbackLines();
  const batchRunner = useBatchRunner();

  const { data, isLoading, error } = useQuery({
    queryKey: ['resources', 'services'],
    queryFn: () => api.resources({ status: 'active' }),
  });
  const resources = data?.resources ?? [];
  const nameOf = (id: number): string => resources.find((r) => r.id === id)?.name ?? `资源 #${id}`;
  const readOnly = view === 'excluded';

  // 先基于完整 active 列表构建真实父子组，再投影到当前视图，
  // 避免先过滤父记录产生虚假孤儿。
  const groups = useMemo(() => buildServiceGroups(resources), [resources]);
  const projected = useMemo(() => projectGroupsForView(groups, view), [groups, view]);
  const filtered = useMemo(() => filterServiceGroups(projected, filters), [projected, filters]);
  // 组摘要按搜索/普通条件筛选前的完整 active 子容器统计（含已排除与待同步数量）。
  const fullChildrenByKey = useMemo(
    () => new Map(groups.map((g) => [g.key, g.children])),
    [groups],
  );
  const serverOptions = useMemo(() => serviceServerNames(groups), [groups]);
  // 当前视图下的全部组 key：展开集合「尚未定制 → 全展开」物化时使用。
  const groupKeys = useMemo(() => projected.map((g) => g.key), [projected]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // 有效页码同时驱动列表切片与分页控件；越界页码在成功渲染上立即收敛。
  const effectivePage = Math.min(Math.max(1, page), totalPages);
  const paged = paginateGroups(filtered, effectivePage, pageSize);
  const pendingSyncTotal = resources.filter(isPendingSync).length;

  // 筛选/分页/每页变化在各自处理器里清空选择；轮询缩减数据时把越界页码修正回有效范围。
  const clearSelection = (): void => setSelected([]);
  const resourceKey = resources.map((r) => r.id).join(',');
  useEffect(() => {
    setSelected((prev) => {
      if (prev.length === 0) return prev;
      const present = new Set(resourceKey.split(',').filter(Boolean));
      const next = prev.filter((id) => present.has(String(id)));
      return next.length === prev.length ? prev : next;
    });
  }, [resourceKey]);
  // 持久化页码回写：仅在查询成功且有实际数据时按筛选后总数修正（空结果回到
  // 第 1 页）；首轮加载与请求失败期间保持恢复出的页码，区分首轮空数组占位与
  // 成功空结果。越界修正时直接清空勾选；下方 selectableKey effect 会按新页
  // 再收敛一次，双保险。
  useEffect(() => {
    if (isLoading || error != null) return;
    if (page !== effectivePage) {
      setPage(effectivePage);
      setSelected([]);
    }
  }, [effectivePage, error, isLoading, page, setPage]);

  // 轮询后用当前页可选 id 集合收敛选择：隐藏/消失的资源不能留在批量范围内。
  // 必须在早退之前调用，保证 hook 顺序稳定。
  const selectableKey = selectableChildIds(paged).join(',');
  useEffect(() => {
    setSelected((prev) => {
      const allowed = new Set(selectableKey === '' ? [] : selectableKey.split(',').map(Number));
      const next = prev.filter((id) => allowed.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableKey]);

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;

  const pageSelectable = selectableChildIds(paged);
  const pageSelection = selectionState(pageSelectable, selected);
  const selectedRows = resources.filter((r) => selected.includes(r.id));
  const checkableRows = selectedRows.filter((r) => checkBlockedHint(r) == null);
  const updatableRows = selectedRows.filter((r) => updateBlockedHint(r) == null);
  const confirmSnapshot = buildConfirmSnapshot(resources, selected);
  const confirmableCount = confirmSnapshot.items.length;

  const toggleChild = (id: number, checked: boolean): void => {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  };
  const togglePageAll = (checked: boolean): void =>
    setSelected((prev) => {
      if (checked) return [...new Set([...prev, ...pageSelectable])];
      return prev.filter((id) => !pageSelectable.includes(id));
    });
  const allExpanded =
    expanded == null || (groupKeys.length > 0 && groupKeys.every((k) => expanded.has(k)));
  const isExpanded = (key: string): boolean => (expanded == null ? true : expanded.has(key));
  const setAllExpanded = (target: boolean): void => {
    // 物化展开集合：全展开 = 当前全部组 key；全折叠 = 空集合。
    setExpanded(target ? new Set(groupKeys) : new Set<string>());
  };
  const toggleExpand = (key: string): void =>
    setExpanded((prev) => {
      // 「尚未定制」时以当前全部组为基底物化，再翻转目标组。
      const next = new Set(prev ?? groupKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const confirmBatch = (): void => {
    const pending = pendingBatch;
    setPendingBatch(null);
    if (pending == null) return;
    if (pending.kind === 'check') {
      void batchRunner.runChecks(
        checkableRows.map((r) => r.id),
        nameOf,
      );
    } else if (pending.kind === 'update') {
      void batchRunner.runUpdates(
        updatableRows.map((r) => r.id),
        nameOf,
      );
    } else if (pending.kind === 'confirm') {
      // 只确认快照冻结的 job+digest；批量中新建的任务留在范围外。
      void batchRunner.runConfirmations(pending.items);
    } else {
      void batchRunner.runPolicy(
        selectedRows.filter((r) => !isConfigReadOnly(r)).map((r) => r.id),
        pending.policy,
      );
    }
    setSelected([]);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={filters.search}
          onChange={(v) => {
            setFilters((f) => ({ ...f, search: v }));
            setPage(1);
            clearSelection();
          }}
          placeholder="按服务或子容器名称搜索"
          ariaLabel="搜索服务"
        />
        <ViewSegmented
          ariaLabel="按管理范围筛选"
          value={view}
          onChange={(v) => {
            setView(v);
            setPage(1);
            clearSelection();
          }}
        />
        <Segmented<StatusFilter>
          ariaLabel="按子容器运行状态筛选"
          value={filters.status}
          onChange={(v) => {
            setFilters((f) => ({ ...f, status: v }));
            setPage(1);
            clearSelection();
          }}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'running', label: '运行中' },
            { value: 'stopped', label: '已停止' },
          ]}
        />
        <Select
          value={filters.policy}
          onChange={(e) => {
            setFilters((f) => ({ ...f, policy: e.target.value as PolicyFilter }));
            setPage(1);
            clearSelection();
          }}
          aria-label="按子容器策略筛选"
        >
          <option value="">全部策略</option>
          {POLICY_SELECT_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {POLICY_LABEL[p]}
            </option>
          ))}
        </Select>
        <Select
          value={filters.server}
          onChange={(e) => {
            setFilters((f) => ({ ...f, server: e.target.value }));
            setPage(1);
            clearSelection();
          }}
          aria-label="按服务器筛选"
        >
          <option value="">全部服务器</option>
          {(filters.server !== '' && !serverOptions.includes(filters.server)
            ? [filters.server, ...serverOptions]
            : serverOptions
          ).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => setAllExpanded(!allExpanded)}>
          {allExpanded ? '折叠全部' : '展开全部'}
        </Button>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)]">
          每页
          <Select
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
              clearSelection();
            }}
            aria-label="每页组数"
            className="!w-auto"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} 组
              </option>
            ))}
          </Select>
        </span>
      </div>

      {view === 'unexcluded' && <PendingSyncHint count={pendingSyncTotal} />}
      {view === 'excluded' && (
        <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          已排除子容器只读；确认排除的父服务展示全部子容器上下文。调整配置并重启、同步后解除。
        </div>
      )}

      <FeedbackArea batch={batchRunner.result} lines={feedbackLines} />

      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        {!readOnly && (
          <>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                aria-label="全选当前页子容器"
                checked={pageSelection === 'all'}
                ref={(el) => {
                  if (el != null) el.indeterminate = pageSelection === 'some';
                }}
                onChange={(e) => togglePageAll(e.target.checked)}
              />
              全选本页（{pageSelectable.length} 项）
            </label>
            {selected.length > 0 && (
              <span className="flex flex-wrap items-center gap-2">
                已选 {selected.length} 项子容器：
                <Button
                  variant="ghost"
                  disabled={batchRunner.busy}
                  onClick={() => setPendingBatch({ kind: 'check' })}
                >
                  检查更新
                </Button>
                <Button
                  variant="outline"
                  disabled={batchRunner.busy}
                  title="跳过预览，直接按最新观察到的摘要提交更新"
                  onClick={() => setPendingBatch({ kind: 'update' })}
                >
                  执行更新
                </Button>
                <Button
                  variant="outline"
                  disabled={batchRunner.busy || confirmableCount === 0}
                  title={
                    confirmableCount === 0
                      ? '勾选中没有待确认的更新任务'
                      : '对勾选中待确认的任务记录人工确认并解除等待'
                  }
                  onClick={() =>
                    setPendingBatch({
                      kind: 'confirm',
                      items: confirmSnapshot.items,
                      skippedCount: confirmSnapshot.skipped.length,
                      selectedCount: selected.length,
                    })
                  }
                >
                  批量确认更新完成（{confirmableCount}）
                </Button>
                <Select
                  value=""
                  aria-label="批量设置策略"
                  className="!w-auto"
                  disabled={batchRunner.busy}
                  onChange={(e) => {
                    const v = e.target.value as Policy | '';
                    if (v !== '') setPendingBatch({ kind: 'policy', policy: v });
                  }}
                >
                  <option value="">设置策略…</option>
                  {POLICY_SELECT_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {POLICY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </span>
            )}
          </>
        )}
        {readOnly && selected.length > 0 && (
          <Button variant="ghost" onClick={clearSelection}>
            清除选择
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <Empty>
            {groups.length === 0
              ? '暂无服务。请确认 Coolify 连接后点击「刷新」重新同步。'
              : '没有匹配的服务组，请调整搜索或筛选条件。'}
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {paged.map((fg) => (
            <ServiceGroupSection
              key={fg.group.key}
              filtered={fg}
              view={view}
              summaryChildren={fullChildrenByKey.get(fg.group.key) ?? fg.group.children}
              expanded={isExpanded(fg.group.key)}
              onToggleExpand={toggleExpand}
              selected={selected}
              onToggleChild={toggleChild}
              onOpen={(id) => navigate({ page: 'resource', id })}
              onCheck={(id) => {
                void batchRunner.runChecks([id], nameOf);
              }}
              onUpdate={(id) => {
                void batchRunner.runUpdates([id], nameOf);
              }}
              onConfirm={(r) => {
                // 页面级执行锁：批量进行中不接受新的行级确认。
                if (batchRunner.busy) return;
                const item = confirmSnapshotItem(resources, r.id);
                if (item != null) void batchRunner.runConfirmations([item]);
              }}
              checkingId={batchRunner.activeCheckId}
              updatingId={batchRunner.activeUpdateId}
              confirmingId={batchRunner.activeConfirmId}
            />
          ))}
        </div>
      )}
      <Card>
        <Pagination
          page={effectivePage}
          pageSize={pageSize}
          total={filtered.length}
          onChange={(p) => {
            setPage(p);
            clearSelection();
          }}
          unit="组"
        />
      </Card>

      <Modal
        open={pendingBatch != null}
        title="批量操作确认"
        onClose={() => setPendingBatch(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingBatch(null)}>
              取消
            </Button>
            <Button
              variant="accent"
              disabled={
                batchRunner.busy ||
                (pendingBatch?.kind === 'policy' &&
                  selectedRows.filter((r) => !isConfigReadOnly(r)).length === 0) ||
                (pendingBatch?.kind === 'confirm' && pendingBatch.items.length === 0)
              }
              onClick={confirmBatch}
            >
              确认执行
            </Button>
          </>
        }
      >
        {pendingBatch?.kind === 'check' && (
          <>
            <p>将对 {checkableRows.length} 项子容器检查更新（查询上游最新摘要）。</p>
            {checkableRows.length > 0 && (
              <p className="text-[12px]">{previewNames(checkableRows)}</p>
            )}
            {checkableRows.length < selectedRows.length && (
              <p className="text-[12px]">
                其余 {selectedRows.length - checkableRows.length}
                项不满足检查条件（忽略策略、无追踪、缺 tag/平台或被阻塞），自动跳过。
              </p>
            )}
            {checkableRows.length === 0 && <p>没有可执行的子容器，请调整选择。</p>}
          </>
        )}
        {pendingBatch?.kind === 'update' && (
          <>
            <p>
              将对 {updatableRows.length}
              项子容器提交更新（跳过预览，直接按最新观察到的摘要提交部署任务）。
            </p>
            {updatableRows.length > 0 && (
              <p className="text-[12px]">{previewNames(updatableRows)}</p>
            )}
            {updatableRows.length < selectedRows.length && (
              <p className="text-[12px]">
                其余 {selectedRows.length - updatableRows.length}
                项无候选更新或不满足条件，自动跳过。
              </p>
            )}
            {updatableRows.length === 0 && <p>没有可执行的子容器，请调整选择。</p>}
          </>
        )}
        {pendingBatch?.kind === 'policy' && (
          <>
            <p>
              将把 {selectedRows.filter((r) => !isConfigReadOnly(r)).length}
              项子容器的策略设置为「
              {POLICY_LABEL[pendingBatch.policy]}
              」。
            </p>
            <p className="text-[12px]">
              {previewNames(selectedRows.filter((r) => !isConfigReadOnly(r)))}
            </p>
            {selectedRows.some((r) => isConfigReadOnly(r)) && (
              <p className="text-[12px]">
                跳过 {selectedRows.filter((r) => isConfigReadOnly(r)).length}{' '}
                项受限子容器（待同步确认/已排除/镜像问题，配置只读）。
              </p>
            )}
          </>
        )}
        {pendingBatch?.kind === 'confirm' && (
          <>
            <p>
              已选 {pendingBatch.selectedCount} 项子容器，其中 {pendingBatch.items.length}{' '}
              项有待确认的更新任务。确认会记录「容器已正常运行」并解除等待；后续自动检查与同服务队列立即放行。
            </p>
            {pendingBatch.items.length > 0 && (
              <div className="text-[12px]">
                <div className="flex flex-col gap-0.5">
                  {pendingBatch.items.slice(0, 8).map((item) => (
                    <div key={item.jobId}>
                      {item.parentName != null && `${item.parentName} / `}
                      {item.resourceName} →{' '}
                      <span className="mono">{shortDigest(item.candidateDigest)}</span>
                    </div>
                  ))}
                  {pendingBatch.items.length > 8 && <div>等 {pendingBatch.items.length} 项</div>}
                </div>
              </div>
            )}
            {pendingBatch.skippedCount > 0 && (
              <p className="text-[12px]">
                其余 {pendingBatch.skippedCount} 项无待确认任务，将自动跳过。
              </p>
            )}
            {pendingBatch.items.length === 0 && <p>没有可确认的子容器，请调整选择。</p>}
          </>
        )}
      </Modal>
    </>
  );
}

interface ServiceGroupSectionProps {
  filtered: FilteredServiceGroup;
  view: ExclusionView;
  /** 完整 active 子容器（未投影），用于组摘要。 */
  summaryChildren: ResourceDTO[];
  expanded: boolean;
  onToggleExpand: (key: string) => void;
  selected: number[];
  onToggleChild: (id: number, checked: boolean) => void;
  onOpen: (id: number) => void;
  onCheck: (id: number) => void;
  onUpdate: (id: number) => void;
  onConfirm?: (r: ResourceDTO) => void;
  checkingId: number | null;
  updatingId: number | null;
  confirmingId?: number | null;
}

function ServiceGroupSection({
  filtered,
  view,
  summaryChildren,
  expanded,
  onToggleExpand,
  selected,
  onToggleChild,
  onOpen,
  onCheck,
  onUpdate,
  onConfirm,
  checkingId,
  updatingId,
  confirmingId,
}: ServiceGroupSectionProps) {
  const { group, visibleChildren } = filtered;
  const parent = group.parent;
  const summary = groupSummary(summaryChildren);
  // 选择集只用当前页可见且可操作集合：排除视图/排除子项不参与。
  const groupSelectableIds =
    group.orphan || view === 'excluded'
      ? []
      : visibleChildren.filter((c) => !isConfigExcluded(c)).map((c) => c.id);
  const groupSelection = selectionState(groupSelectableIds, selected);
  const bodyId = `svc-body-${group.key}`;
  const name = parent?.name ?? group.parentName ?? '未知服务';
  const orphanParentId = group.children[0]?.parentResourceId ?? null;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={expanded ? `折叠服务 ${name}` : `展开服务 ${name}`}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
          onClick={() => onToggleExpand(group.key)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
        <input
          type="checkbox"
          aria-label={`选择服务 ${name} 的全部子容器`}
          disabled={group.orphan || groupSelectableIds.length === 0}
          checked={groupSelection === 'all'}
          ref={(el) => {
            if (el != null) el.indeterminate = groupSelection === 'some';
          }}
          onChange={(e) => {
            for (const id of groupSelectableIds) onToggleChild(id, e.target.checked);
          }}
        />
        {parent != null ? (
          <button
            type="button"
            className="font-medium text-[var(--color-accent)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            title="打开服务详情"
            onClick={() => onOpen(parent.id)}
          >
            {parent.name}
          </button>
        ) : (
          <span className="font-medium">{name}</span>
        )}
        {group.orphan && <Badge tone="warning">父服务未在当前列表中</Badge>}
        {parent != null && (
          <span className="flex items-center gap-1 text-[12px] text-[var(--color-text-secondary)]">
            父级
            <StatusPill tone={parent.isStopped ? 'danger' : 'success'}>
              {parent.isStopped ? '已停止' : '运行中'}
            </StatusPill>
          </span>
        )}
        <span className="break-words text-[12px] text-[var(--color-text-secondary)]">
          {parent?.serverName ?? '—'}
          {parent?.projectName != null && ` · ${parent.projectName}`}
        </span>
        {view === 'excluded' &&
          parent != null &&
          !isConfigExcluded(parent) &&
          visibleChildren.length > 0 && <Badge tone="neutral">部分子容器已排除</Badge>}
        <span className="ml-auto flex flex-wrap items-center gap-1 text-[12px]">
          <span className="text-[var(--color-text-muted)]">子容器</span>
          <Badge>
            {summary.total}
            {visibleChildren.length < summary.total && ` · 可见 ${visibleChildren.length}`}
          </Badge>
          <Badge tone={summary.candidates > 0 ? 'warning' : 'neutral'}>
            有更新 {summary.candidates}
          </Badge>
          <Badge tone={summary.attention > 0 ? 'danger' : 'neutral'}>
            待配置/受阻 {summary.attention}
          </Badge>
          {summary.excluded > 0 && <Badge>已排除 {summary.excluded}</Badge>}
          {summary.pendingSync > 0 && <Badge tone="warning">待同步 {summary.pendingSync}</Badge>}
          {group.orphan && orphanParentId != null && (
            <Button
              variant="ghost"
              title="查看父服务详情（可能已移除或不存在）"
              onClick={() => onOpen(orphanParentId)}
            >
              查看父服务
            </Button>
          )}
        </span>
      </div>
      {expanded && (
        <div id={bodyId} className="border-t border-[var(--color-border-base)]">
          <ChildResourcesTable
            rows={visibleChildren}
            ariaLabel={`${name} 子容器`}
            selected={selected}
            onToggleSelected={onToggleChild}
            onOpen={onOpen}
            onCheck={onCheck}
            onUpdate={onUpdate}
            onConfirm={onConfirm}
            checkingId={checkingId}
            updatingId={updatingId}
            confirmingId={confirmingId}
            emptyText="该服务暂无子容器。"
          />
        </div>
      )}
    </Card>
  );
}
