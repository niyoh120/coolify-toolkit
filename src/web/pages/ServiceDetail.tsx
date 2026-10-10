// Service detail: aggregates the active sub-containers of one compose service
// and offers group-level operations (check / submit updates / batch policy)
// over that fixed active snapshot. Single-child flows reuse the same
// components as the resources list; job mutual exclusion and manual
// confirmation stay with the existing per-resource task system.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { Policy, ResourceDTO } from '../../shared/types.js';
import { ChildResourcesTable } from '../components/resources/ChildResourcesTable.js';
import {
  type BatchLines,
  type FeedbackLine,
  useBatchRunner,
  useFeedbackLines,
} from '../components/resources/useBatchRunner.js';
import {
  BlockedBadge,
  CoolifyLinkButton,
  POLICY_LABEL,
  shortDigest,
} from '../components/status.js';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorBox,
  Loading,
  Modal,
  Select,
  StatusPill,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import {
  checkBlockedHint,
  groupSummary,
  policyTone,
  updateBlockedHint,
} from '../lib/resource-view.js';
import { useRouter } from '../main.js';

type GroupAction = 'check' | 'update' | 'policy' | null;

/** 确认弹窗中的资源名列表预览：前 8 个 + 剩余数量。 */
function previewNames(list: ResourceDTO[]): string {
  return (
    list
      .slice(0, 8)
      .map((r) => r.name)
      .join('、') + (list.length > 8 ? ` 等 ${list.length} 项` : '')
  );
}

