// Shared sub-container table: used by the services tab (inside an expanded
// group) and the service detail page. Renders image/track/deploy/policy
// columns plus inline check & update actions; selection column is optional.

import type { ResourceDTO } from '../../../shared/types.js';
import { checkBlockedHint, policyTone, updateBlockedHint } from '../../lib/resource-view.js';
import { BlockedBadge, CheckBadge, DeployBadge, POLICY_LABEL, shortDigest } from '../status.js';
import { Badge, Button, Empty, Table, Td, Th } from '../ui.js';

export interface ChildResourcesTableProps {
  /** 子容器行（调用方负责筛选后的集合）。 */
  rows: ResourceDTO[];
  /** When provided, renders a selection column bound to these ids. */
  selected?: number[];
  onToggleSelected?: (id: number, checked: boolean) => void;
  onOpen: (id: number) => void;
  onCheck: (id: number) => void;
  onUpdate: (id: number) => void;
  /** Local ids currently running a check/update (busy feedback). */
  checkingId?: number | null;
  updatingId?: number | null;
  emptyText?: string;
}

export function ChildResourcesTable({
  rows,
  selected,
  onToggleSelected,
  onOpen,
  onCheck,
  onUpdate,
  checkingId,
  updatingId,
  emptyText = '该服务暂无子容器。',
}: ChildResourcesTableProps) {
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <Table>
      <thead>
        <tr>
          {selected != null && onToggleSelected != null && (
            <Th className="w-8">
              <span aria-hidden="true" />
            </Th>
          )}
          <Th>名称</Th>
          <Th>镜像 / 追踪来源</Th>
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
        {rows.map((r) => {
          const checkHint = checkBlockedHint(r);
          const updateHint = updateBlockedHint(r);
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
                  className="text-left font-medium whitespace-nowrap text-[var(--color-accent)] hover:underline"
                  onClick={() => onOpen(r.id)}
                >
                  {r.name}
                </button>
                {r.composeServiceName != null && r.composeServiceName !== r.name && (
                  <div className="text-[11px] whitespace-nowrap text-[var(--color-text-muted)]">
                    {r.composeServiceName}
                  </div>
                )}
                <div className="flex flex-wrap gap-1 pt-1">
                  <BlockedBadge blockedReason={r.blockedReason} />
                  {r.excludedInfra && <Badge>已排除</Badge>}
                </div>
              </Td>
              <Td>
                {r.track == null ? (
                  <span className="text-[12px] text-[var(--color-text-muted)]">无追踪</span>
                ) : (
                  <span className="mono text-[12px]">
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
                <div className="flex items-center gap-1">
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
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
