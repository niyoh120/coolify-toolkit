// Settings: schedules, platform, connections, pause; no secrets ever displayed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorBox,
  Input,
  Loading,
  TimezoneSelect,
} from '../components/ui.js';
import { FEEDBACK } from '../lib/action-feedback.js';
import { api } from '../lib/api.js';
import { useRefresh } from '../main.js';

function fmtTime(iso: string | null): string {
  if (iso == null) return '从未';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function SettingsPage() {
  const refresh = useRefresh();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [syncCron, setSyncCron] = useState<string | null>(null);
  const [checkCron, setCheckCron] = useState<string | null>(null);
  const [tz, setTz] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: api.patchSettings,
    meta: { actionName: '保存设置' },
    onSuccess: () => {
      toast.success('设置已保存', { duration: FEEDBACK.successMs });
      return refresh();
    },
  });
  // probe：HTTP 失败走全局兑底；ok:false 是业务失败（200），在此显式展示。
  const probe = useMutation({
    mutationFn: api.probe,
    meta: { actionName: 'Coolify 连接测试' },
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(
          res.version != null ? `Coolify 连接正常（${res.version}）` : 'Coolify 连接正常',
          { duration: FEEDBACK.successMs },
        );
      } else {
        toast.error('Coolify 连接失败', {
          description: '无法读取 Coolify 版本接口，请检查地址与凭证。',
          duration: FEEDBACK.errorMs,
          closeButton: true,
        });
      }
      return refresh();
    },
  });
  // notifyTest：服务端失败时先落库再抛 502，onSettled 统一刷新，
  // 让「上次测试」在失败后也立即反映真实状态（错误提示仍由全局兑底弹一次）。
  const notifyTest = useMutation({
    mutationFn: api.notifyTest,
    meta: { actionName: '测试通知发送' },
    onSettled: (_res, error) => {
      void refresh();
      if (error == null) {
        toast.success('测试通知已发送', { duration: FEEDBACK.successMs });
      }
    },
  });

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  if (data == null) return null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[18px] font-semibold">设置</h1>

      <Card>
        <CardHeader title="扫描计划" />
        <CardBody className="flex flex-col gap-3">
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label
              htmlFor="set-sync-cron"
              className="flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]"
            >
              资源同步 cron
              <Input
                id="set-sync-cron"
                value={syncCron ?? data.syncCron}
                onChange={(e) => setSyncCron(e.target.value)}
                className="mono"
              />
            </label>
            <label
              htmlFor="set-check-cron"
              className="flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]"
            >
              镜像检查 cron
              <Input
                id="set-check-cron"
                value={checkCron ?? data.checkCron}
                onChange={(e) => setCheckCron(e.target.value)}
                className="mono"
              />
            </label>
            <label
              htmlFor="set-tz"
              className="flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]"
            >
              时区
              <TimezoneSelect
                id="set-tz"
                value={tz ?? data.cronTimezone ?? 'UTC'}
                onChange={(v) => setTz(v)}
              />
            </label>
          </div>
          <div>
            <Button
              onClick={() =>
                patch.mutate({
                  ...(syncCron != null && syncCron !== data.syncCron ? { syncCron } : {}),
                  ...(checkCron != null && checkCron !== data.checkCron ? { checkCron } : {}),
                  ...(tz != null && tz !== data.cronTimezone ? { cronTimezone: tz } : {}),
                })
              }
              disabled={patch.isPending}
              aria-busy={patch.isPending}
            >
              {patch.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Coolify"
          actions={
            <Button
              variant="outline"
              onClick={() => probe.mutate()}
              disabled={probe.isPending}
              aria-busy={probe.isPending}
            >
              {probe.isPending ? '探测中…' : '测试连接'}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2">
            状态：
            {data.coolifyConnected == null ? (
              <Badge>未探测</Badge>
            ) : data.coolifyConnected ? (
              <Badge tone="success">已连接 {data.coolifyVersion ?? ''}</Badge>
            ) : (
              <Badge tone="danger">连接失败</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            地址：<span className="mono">{data.coolifyBaseUrlHost || '—'}</span>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Apprise 通知服务"
          actions={
            <Button
              variant="outline"
              onClick={() => notifyTest.mutate()}
              disabled={notifyTest.isPending || !data.apprise.configured}
              aria-busy={notifyTest.isPending}
            >
              {notifyTest.isPending ? '发送中…' : '发送测试'}
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <div className="flex items-center gap-2">
            状态：
            {data.apprise.configured ? (
              <Badge tone="success">已配置</Badge>
            ) : (
              <Badge tone="warning">未配置</Badge>
            )}
            {data.apprise.authConfigured && <Badge tone="info">已配置认证</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            地址：<span className="mono">{data.apprise.apiUrlHost || '—'}</span>
            {data.apprise.tag != null && (
              <span className="break-words">tag: {data.apprise.tag}</span>
            )}
          </div>
          <div className="break-words">
            上次测试：
            {data.apprise.lastTestOk == null
              ? '未测试'
              : data.apprise.lastTestOk
                ? `成功 · ${fmtTime(data.apprise.lastTestAt)}`
                : `失败（${data.apprise.lastTestError ?? ''}） · ${fmtTime(data.apprise.lastTestAt)}`}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
