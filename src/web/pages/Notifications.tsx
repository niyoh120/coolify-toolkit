// 通知队列视图：事件、状态、重试与补发。
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { BadgeTone } from '../components/ui.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorBox,
  Loading,
  Pagination,
  Table,
  Td,
  Th,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { useRefresh } from '../main.js';

const EVENT_LABEL: Record<string, string> = {
  candidate_found: '发现候选',
  upstream_changed: '上游变化',
  update_success: '更新完成',
  update_failed: '更新失败',
  submit_unknown: '提交待确认',
};

const STATUS_TONE: Record<string, BadgeTone> = {
  sent: 'success',
  pending: 'info',
  failed: 'warning',
  paused: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
  sent: '已发送',
  pending: '待发送',
  failed: '失败（可重试）',
  paused: '已暂停',
};

export function NotificationsPage() {
  const refresh = useRefresh();
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications,
  });
  const redeliver = useMutation({
    mutationFn: (id: number) => api.redeliver(id),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  const items = data?.notifications ?? [];
  const PAGE_SIZE = 20;
  const pagedItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[18px] font-semibold">通知</h1>
      {data?.appriseConfigured === false && (
        <div className="rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-[12px] text-[var(--color-warning)]">
          Apprise 未配置：通知保留在队列中，配置后自动发送。
        </div>
      )}

      <Card>
        <CardHeader title="通知队列" />
        {items.length === 0 ? (
          <Empty>暂无通知记录。</Empty>
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>事件</Th>
                  <Th>资源</Th>
                  <Th>标题</Th>
                  <Th>状态</Th>
                  <Th>尝试</Th>
                  <Th>错误</Th>
                  <Th>时间</Th>
                  <Th>操作</Th>
                </tr>
              </thead>
              <tbody>
                {pagedItems.map((n) => (
                  <tr key={n.id} className="hover:bg-[var(--color-bg-overlay)]/40">
                    <Td>{EVENT_LABEL[n.eventType] ?? n.eventType}</Td>
                    <Td>{n.resourceName ?? '—'}</Td>
                    <Td className="max-w-[280px] truncate" title={n.body}>
                      {n.title}
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[n.status] ?? 'neutral'}>
                        {STATUS_LABEL[n.status] ?? n.status}
                      </Badge>
                    </Td>
                    <Td>{n.attempts}</Td>
                    <Td
                      className="max-w-[220px] truncate text-[var(--color-warning)]"
                      title={n.lastError ?? undefined}
                    >
                      {n.lastError ?? '—'}
                    </Td>
                    <Td>{new Date(n.createdAt).toLocaleString('zh-CN', { hour12: false })}</Td>
                    <Td>
                      {['failed', 'paused'].includes(n.status) && (
                        <Button
                          variant="ghost"
                          onClick={() => redeliver.mutate(n.id)}
                          disabled={redeliver.isPending}
                        >
                          补发
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={PAGE_SIZE} total={items.length} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
