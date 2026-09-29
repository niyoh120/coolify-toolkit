// Settings: schedules, platform, connections, pause; no secrets ever displayed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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

  const patch = useMutation({ mutationFn: api.patchSettings, onSuccess: refresh });
  const probe = useMutation({ mutationFn: api.probe, onSuccess: refresh });
  const notifyTest = useMutation({ mutationFn: api.notifyTest, onSuccess: refresh });

  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  if (data == null) return null;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[18px] font-semibold">设置</h1>

      <Card>
        <CardHeader title="扫描计划" />
        <CardBody className="flex flex-col gap-3">
          <div className="grid items-end gap-3 sm:grid-cols-4">
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
            >
              保存
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Coolify"
          actions={
            <Button variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending}>
              测试连接
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
          <div className="flex items-center gap-2">
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
            >
              发送测试
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
            {data.apprise.tag != null && <span>tag: {data.apprise.tag}</span>}
          </div>
          <div>
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
