// Shared sub-container table: used by the services tab (inside an expanded
// group) and the service detail page. Renders image/track/deploy/policy
// columns plus inline check & update actions; selection column is optional.

import type { ResourceDTO } from '../../../shared/types.js';
import {
  checkBlockedHint,
  confirmBlockedHint,
  policyTone,
  updateBlockedHint,
} from '../../lib/resource-view.js';
import {
  BlockedBadge,
  CheckBadge,
  DeployBadge,
  ManagementBadge,
  POLICY_LABEL,
  shortDigest,
} from '../status.js';
import { Badge, Button, Empty, Table, Td, Th } from '../ui.js';

export interface ChildResourcesTableProps {
  /** 子容器行（调用方负责筛选后的集合）。 */
  rows: ResourceDTO[];
  /** 滚动 region 的可访问名称，用于区分多个同时存在的子容器表。 */
  ariaLabel: string;
  /** When provided, renders a selection column bound to these ids. */
  selected?: number[];
  onToggleSelected?: (id: number, checked: boolean) => void;
  onOpen: (id: number) => void;
  onCheck: (id: number) => void;
  onUpdate: (id: number) => void;
  /** 单项人工确认；未提供时隐藏该列内按钮（应用 Tab 保持原操作集合）。 */
  onConfirm?: (r: ResourceDTO) => void;
  /** Local ids currently running a check/update/confirm (busy feedback). */
  checkingId?: number | null;
  updatingId?: number | null;
  confirmingId?: number | null;
  emptyText?: string;
}

export function ChildResourcesTable({
  rows,
  ariaLabel,
  selected,
  onToggleSelected,
  onOpen,
  onCheck,
  onUpdate,
  onConfirm,
  checkingId,
  updatingId,
  confirmingId,
  emptyText = '该服务暂无子容器。',
}: ChildResourcesTableProps) {
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <Table ariaLabel={ariaLabel}>
      <thead>
        <tr>
          {selected != null && onToggleSelected != null && (
            <Th className="w-8">
              <span aria-hidden="true" />
            </Th>
          )}
          <Th className="min-w-[10rem] max-w-[16rem]">名称</Th>
          <Th className="min-w-[10rem] max-w-[15rem]">镜像 / 追踪来源</Th>
          <Th className="min-w-[6.5rem]">配置摘要</Th>
          <Th className="min-w-[6.5rem]">上游摘要</Th>
          <Th className="min-w-[5rem]">是否有更新</Th>
          <Th className="min-w-[5rem]">部署</Th>
          <Th className="min-w-[4.5rem]">状态</Th>
          <Th className="min-w-[4.5rem]">策略</Th>
          <Th className="min-w-[13rem]">操作</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const checkHint = checkBlockedHint(r);
          const updateHint = updateBlockedHint(r);
          const confirmHint = confirmBlockedHint(r);
          return (
            <tr key={r.id} className="hover:bg-[var(--color-bg-overlay)]/40">
              {selected != null && onToggleSelected != null && (
                <Td>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${r.name}`}
                    checked={selected.includes(r.id)}
                    onChange={(e) => onToggleSelected(r.id, e.target.checked)}
                  />
                </Td>
              )}
              <Td>
                <button
                  type="button"
                  className="text-left font-medium break-words text-[var(--color-accent)] hover:underline"
                  onClick={() => onOpen(r.id)}
                >
                  {r.name}
                </button>
                {r.composeServiceName != null && r.composeServiceName !== r.name && (
                  <div className="text-[11px] break-words text-[var(--color-text-muted)]">
                    {r.composeServiceName}
                  </div>
                )}
                <div className="flex flex-wrap gap-1 pt-1">
                  <BlockedBadge blockedReason={r.blockedReason} />
                  <ManagementBadge resource={r} />
                </div>
              </Td>
              <Td>
                {r.track == null ? (
                  <span className="text-[12px]">
                    {r.currentImage != null ? (
                      <span className="mono break-all">{r.currentImage}</span>
                    ) : (
                      <span className="text-[var(--color-text-muted)]">—</span>
                    )}
                    <div className="text-[var(--color-text-muted)]">尚未建立追踪</div>
                  </span>
                ) : (
                  <span className="mono break-all text-[12px]">
                    {r.currentImage ?? '—'}
                    <div className="text-[var(--color-text-secondary)]">
                      tag:{' '}
                      {r.track.sourceTag === '' ? (
                        <Badge tone="warning">待配置</Badge>
                      ) : (
                        r.track.sourceTag
                      )}
                    </div>
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
                <Badge tone={r.isStopped ? 'danger' : 'success'}>
                  {r.isStopped ? '已停止' : '运行中'}
                </Badge>
              </Td>
              <Td>
                <Badge tone={policyTone(r.policy)}>{POLICY_LABEL[r.policy]}</Badge>
              </Td>
              <Td>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    disabled={checkHint != null || checkingId === r.id}
                    title={checkHint ?? '检查上游是否有新版本'}
                    onClick={() => onCheck(r.id)}
                  >
                    {checkingId === r.id ? '检查中…' : '检查更新'}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={updateHint != null || updatingId === r.id}
                    title={updateHint ?? '跳过预览，直接按最新观察到的摘要提交更新'}
                    onClick={() => onUpdate(r.id)}
                  >
                    {updatingId === r.id ? '提交中…' : '执行更新'}
                  </Button>
                  {onConfirm != null && (
                    <Button
                      variant="ghost"
                      disabled={confirmHint != null || confirmingId === r.id}
                      title={confirmHint ?? '记录人工确认并解除等待'}
                      onClick={() => onConfirm(r)}
                    >
                      {confirmingId === r.id ? '确认中…' : '确认更新完成'}
                    </Button>
                  )}
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
