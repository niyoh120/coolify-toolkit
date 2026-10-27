// 通知队列视图：事件、状态、重试与补发。
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
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
import { FEEDBACK } from '../lib/action-feedback.js';
import { api } from '../lib/api.js';
import { useRefresh } from '../main.js';

const EVENT_LABEL: Record<string, string> = {
  candidate_found: '发现候选',
  upstream_changed: '上游变化',
  update_success: '更新完成',
  update_failed: '更新失败',
  submit_unknown: '提交结果未知',
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
  // 补发：ok:false 是业务失败（200），显式展示并刷新队列；请求错误走全局兑底。
  const redeliver = useMutation({
    mutationFn: (id: number) => api.redeliver(id),
    meta: { actionName: '通知补发' },
    onSuccess: async (res) => {
      if (res.ok) {
        toast.success('通知已重新发送', { duration: FEEDBACK.successMs });
      } else {
        toast.error('补发失败', {
          description: '通知保留在队列中，稍后可再次补发。',
          duration: FEEDBACK.errorMs,
          closeButton: true,
        });
      }
      await refresh();
    },
  });

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  const items = data?.notifications ?? [];
  const PAGE_SIZE = 20;
  const pagedItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <h1 className="text-[18px] font-semibold">通知</h1>
      {data?.appriseConfigured === false && (
        <div className="rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-[12px] text-[var(--color-warning)]">
          Apprise 未配置：通知保留在队列中，配置后自动发送。
        </div>
      )}

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardHeader title="通知队列" />
        {items.length === 0 ? (
          <Empty>暂无通知记录。</Empty>
        ) : (
          <>
            <Table ariaLabel="通知队列" fill>
              <thead>
                <tr>
                  <Th className="min-w-[5rem]">事件</Th>
                  <Th className="min-w-[8rem] max-w-[12rem]">资源</Th>
                  <Th className="min-w-[10rem] max-w-[16rem]">标题</Th>
                  <Th className="min-w-[6rem]">状态</Th>
                  <Th className="min-w-[3.5rem]">尝试</Th>
                  <Th className="min-w-[8rem] max-w-[12rem]">错误</Th>
                  <Th className="min-w-[9rem]">时间</Th>
                  <Th className="min-w-[5rem]">操作</Th>
                </tr>
              </thead>
              <tbody>
                {pagedItems.map((n) => (
                  <tr key={n.id} className="hover:bg-[var(--color-bg-overlay)]/40">
                    <Td>{EVENT_LABEL[n.eventType] ?? n.eventType}</Td>
                    <Td className="break-words text-[12px] text-[var(--color-text-secondary)]">
                      {n.resourceName ?? '—'}
                    </Td>
                    <Td>
                      <details data-full-text className="min-w-0">
                        <summary className="cursor-pointer break-words">{n.title}</summary>
                        <div className="pt-1 break-words text-[11px] text-[var(--color-text-secondary)]">
                          {n.body}
                        </div>
                      </details>
                    </Td>
                    <Td>
                      <Badge tone={STATUS_TONE[n.status] ?? 'neutral'}>
                        {STATUS_LABEL[n.status] ?? n.status}
                      </Badge>
                    </Td>
                    <Td>{n.attempts}</Td>
                    <Td>
                      {n.lastError != null ? (
                        <details data-full-text className="min-w-0">
                          <summary className="cursor-pointer break-words text-[var(--color-warning)]">
                            {n.lastError.length > 40 ? `${n.lastError.slice(0, 40)}…` : n.lastError}
                          </summary>
                          <div className="pt-1 break-all text-[11px] text-[var(--color-warning)]">
                            {n.lastError}
                          </div>
                        </details>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>{new Date(n.createdAt).toLocaleString('zh-CN', { hour12: false })}</Td>
                    <Td>
                      {['failed', 'paused'].includes(n.status) && (
                        <Button
                          variant="ghost"
                          onClick={() => redeliver.mutate(n.id)}
                          disabled={redeliver.isPending}
                          aria-busy={redeliver.isPending}
                        >
                          {redeliver.isPending ? '补发中…' : '补发'}
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
