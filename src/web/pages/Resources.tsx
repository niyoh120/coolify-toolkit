// Resource list: Coolify-style toolbar (tabs, segmented filters, search,
// page size), batch policy, expandable compose children.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Policy } from '../../shared/types.js';
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
  HeadingTab,
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
import { useRefresh, useRouter } from '../main.js';

const KIND_LABEL: Record<string, string> = {
  application: '应用',
  compose_service: '服务',
  service_application: '子容器',
};

const PAGE_SIZES = [10, 20, 50, 100];

type ManagedFilter = 'all' | 'managed';
type KindFilter = '' | 'application' | 'compose_service' | 'service_application';

export function ResourcesPage() {
  const refresh = useRefresh();
  const { navigate } = useRouter();
  const [kind, setKind] = useState<KindFilter>('');
  const [policy, setPolicy] = useState('');
  const [managed, setManaged] = useState<ManagedFilter>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'stopped'>('all');
  const [server, setServer] = useState('');
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['resources', kind, policy],
    queryFn: () =>
      api.resources(
        [kind && `kind=${kind}`, policy && `policy=${policy}`].filter(Boolean).join('&'),
      ),
  });
  const checkOne = useMutation({
    mutationFn: (id: number) => api.checkResource(id),
    onSuccess: refresh,
  });
  const updateOne = useMutation({
    mutationFn: (id: number) => api.executeUpdate(id),
    onSuccess: (res) => {
      if (res.skipped) setBatchResult(res.message ?? '无更新');
      refresh();
    },
    onError: (e) => setBatchResult(`执行更新失败：${e instanceof Error ? e.message : String(e)}`),
  });
  const batch = useMutation({
    mutationFn: (p: Policy) => api.batchPolicy(selected, p),
    onSuccess: () => {
      setSelected([]);
      refresh();
    },
  });
  // 批量结果（按选择顺序串行执行，避免对仓库/接口造成突发压力）。
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [policyChoice, setPolicyChoice] = useState<Policy | ''>('');
  const [pendingBatch, setPendingBatch] = useState<
    { kind: 'check' } | { kind: 'update' } | { kind: 'policy'; policy: Policy } | null
  >(null);
  const runBatchChecks = async () => {
    setBatchBusy(true);
    let ok = 0;
    let failed = 0;
    for (const id of selected) {
      try {
        await api.checkResource(id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    setBatchResult(`检查完成：成功 ${ok}，失败 ${failed}`);
    setSelected([]);
    refresh();
  };
  const runBatchUpdates = async () => {
    setBatchBusy(true);
    let started = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of selected) {
      try {
        const res = await api.executeUpdate(id);
        if (res.skipped) skipped += 1;
        else started += 1;
      } catch {
        failed += 1;
      }
    }
    setBatchBusy(false);
    setBatchResult(`更新完成：已提交 ${started}，无更新跳过 ${skipped}，失败 ${failed}`);
    setSelected([]);
    refresh();
  };

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  // 受管 = 已选择通知或自动更新策略的资源（对应 Coolify 的 Managed 语义）。
  const rows = (data?.resources ?? [])
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
          (r.parentName ?? '').toLowerCase().includes(q) ||
          (r.track?.sourceRepository ?? '').toLowerCase().includes(q),
      )
    : rows;
  const pagedRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  // 受影响数量：检查更新/执行更新只统计真正会执行的资源
  // （忽略策略、无追踪、待配置 tag 的行无法执行，不计入）。
  const selectedRows = rows.filter((r) => selected.includes(r.id));
  const checkableCount = selectedRows.filter(
    (r) => r.policy !== 'ignore' && r.track != null && r.track.sourceTag !== '',
  ).length;
  const updatableCount = selectedRows.filter(
    (r) =>
      r.policy !== 'ignore' &&
      r.track != null &&
      r.track.observedDigest != null &&
      (r.track.view.hasCandidate || r.track.configuredDigest == null),
  ).length;

  const toggle = (id: number, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  };
  const toggleAll = (checked: boolean) =>
    setSelected((prev) => {
      // 全选只作用于当前页（分页语义）。
      const pageSelectable = pagedRows.filter((r) => r.kind !== 'compose_service').map((r) => r.id);
      if (checked) {
        return [...new Set([...prev, ...pageSelectable])];
      }
      return prev.filter((id) => !pageSelectable.includes(id));
    });

  return (
    <div className="flex flex-col gap-4">
      {/* 标题 tab 行：资源 | 更新历史 + 受管/全部分段 + 刷新 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-base)] pb-2">
        <div className="flex items-center gap-5">
          <HeadingTab active>资源</HeadingTab>
          <HeadingTab onClick={() => navigate({ page: 'history' })}>更新历史</HeadingTab>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<ManagedFilter>
            ariaLabel="受管筛选"
            value={managed}
            onChange={(v) => {
              setManaged(v);
              setPage(1);
            }}
            options={[
              { value: 'managed', label: '受管' },
              { value: 'all', label: '全部' },
            ]}
          />
          <Button
            variant="outline"
            title="从 Coolify 重新同步资源"
            onClick={() => {
              void api.sync().then(refresh);
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="mr-1 h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            刷新
          </Button>
        </div>
      </div>

      {/* 工具栏：搜索 + 类型/策略 + 每页条数 */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="按名称搜索资源"
          ariaLabel="搜索资源"
        />
        <Segmented<KindFilter | 'all'>
          ariaLabel="按类型筛选"
          value={kind === '' ? 'all' : kind}
          onChange={(v) => {
            setKind(v === 'all' ? '' : (v as KindFilter));
            setPage(1);
          }}
          options={[
            { value: 'all', label: '全部类型' },
            { value: 'application', label: '应用' },
            { value: 'compose_service', label: '服务' },
            { value: 'service_application', label: '子容器' },
          ]}
        />
        <Segmented<'all' | 'running' | 'stopped'>
          ariaLabel="按运行状态筛选"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setPage(1);
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

      {batchResult != null && (
        <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          {batchResult}
        </div>
      )}

      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[13px]">
          已选 {selected.length} 项：
          <Button
            variant="ghost"
            onClick={() => setPendingBatch({ kind: 'check' })}
            disabled={batchBusy}
          >
            检查更新
          </Button>
          <Button
            variant="outline"
            onClick={() => setPendingBatch({ kind: 'update' })}
            disabled={batchBusy}
            title="跳过预览，直接按最新观察到的摘要提交更新"
          >
            执行更新
          </Button>
          <span className="mx-1 h-4 w-px bg-[var(--color-border-strong)]" aria-hidden="true" />
          <Select
            value={policyChoice}
            aria-label="批量设置策略"
            className="!w-auto"
            disabled={batchBusy}
            onChange={(e) => {
              const v = e.target.value as Policy | '';
              setPolicyChoice('');
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
            <Button
              variant="accent"
              disabled={
                batchBusy ||
                (pendingBatch?.kind === 'check' && checkableCount === 0) ||
                (pendingBatch?.kind === 'update' && updatableCount === 0)
              }
              onClick={() => {
                const pending = pendingBatch;
                setPendingBatch(null);
                if (pending == null) return;
                if (pending.kind === 'check') void runBatchChecks();
                else if (pending.kind === 'update') void runBatchUpdates();
                else batch.mutate(pending.policy);
              }}
            >
              确认执行
            </Button>
          </>
        }
      >
        {pendingBatch?.kind === 'check' && (
          <>
            <p>将对 {checkableCount} 项资源检查更新（查询上游最新摘要）。</p>
            {checkableCount < selectedRows.length && (
              <p className="text-[12px]">
                其余 {selectedRows.length - checkableCount}
                项为忽略策略或无追踪，不会执行。
              </p>
            )}
            {checkableCount === 0 && <p>没有可执行的资源，请调整选择。</p>}
          </>
        )}
        {pendingBatch?.kind === 'update' && (
          <>
            <p>
              将对 {updatableCount} 项资源执行更新（跳过预览，直接按最新观察到的摘要提交部署）。
            </p>
            {updatableCount < selectedRows.length && (
              <p className="text-[12px]">
                其余 {selectedRows.length - updatableCount}
                项为忽略策略、无追踪或无候选更新，不会执行。
              </p>
            )}
            {updatableCount === 0 && <p>没有可执行的资源，请调整选择。</p>}
          </>
        )}
        {pendingBatch?.kind === 'policy' && (
          <p>
            将把 {selectedRows.length} 项资源的策略设置为「
            {POLICY_LABEL[pendingBatch.policy]}
            」。
          </p>
        )}
      </Modal>

      <Card>
        {filtered.length === 0 ? (
          <Empty>
            {rows.length === 0
              ? '暂无资源。请确认 Coolify 连接后点击「刷新」重新同步。新发现资源默认忽略，需要手动选择通知或自动策略。'
              : '没有匹配的资源，请调整搜索或筛选条件。'}
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="全选"
                    checked={
                      pagedRows.length > 0 &&
                      pagedRows
                        .filter((r) => r.kind !== 'compose_service')
                        .every((r) => selected.includes(r.id))
                    }
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                </Th>
                <Th>名称</Th>
                <Th>类型</Th>
                <Th>服务器</Th>
                <Th>追踪来源</Th>
                <Th>配置摘要</Th>
                <Th>上游摘要</Th>
                <Th>是否有更新</Th>
                <Th>部署</Th>
                <Th>状态</Th>
                <Th>策略</Th>
                <Th>操作</Th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((r) => (
                <tr key={r.id} className="hover:bg-[var(--color-bg-overlay)]/40">
                  <Td>
                    {r.kind === 'compose_service' ? (
                      <span />
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={`选择 ${r.name}`}
                        checked={selected.includes(r.id)}
                        onChange={(e) => toggle(r.id, e.target.checked)}
                      />
                    )}
                  </Td>
                  <Td>
                    {r.kind === 'compose_service' ? (
                      <span className="font-medium">{r.name}</span>
                    ) : (
                      <button
                        type="button"
                        className="text-left font-medium whitespace-nowrap text-[var(--color-accent)] hover:underline"
                        onClick={() => navigate({ page: 'resource', id: r.id })}
                      >
                        {r.name}
                      </button>
                    )}
                    {r.parentName != null && (
                      <div className="text-[11px] whitespace-nowrap text-[var(--color-text-muted)]">
                        父级：{r.parentName}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1 pt-1">
                      <BlockedBadge blockedReason={r.blockedReason} />
                      {r.excludedInfra && <Badge>已排除</Badge>}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">{KIND_LABEL[r.kind] ?? r.kind}</Td>
                  <Td className="text-[12px] whitespace-nowrap text-[var(--color-text-secondary)]">
                    {r.serverName ?? '—'}
                  </Td>
                  <Td>
                    {r.track == null ? (
                      '—'
                    ) : (
                      <span className="mono text-[12px]">
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
                    <Badge
                      tone={
                        r.policy === 'auto'
                          ? 'accent'
                          : r.policy === 'notify' || r.policy === 'manual'
                            ? 'info'
                            : 'neutral'
                      }
                    >
                      {POLICY_LABEL[r.policy]}
                    </Badge>
                  </Td>
                  <Td>
                    <Button
                      variant="ghost"
                      disabled={
                        r.policy === 'ignore' ||
                        r.track == null ||
                        r.track.sourceTag === '' ||
                        (checkOne.isPending && checkOne.variables === r.id)
                      }
                      title={
                        r.track == null
                          ? '无镜像追踪'
                          : r.track.sourceTag === ''
                            ? '追踪 tag 待配置，先在详情页填写来源'
                            : r.policy === 'ignore'
                              ? '忽略策略的资源不检查更新'
                              : '检查上游是否有新版本'
                      }
                      onClick={() => checkOne.mutate(r.id)}
                    >
                      {checkOne.isPending && checkOne.variables === r.id ? '检查中…' : '检查更新'}
                    </Button>
                    {(() => {
                      // 有候选（或未初始化且有观察）时允许跳过预览直接执行。
                      const updatable =
                        r.track != null &&
                        r.track.observedDigest != null &&
                        (r.track.view.hasCandidate || r.track.configuredDigest == null) &&
                        !(updateOne.isPending && updateOne.variables === r.id);
                      return (
                        <Button
                          variant="ghost"
                          disabled={!updatable}
                          title={
                            r.track?.view.hasCandidate || r.track?.configuredDigest == null
                              ? '跳过预览，直接按最新观察到的摘要提交更新'
                              : '当前没有可执行的更新'
                          }
                          onClick={() => updateOne.mutate(r.id)}
                        >
                          {updateOne.isPending && updateOne.variables === r.id
                            ? '提交中…'
                            : '执行更新'}
                        </Button>
                      );
                    })()}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={page} pageSize={pageSize} total={filtered.length} onChange={setPage} />
      </Card>
    </div>
  );
}
