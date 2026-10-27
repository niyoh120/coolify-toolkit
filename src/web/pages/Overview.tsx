// Overview: counts, quick actions, global pause.
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSyncAction } from '../components/SyncActionProvider.js';
import { Button, Card, CardBody, CardHeader, ErrorBox, Loading } from '../components/ui.js';
import { FEEDBACK } from '../lib/action-feedback.js';
import { api } from '../lib/api.js';
import { useRefresh } from '../main.js';

function fmtTime(iso: string | null): string {
  if (iso == null) return '从未';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function OverviewPage() {
  const refresh = useRefresh();
  const { syncing, runSync } = useSyncAction();
  const { data, isLoading, error } = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  const checkAll = useMutation({
    mutationFn: api.checkAll,
    meta: { actionName: '立即检查' },
    onSuccess: refresh,
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.patchSettings({ globalPaused: paused }),
    meta: { actionName: '暂停/恢复自动更新' },
    onSuccess: (_res, pausedNext) => {
      toast.success(pausedNext ? '已全局暂停自动更新' : '已恢复自动更新', {
        duration: FEEDBACK.successMs,
      });
      return refresh();
    },
  });

  // 立即检查：HTTP 200 只表示检查请求完成，具体逐项结果见资源列表。
  const onCheckAll = async (): Promise<void> => {
    try {
      const res = await checkAll.mutateAsync();
      toast.success(`检查请求已完成，处理 ${res.checked} 项`, {
        description: '逐项结果以资源列表中的检查徽标为准。',
        duration: FEEDBACK.successMs,
      });
    } catch {
      // 全局 MutationCache.onError 已弹错；这里仅吞掉 rejection。
    }
  };

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  if (data == null) return null;

  const tiles = [
    {
      label: '资源总数',
      value: data.resourcesTotal,
      hint: '含服务父记录、已排除及待同步确认资源',
    },
    { label: '受管理资源', value: data.resourcesManaged },
    { label: '候选更新', value: data.candidates },
    { label: '失败 / 待处理', value: data.failures },
    { label: '待自动检查', value: data.pendingConfirmations },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px] font-semibold">概览</h1>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void runSync()} disabled={syncing} aria-busy={syncing}>
            {syncing ? '同步中…' : '同步资源'}
          </Button>
          <Button
            onClick={() => void onCheckAll()}
            disabled={checkAll.isPending}
            aria-busy={checkAll.isPending}
          >
            {checkAll.isPending ? '检查中…' : '立即检查'}
          </Button>
          <Button
            variant={data.globalPaused ? 'accent' : 'danger'}
            onClick={() => pause.mutate(!data.globalPaused)}
            disabled={pause.isPending}
          >
            {data.globalPaused ? '恢复自动更新' : '全局暂停自动更新'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <Card key={t.label}>
            <CardBody className="py-3">
              <div className="text-[22px] font-semibold">{t.value}</div>
              <div
                className="text-[12px] text-[var(--color-text-secondary)]"
                title={'hint' in t ? t.hint : undefined}
              >
                {t.label}
              </div>
              {'hint' in t && t.hint != null && (
                <div className="pt-0.5 text-[10px] leading-tight text-[var(--color-text-muted)]">
                  {t.hint}
                </div>
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="同步与检查" />
        <CardBody className="grid gap-2 text-[13px] text-[var(--color-text-secondary)] sm:grid-cols-2">
          <div>
            上次资源同步：
            <span className="text-[var(--color-text-primary)]">{fmtTime(data.lastSyncAt)}</span>
          </div>
          <div>
            上次镜像检查：
            <span className="text-[var(--color-text-primary)]">{fmtTime(data.lastCheckAt)}</span>
          </div>
          <div>
            资源同步计划：<span className="mono">{settings.data?.syncCron ?? '—'}</span>（
            {settings.data?.cronTimezone ?? 'UTC'}）
          </div>
          <div>
            检查计划：<span className="mono">{settings.data?.checkCron ?? '—'}</span>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