export function ServiceDetail({ parent }: { parent: ResourceDTO }) {
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingAction, setPendingAction] = useState<GroupAction>(null);
  const [pendingPolicy, setPendingPolicy] = useState<Policy>('manual');
  const [feedbackLines] = useFeedbackLines();
  const batchRunner = useBatchRunner();
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  // 整组范围 = 该父级当前 active 子容器快照（服务端 parent 过滤 + 默认 active）。
  const childrenQ = useQuery({
    queryKey: ['resources', 'parent', parent.id],
    queryFn: () => api.resourcesByParent(parent.id),
  });

  if (childrenQ.isLoading) return <Loading />;
  const children = childrenQ.data?.resources ?? [];
  const nameOf = (id: number): string => children.find((r) => r.id === id)?.name ?? `资源 #${id}`;
  const summary = groupSummary(children);
  const checkable = children.filter((r) => checkBlockedHint(r) == null);
  const updatable = children.filter((r) => updateBlockedHint(r) == null);
  // 同服务前一个任务待人工确认：后续任务只能排队，提供进入子容器确认的入口。
  const awaitingChildren = children.filter(
    (r) => r.track?.view.deployState === 'pending_confirmation',
  );
  const groupOpsDisabled =
    parent.status !== 'active' || children.length === 0 || childrenQ.error != null;

  const confirmAction = (): void => {
    const action = pendingAction;
    setPendingAction(null);
    if (action == null) return;
    if (action === 'check') {
      void batchRunner.runChecks(
        checkable.map((r) => r.id),
        nameOf,
      );
    } else if (action === 'update') {
      void batchRunner.runUpdates(
        updatable.map((r) => r.id),
        nameOf,
      );
    } else {
      void batchRunner.runPolicy(
        children.map((r) => r.id),
        pendingPolicy,
      );
    }
    setSelected([]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <button
          type="button"
          className="text-[12px] text-[var(--color-accent)] hover:underline"
          onClick={() => navigate({ page: 'resources', tab: 'services' })}
        >
          ← 返回服务列表
        </button>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div>
            <h1 className="flex items-center gap-2 text-[18px] font-semibold">
              {parent.name}
              <Badge tone="info">服务</Badge>
            </h1>
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[12px] text-[var(--color-text-secondary)]">
              <span className="mono">{parent.coolifyUuid}</span>
              {parent.serverName != null && <span>· {parent.serverName}</span>}
              {parent.projectName != null && (
                <span>
                  · {parent.projectName}
                  {parent.environmentName != null && ` / ${parent.environmentName}`}
                </span>
              )}
              <span className="flex items-center gap-1">
                · 父级
                <StatusPill tone={parent.isStopped ? 'danger' : 'success'}>
                  {parent.isStopped ? '已停止' : '运行中'}
                </StatusPill>
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BlockedBadge blockedReason={parent.blockedReason} />
            <Badge tone={policyTone(parent.policy)} title="父服务的策略保持现状，不随整组操作变更">
              {POLICY_LABEL[parent.policy]}
            </Badge>
            <CoolifyLinkButton
              kind="compose_service"
              uuid={parent.coolifyUuid}
              projectUuid={parent.projectUuid}
              environmentUuid={parent.environmentUuid}
              parentCoolifyUuid={null}
              baseUrl={coolifyBase(settingsQ.data?.coolifyBaseUrlHost)}
            />
          </div>
        </div>
      </div>

      {parent.status === 'removed' && (
        <div className="rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-[12px] text-[var(--color-warning)]">
          该服务在最近一次同步中已被标记为移除，整组操作已禁用。
        </div>
      )}

      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              子容器
              <Badge>{summary.total}</Badge>
              <Badge tone={summary.candidates > 0 ? 'warning' : 'neutral'}>
                有更新 {summary.candidates}
              </Badge>
              <Badge tone={summary.attention > 0 ? 'danger' : 'neutral'}>
                待配置/受阻 {summary.attention}
              </Badge>
            </span>
          }
          actions={
            <>
              <Button
                variant="ghost"
                disabled={groupOpsDisabled || batchRunner.busy}
                title="对整组 active 子容器逐项检查上游摘要"
                onClick={() => setPendingAction('check')}
              >
                整组检查
              </Button>
              <Button
                variant="outline"
                disabled={groupOpsDisabled || batchRunner.busy || updatable.length === 0}
                title="对存在候选或待初始化的子容器逐项提交更新任务"
                onClick={() => setPendingAction('update')}
              >
                整组提交更新
              </Button>
              <Select
                value=""
                aria-label="整组批量设置策略"
                className="!w-auto"
                disabled={groupOpsDisabled || batchRunner.busy}
                onChange={(e) => {
                  const v = e.target.value as Policy | '';
                  if (v !== '') {
                    setPendingPolicy(v);
                    setPendingAction('policy');
                  }
                }}
              >
                <option value="">批量策略…</option>
                <option value="ignore">忽略</option>
                <option value="notify">通知</option>
                <option value="manual">手动</option>
                <option value="auto">自动</option>
              </Select>
            </>
          }
        />
        <CardBody className="flex flex-col gap-3">
          {childrenQ.error != null ? (
            <>
              <ErrorBox error={childrenQ.error} />
              <div>
                <Button variant="outline" onClick={() => void childrenQ.refetch()}>
                  重试
                </Button>
              </div>
            </>
          ) : (
            <>
              {awaitingChildren.length > 0 && (
                <div className="rounded border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-3 py-2 text-[12px] text-[var(--color-info)]">
                  {awaitingChildren.length}{' '}
                  个子容器有已提交、待人工确认的任务，同服务的后续任务将排队。请进入对应子容器详情确认：
                  <span className="flex flex-wrap gap-2 pt-1">
                    {awaitingChildren.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="text-[var(--color-accent)] hover:underline"
                        onClick={() => navigate({ page: 'resource', id: r.id })}
                      >
                        {r.name} ↗
                      </button>
                    ))}
                  </span>
                </div>
              )}
              {batchRunner.progress != null && (
                <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
                  正在执行 {batchRunner.progress.done}/{batchRunner.progress.total}
                  {batchRunner.activeCheckId != null &&
                    `：检查 ${nameOf(batchRunner.activeCheckId)}`}
                  {batchRunner.activeUpdateId != null &&
                    `：提交 ${nameOf(batchRunner.activeUpdateId)}`}
                </div>
              )}
              <ChildResourcesTable
                rows={children}
                ariaLabel="服务子容器"
                selected={selected}
                onToggleSelected={(id, checked) =>
                  setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)))
                }
                onOpen={(id) => navigate({ page: 'resource', id })}
                onCheck={(id) => {
                  void batchRunner.runChecks([id], nameOf);
                }}
                onUpdate={(id) => {
                  void batchRunner.runUpdates([id], nameOf);
                }}
                checkingId={batchRunner.activeCheckId}
                updatingId={batchRunner.activeUpdateId}
                emptyText="该服务暂无 active 子容器。"
              />
              <GroupFeedback batch={batchRunner.result} lines={feedbackLines} />
              {children.length > 0 && (
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  整组操作的范围是该服务当前全部 {children.length} 项 active
                  子容器；任务提交后由既有任务机制执行，部署状态与人工确认在各子容器详情处理。
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Modal
        open={pendingAction != null}
        title="整组操作确认"
        onClose={() => setPendingAction(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingAction(null)}>
              取消
            </Button>
            <Button variant="accent" disabled={batchRunner.busy} onClick={confirmAction}>
              确认执行
            </Button>
          </>
        }
      >
        {pendingAction === 'check' && (
          <>
            <p>
              将对该服务的全部 active 子容器中可检查的 {checkable.length}{' '}
              项逐项检查更新（查询上游最新摘要）。
            </p>
            {checkable.length > 0 && <p className="text-[12px]">{previewNames(checkable)}</p>}
            {checkable.length < children.length && (
              <p className="text-[12px]">
                其余 {children.length - checkable.length}
                项不满足检查条件（忽略策略、无追踪、缺 tag/平台、被排除或外部修改），自动跳过。
              </p>
            )}
          </>
        )}
        {pendingAction === 'update' && (
          <>
            <p>
              将对 {updatable.length}
              项子容器逐项提交更新任务（跳过预览，按最新观察到的摘要提交；HTTP 202
              表示任务已提交，部署与人工确认由任务流程处理）。
            </p>
            {updatable.length > 0 && (
              <div className="text-[12px]">
                <div className="flex flex-col gap-0.5">
                  {updatable.slice(0, 8).map((r) => (
                    <div key={r.id}>
                      {r.name}：{(r.track?.sourceRepository ?? '').split('/').pop()} →{' '}
                      <span className="mono">{shortDigest(r.track?.observedDigest)}</span>
                      {r.track?.configuredDigest == null && '（初始化）'}
                    </div>
                  ))}
                  {updatable.length > 8 && <div>等 {updatable.length} 项</div>}
                </div>
              </div>
            )}
            {updatable.length < children.length && (
              <p className="text-[12px]">
                其余 {children.length - updatable.length}
                项无候选更新或不满足条件，自动跳过；后端校验出的其他阻塞条件会逐项返回并展示。
              </p>
            )}
          </>
        )}
        {pendingAction === 'policy' && (
          <>
            <p>
              将把该服务全部 {children.length} 项 active 子容器的策略设置为「
              {POLICY_LABEL[pendingPolicy]}
              」。
            </p>
            <p className="text-[12px]">{previewNames(children)}</p>
            <p className="text-[12px]">
              父服务策略保持现状；被排除或外部修改的子容器安全状态由既有约束保护。
            </p>
          </>
        )}
      </Modal>
    </div>
  );
}

function GroupFeedback({ batch, lines }: { batch: BatchLines | null; lines: FeedbackLine[] }) {
  if (batch == null && lines.length === 0) return null;
  return (
    <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
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

function coolifyBase(host: string | null | undefined): string {
  return host != null ? `https://${host}` : '';
}
