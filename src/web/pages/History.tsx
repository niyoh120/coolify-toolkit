// Update history across all resources.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ResourceTabsBar } from '../components/ResourceTabsBar.js';
import { JobStatusBadge, shortDigest } from '../components/status.js';
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Loading,
  Mono,
  Pagination,
  Select,
  Table,
  Td,
  Th,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { useRefresh, useRouter } from '../main.js';

const STATUS_GROUPS = [
  { value: 'all', label: '全部' },
  { value: 'pending,running', label: '进行中' },
  { value: 'failed,conflict,unknown_submit,blocked', label: '需要处理' },
  { value: 'success', label: '成功' },
];

export function HistoryPage() {
  const refresh = useRefresh();
  const { navigate } = useRouter();
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;
  const { data, isLoading, error } = useQuery({
    queryKey: ['jobs', status],
    queryFn: () => api.jobs(status),
    refetchInterval: 5_000,
  });
  const retry = useMutation({ mutationFn: (id: number) => api.retryJob(id), onSuccess: refresh });
  const confirm = useMutation({
    mutationFn: (job: (typeof jobs)[number]) => api.confirmJob(job.id, job.candidateDigest),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  const jobs = data?.jobs ?? [];
  const pagedJobs = jobs.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-4">
      <ResourceTabsBar active="history" />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          aria-label="按状态筛选"
        >
          {STATUS_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </Select>
      </div>
      <Card>
        {jobs.length === 0 ? (
          <Empty>暂无任务记录。</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>资源</Th>
                <Th>类型</Th>
                <Th>变更</Th>
                <Th>状态</Th>
                <Th>部署</Th>
                <Th>错误</Th>
                <Th>时间</Th>
                <Th>操作</Th>
              </tr>
            </thead>
            <tbody>
              {pagedJobs.map((j) => (
                <tr key={j.id} className="hover:bg-[var(--color-bg-overlay)]/40">
                  <Td>
                    <button
                      type="button"
                      className="text-[var(--color-accent)] hover:underline"
                      onClick={() => navigate({ page: 'resource', id: j.resourceId })}
                    >
                      {j.resourceName}
                    </button>
                  </Td>
                  <Td>
                    {j.resourceKind === 'service_application'
                      ? '子容器'
                      : j.resourceKind === 'compose_service'
                        ? 'Compose'
                        : '应用'}
                  </Td>
                  <Td>
                    <span className="mono text-[12px]">
                      {shortDigest(j.priorDigest)} → {shortDigest(j.candidateDigest)}
                    </span>
                  </Td>
                  <Td>
                    <JobStatusBadge status={j.status} />
                    {j.stage === 'awaiting_confirmation' && (
                      <Badge tone="warning" title="Coolify 仅返回 queued，无完成证据">
                        待确认
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    {j.deploymentUuid != null ? (
                      <Mono copyable>{j.deploymentUuid.slice(0, 10)}</Mono>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>
                    {j.errorMessage != null ? (
                      <span
                        className="text-[var(--color-danger)]"
                        title={`${j.errorCode}: ${j.errorMessage}`}
                      >
                        {j.errorCode}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>{new Date(j.createdAt).toLocaleString('zh-CN', { hour12: false })}</Td>
                  <Td>
                    <div className="flex gap-1">
                      {['failed', 'conflict', 'blocked'].includes(j.status) && (
                        <Button
                          variant="ghost"
                          onClick={() => retry.mutate(j.id)}
                          disabled={retry.isPending}
                        >
                          重试
                        </Button>
                      )}
                      {j.stage === 'awaiting_confirmation' && (
                        <Button
                          variant="accent"
                          onClick={() => {
                            if (
                              window.confirm(
                                `确认 ${j.resourceName} 的容器已使用 ${shortDigest(j.candidateDigest)} 正常运行？此操作记录人工确认。`,
                              )
                            ) {
                              confirm.mutate(j);
                            }
                          }}
                          disabled={confirm.isPending}
                        >
                          人工确认
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={jobs.length} onChange={setPage} />
      </Card>
    </div>
  );
}
