// Resources page: applications tab (flat application rows) and services tab
// (service-grouped list with per-group children, batch actions on children).
// Tab state lives in the hash route; switching tabs remounts the view, which
// resets pagination and selection.
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
import {
  buildServiceGroups,
  checkBlockedHint,
  DEFAULT_SERVICE_FILTERS,
  type FilteredServiceGroup,
  filterServiceGroups,
  groupSummary,
  paginateGroups,
  policyTone,
  type ServiceFilters,
  selectableChildIds,
  selectionState,
  serviceServerNames,
  updateBlockedHint,
} from '../lib/resource-view.js';
import { useRouter } from '../main.js';

const PAGE_SIZES = [10, 20, 50, 100];

type ManagedFilter = 'all' | 'managed';
type StatusFilter = 'all' | 'running' | 'stopped';
type PendingBatch =
  | { kind: 'check' }
  | { kind: 'update' }
  | { kind: 'policy'; policy: Policy }
  | null;

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
    <div className="flex flex-col gap-4">
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

// --- applications tab -------------------------------------------------------------

function ApplicationsView() {
  const { navigate } = useRouter();
  const [policy, setPolicy] = useState('');
  const [managed, setManaged] = useState<ManagedFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [server, setServer] = useState('');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch>(null);
  const [feedbackLines, pushFeedback] = useFeedbackLines();
  const batchRunner = useBatchRunner();

  const { data, isLoading, error } = useQuery({
    queryKey: ['resources', 'applications', policy],
    queryFn: () =>
      api.resources({
        kind: 'application',
        policy: policy === '' ? undefined : (policy as Policy),
      }),
  });
  const resources = data?.resources ?? [];
  const nameOf = (id: number): string => resources.find((r) => r.id === id)?.name ?? `资源 #${id}`;
  const checkOne = useCheckOne(nameOf, pushFeedback);
  const updateOne = useUpdateOne(nameOf, pushFeedback);
  // 筛选/分页/每页变化在各自处理器里清空选择，避免隐藏资源混入批量操作。
  const clearSelection = (): void => setSelected([]);

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;

  const rows = resources
    .filter((r) => (managed === 'managed' ? r.policy !== 'ignore' : true))
    .filter((r) =>
      statusFilter === 'all' ? true : statusFilter === 'stopped' ? r.isStopped : !r.isStopped,
    )
    .filter((r) => (server === '' ? true : r.serverName === server));
  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.track?.sourceRepository ?? '').toLowerCase().includes(q),
      )
    : rows;
  const pagedRows = filtered.slice((page - 1) * pageSize, page * pageSize);

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
    } else {
      void batchRunner.runPolicy(
        selectedRows.map((r) => r.id),
        pending.policy,
      );
    }
    setSelected([]);
  };

  return (
    <>
      {/* 工具栏：搜索 + 受管/状态/策略/服务器 + 每页条数 */}
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
        <Segmented<ManagedFilter>
          ariaLabel="受管筛选"
          value={managed}
          onChange={(v) => {
            setManaged(v);
            setPage(1);
            clearSelection();
          }}
          options={[
            { value: 'managed', label: '受管' },
            { value: 'all', label: '全部' },
          ]}
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
          value={policy}
          onChange={(e) => {
            setPolicy(e.target.value);
            setPage(1);
            clearSelection();
          }}
          aria-label="按策略筛选"
        >
          <option value="">全部策略</option>
          <option value="ignore">忽略</option>
          <option value="notify">通知</option>
          <option value="manual">手动</option>
          <option value="auto">自动</option>
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
          {[...new Set(rows.map((r) => r.serverName).filter((n): n is string => n != null))]
            .sort()
            .map((name) => (
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

      <FeedbackArea batch={batchRunner.result} lines={feedbackLines} />

      {selected.length > 0 && (
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
            <option value="ignore">忽略</option>
            <option value="notify">通知</option>
            <option value="manual">手动</option>
            <option value="auto">自动</option>
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
            <Button variant="accent" disabled={batchRunner.busy} onClick={confirmBatch}>
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
              将把 {selectedRows.length} 项资源的策略设置为「
              {POLICY_LABEL[pendingBatch.policy]}
              」。
            </p>
            <p className="text-[12px]">{previewNames(selectedRows)}</p>
          </>
        )}
      </Modal>

      <Card>
        {filtered.length === 0 ? (
          <Empty>
            {rows.length === 0
              ? '暂无应用。请确认 Coolify 连接后点击「刷新」重新同步。新发现资源默认忽略，需要手动选择通知或自动策略。'
              : '没有匹配的应用，请调整搜索或筛选条件。'}
          </Empty>
        ) : (
          <Table ariaLabel="应用列表">
            <thead>
              <tr>
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
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${r.name}`}
                      checked={selected.includes(r.id)}
                      onChange={(e) => toggle(r.id, e.target.checked)}
                    />
                  </Td>
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
                      {r.excludedInfra && <Badge>已排除</Badge>}
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
                        {checkOne.isPending && checkOne.variables === r.id ? '检查中…' : '检查更新'}
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
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination
          page={page}
          pageSize={pageSize}
          total={filtered.length}
          onChange={(p) => {
            setPage(p);
            clearSelection();
          }}
        />
      </Card>
    </>
  );
}

// --- services tab -------------------------------------------------------------------

function ServicesView() {
  const { navigate } = useRouter();
  const [filters, setFilters] = useState<ServiceFilters>(DEFAULT_SERVICE_FILTERS);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pendingBatch, setPendingBatch] = useState<PendingBatch>(null);
  const [feedbackLines] = useFeedbackLines();
  const batchRunner = useBatchRunner();

  const { data, isLoading, error } = useQuery({
    queryKey: ['resources', 'services'],
    queryFn: () => api.resources({ status: 'active' }),
  });
  const resources = data?.resources ?? [];
  const nameOf = (id: number): string => resources.find((r) => r.id === id)?.name ?? `资源 #${id}`;

  const groups = useMemo(() => buildServiceGroups(resources), [resources]);
  const filtered = useMemo(() => filterServiceGroups(groups, filters), [groups, filters]);
  const serverOptions = useMemo(() => serviceServerNames(groups), [groups]);
  const paged = paginateGroups(filtered, page, pageSize);

  // 筛选/分页/每页变化在各自处理器里清空选择；轮询缩减数据时把越界页码修正回有效范围。
  const clearSelection = (): void => setSelected([]);
  useEffect(() => {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page > pages) setPage(pages);
  }, [filtered.length, pageSize, page]);

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;

  const pageSelectable = selectableChildIds(paged);
  const pageSelection = selectionState(pageSelectable, selected);
  const selectedRows = resources.filter((r) => selected.includes(r.id));
  const checkableRows = selectedRows.filter((r) => checkBlockedHint(r) == null);
  const updatableRows = selectedRows.filter((r) => updateBlockedHint(r) == null);

  const toggleChild = (id: number, checked: boolean): void => {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  };
  const togglePageAll = (checked: boolean): void =>
    setSelected((prev) => {
      if (checked) return [...new Set([...prev, ...pageSelectable])];
      return prev.filter((id) => !pageSelectable.includes(id));
    });
  const toggleExpand = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
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
    } else {
      void batchRunner.runPolicy(
        selectedRows.map((r) => r.id),
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
        <Segmented<ManagedFilter>
          ariaLabel="受管筛选"
          value={filters.managed}
          onChange={(v) => {
            setFilters((f) => ({ ...f, managed: v }));
            setPage(1);
            clearSelection();
          }}
          options={[
            { value: 'managed', label: '受管' },
            { value: 'all', label: '全部' },
          ]}
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
            setFilters((f) => ({ ...f, policy: e.target.value as ServiceFilters['policy'] }));
            setPage(1);
            clearSelection();
          }}
          aria-label="按子容器策略筛选"
        >
          <option value="">全部策略</option>
          <option value="ignore">忽略</option>
          <option value="notify">通知</option>
          <option value="manual">手动</option>
          <option value="auto">自动</option>
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
          {serverOptions.map((name) => (
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

      <FeedbackArea batch={batchRunner.result} lines={feedbackLines} />

      <div className="flex flex-wrap items-center gap-3 text-[13px]">
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
              <option value="ignore">忽略</option>
              <option value="notify">通知</option>
              <option value="manual">手动</option>
              <option value="auto">自动</option>
            </Select>
          </span>
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
              expanded={expanded.has(fg.group.key)}
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
              checkingId={batchRunner.activeCheckId}
              updatingId={batchRunner.activeUpdateId}
            />
          ))}
        </div>
      )}
      <Card>
        <Pagination
          page={page}
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
            <Button variant="accent" disabled={batchRunner.busy} onClick={confirmBatch}>
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
              将把 {selectedRows.length} 项子容器的策略设置为「
              {POLICY_LABEL[pendingBatch.policy]}
              」。
            </p>
            <p className="text-[12px]">{previewNames(selectedRows)}</p>
          </>
        )}
      </Modal>
    </>
  );
}

interface ServiceGroupSectionProps {
  filtered: FilteredServiceGroup;
  expanded: boolean;
  onToggleExpand: (key: string) => void;
  selected: number[];
  onToggleChild: (id: number, checked: boolean) => void;
  onOpen: (id: number) => void;
  onCheck: (id: number) => void;
  onUpdate: (id: number) => void;
  checkingId: number | null;
  updatingId: number | null;
}

function ServiceGroupSection({
  filtered,
  expanded,
  onToggleExpand,
  selected,
  onToggleChild,
  onOpen,
  onCheck,
  onUpdate,
  checkingId,
  updatingId,
}: ServiceGroupSectionProps) {
  const { group, visibleChildren } = filtered;
  const parent = group.parent;
  const summary = groupSummary(group.children);
  const groupSelectableIds = group.orphan ? [] : visibleChildren.map((c) => c.id);
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
          disabled={group.orphan}
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
            checkingId={checkingId}
            updatingId={updatingId}
            emptyText="该服务暂无子容器。"
          />
        </div>
      )}
    </Card>
  );
}
