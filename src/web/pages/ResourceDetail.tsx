// Resource detail: source/platform editing, check, preview, update, job history.
// Entry point dispatches by resource kind: compose services render the
// aggregated ServiceDetail; everything else renders the single-resource view.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import type { JobDTO, ResourceDTO } from '../../shared/types.js';
import {
  BlockedBadge,
  CheckBadge,
  CoolifyLinkButton,
  DeployBadge,
  JobStatusBadge,
  POLICY_LABEL,
  registryTagsUrl,
  shortDigest,
} from '../components/status.js';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Empty,
  ErrorBox,
  Input,
  Loading,
  Mono,
  Select,
} from '../components/ui.js';
import { api, type Policy, type PreviewResult } from '../lib/api.js';
import { checkBlockedHint, checkOutcomeFeedback, type FeedbackTone } from '../lib/resource-view.js';
import { useRefresh, useRouter } from '../main.js';
import { ServiceDetail } from './ServiceDetail.js';

export function ResourceDetailPage({ id }: { id: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['resource', id],
    queryFn: () => api.resource(id),
  });
  if (isLoading) return <Loading />;
  if (error != null) return <ErrorBox error={error} />;
  if (data == null) return null;
  const { resource, jobs } = data;
  if (resource.kind === 'compose_service') return <ServiceDetail parent={resource} />;
  return <SingleResourceDetail resource={resource} jobs={jobs} />;
}

function SingleResourceDetail({ resource, jobs }: { resource: ResourceDTO; jobs: JobDTO[] }) {
  const id = resource.id;
  const { navigate } = useRouter();
  const refresh = useRefresh();
  const [sourceTag, setSourceTag] = useState<string | null>(null);
  const [checkCron, setCheckCron] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResult['preview'] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkFeedback, setCheckFeedback] = useState<{ text: string; tone: FeedbackTone } | null>(
    null,
  );
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const deployTimeQ = useQuery({
    queryKey: ['deploy-time', id],
    queryFn: () => api.deployTime(id),
  });

  const patch = useMutation({
    mutationFn: (p: Parameters<typeof api.patchResource>[1]) => api.patchResource(id, p),
    onSuccess: () => void refresh(),
  });
  const check = useMutation({
    mutationFn: api.checkResource,
    onSuccess: (res) => {
      // blocked（HTTP 200）不改变任何数据，必须显式展示结果，否则像“没反应”。
      setCheckFeedback(checkOutcomeFeedback(resource.name, res.check.outcome, res.check.message));
      refresh();
    },
    onError: (e) => {
      setCheckFeedback({
        text: `检查失败（${e instanceof Error ? e.message : '请求错误'}）`,
        tone: 'danger',
      });
    },
  });
  const previewMut = useMutation({
    mutationFn: () => api.preview(id),
    onSuccess: (res) => {
      setPreview(res.preview);
      setActionError(res.preview == null ? (res.message ?? '无更新') : null);
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });
  const updateMut = useMutation({
    mutationFn: () => {
      if (preview == null) throw new Error('请先预览');
      return api.submitUpdate(id, preview.candidateDigest, preview.previewToken);
    },
    onSuccess: () => {
      setPreview(null);
      setActionError(null);
      refresh();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });

  const track = resource.track;
  const checkHint = checkBlockedHint(resource);
  const parentResourceId =
    resource.kind === 'service_application' ? resource.parentResourceId : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[18px] font-semibold">{resource.name}</h1>
          <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[12px] text-[var(--color-text-secondary)]">
            <Mono>{resource.coolifyUuid}</Mono>
            {parentResourceId != null ? (
              <button
                type="button"
                className="text-[var(--color-accent)] hover:underline"
                title="打开父服务详情"
                onClick={() => navigate({ page: 'resource', id: parentResourceId })}
              >
                · 父级 {resource.parentName ?? `#${parentResourceId}`}
              </button>
            ) : (
              resource.parentName != null && <span>· 父级 {resource.parentName}</span>
            )}
            {resource.serverName != null && <span>· {resource.serverName}</span>}
            {resource.projectName != null && <span>· {resource.projectName}</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CheckBadge track={track} />
          <DeployBadge track={track} />
          <BlockedBadge blockedReason={resource.blockedReason} />
          <Badge
            tone={
              resource.policy === 'auto'
                ? 'accent'
                : resource.policy === 'notify' || resource.policy === 'manual'
                  ? 'info'
                  : 'neutral'
            }
          >
            {POLICY_LABEL[resource.policy]}
          </Badge>
        </div>
      </div>

      <Card>
        <CardHeader
          title="镜像追踪"
          actions={
            <>
              {track != null &&
                registryTagsUrl(track.sourceRegistry, track.sourceRepository) != null && (
                  <Button
                    variant="ghost"
                    title="浏览该镜像可用的 tags"
                    onClick={() => {
                      const url = registryTagsUrl(track.sourceRegistry, track.sourceRepository);
                      if (url != null) window.open(url, '_blank', 'noopener');
                    }}
                  >
                    查看仓库 tags ↗
                  </Button>
                )}
              <CoolifyLinkButton
                kind={resource.kind}
                uuid={resource.coolifyUuid}
                projectUuid={resource.projectUuid}
                environmentUuid={resource.environmentUuid}
                parentCoolifyUuid={resource.parentCoolifyUuid}
                baseUrl={coolifyBase(settingsQ.data?.coolifyBaseUrlHost)}
              />
            </>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2 lg:col-span-4">
              <span className="text-[11px] text-[var(--color-text-muted)]">镜像</span>
              <div className="mono break-all text-[12px]">{resource.currentImage ?? '—'}</div>
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] text-[var(--color-text-muted)]">目标平台</span>
              <div className="text-[12px]">{track?.targetPlatform ?? '—'}</div>
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] text-[var(--color-text-muted)]">最近部署</span>
              <div className="text-[12px]">{fmtTime(deployTimeQ.data?.lastDeployedAt)}</div>
            </div>
            <div className="flex flex-col">
              <span className="text-[11px] text-[var(--color-text-muted)]">tag 更新时间</span>
              <div className="text-[12px]">{fmtTime(track?.upstreamTagUpdatedAt)}</div>
            </div>
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label
              htmlFor="edit-source-tag"
              className="flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]"
            >
              追踪 tag
              <Input
                id="edit-source-tag"
                value={sourceTag ?? track?.sourceTag ?? ''}
                placeholder="latest / main / 4"
                onChange={(e) => setSourceTag(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => {
                  const p: Parameters<typeof api.patchResource>[1] = {};
                  if (sourceTag != null && sourceTag !== (track?.sourceTag ?? ''))
                    p.sourceTag = sourceTag;
                  if (checkCron != null && checkCron !== (resource.checkCron ?? ''))
                    p.checkCron = checkCron === '' ? null : checkCron;
                  if (Object.keys(p).length > 0) patch.mutate(p);
                }}
                disabled={patch.isPending}
              >
                保存
              </Button>
              <Button
                onClick={() => {
                  setCheckFeedback(null);
                  check.mutate(id);
                }}
                disabled={checkHint != null || check.isPending}
                title={checkHint ?? '检查上游是否有新版本'}
              >
                {check.isPending ? '检查中…' : '检查更新'}
              </Button>
            </div>
            {checkFeedback != null && (
              <div
                role="status"
                className={`col-span-full text-[12px] ${FEEDBACK_TONE_CLASS[checkFeedback.tone]}`}
              >
                {checkFeedback.text}
              </div>
            )}
            <label
              htmlFor="edit-check-cron"
              className="col-span-full flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]"
            >
              检查 cron
              <Input
                id="edit-check-cron"
                value={checkCron ?? resource.checkCron ?? ''}
                placeholder="全局默认"
                className="mono max-w-[280px]"
                onChange={(e) => setCheckCron(e.target.value)}
              />
            </label>
            <div className="col-span-full flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]">
              <span className="text-[11px] text-[var(--color-text-muted)]">策略</span>
              <Select
                value={resource.policy}
                aria-label="策略"
                className="!w-40"
                onChange={(e) => patch.mutate({ policy: e.target.value as Policy })}
              >
                <option value="ignore">忽略</option>
                <option value="notify">通知</option>
                <option value="manual">手动</option>
                <option value="auto">自动</option>
              </Select>
            </div>
          </div>
          {resource.blockedReason === 'external_change' && (
            <div className="rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-[12px] text-[var(--color-warning)]">
              检测到 Coolify
              中的镜像引用被外部修改。核对上方当前镜像与追踪来源，修正后点击「保存」解除阻塞。
            </div>
          )}
          {track?.view.checkOutcome === 'unfixed' && (
            <div className="rounded border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-3 py-2 text-[12px] text-[var(--color-info)]">
              该资源尚未初始化，通过「预览更新 → 确认更新」执行初始化。
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="更新" />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => previewMut.mutate()}
              disabled={previewMut.isPending}
            >
              预览更新
            </Button>
            {preview != null && (
              <Button
                variant="accent"
                onClick={() => updateMut.mutate()}
                disabled={updateMut.isPending}
              >
                确认更新到 {shortDigest(preview.candidateDigest)}
              </Button>
            )}
          </div>
          {actionError != null && (
            <div className="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
              {actionError}
            </div>
          )}
          {preview != null && (
            <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px]">
              <div>
                目标引用：<Mono copyable>{preview.candidateReference}</Mono>（
                {preview.referenceKind === 'index' ? '多架构 index 摘要' : '单 manifest 摘要'}）
              </div>
              <div className="pt-1 text-[var(--color-text-secondary)]">
                影响范围：{preview.impact.note}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="任务历史" />
        {jobs.length === 0 ? (
          <Empty>暂无更新任务。</Empty>
        ) : (
          <CardBody className="flex flex-col gap-3">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} />
            ))}
          </CardBody>
        )}
      </Card>
    </div>
  );
}

function JobCard({ job }: { job: import('../../shared/types.js').JobDTO }): ReactNode {
  const refresh = useRefresh();
  const retry = useMutation({ mutationFn: () => api.retryJob(job.id), onSuccess: refresh });
  const confirm = useMutation({
    mutationFn: () => api.confirmJob(job.id, job.candidateDigest),
    onSuccess: refresh,
  });
  return (
    <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)]/40 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <JobStatusBadge status={job.status} />
        <Badge>{job.kind === 'initial_pin' ? '初始化' : '更新'}</Badge>
        <Badge tone={job.trigger === 'auto' ? 'accent' : 'neutral'}>
          {job.trigger === 'auto' ? '自动' : '手动'}
        </Badge>
        <span>
          {shortDigest(job.priorDigest)} → <Mono>{shortDigest(job.candidateDigest)}</Mono>
        </span>
        {job.deploymentUuid != null && (
          <span className="mono text-[var(--color-text-muted)]">
            部署 {job.deploymentUuid.slice(0, 8)}
          </span>
        )}
        <span className="text-[var(--color-text-muted)]">
          {new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}
        </span>
        <span className="ml-auto flex gap-1.5">
          {['failed', 'conflict', 'blocked'].includes(job.status) && (
            <Button variant="ghost" onClick={() => retry.mutate()} disabled={retry.isPending}>
              同目标重试
            </Button>
          )}
          {job.stage === 'awaiting_confirmation' && (
            <Button variant="accent" onClick={() => confirm.mutate()} disabled={confirm.isPending}>
              我已确认容器正常，记录人工确认
            </Button>
          )}
        </span>
      </div>
      {job.errorMessage != null && (
        <div className="pt-1 text-[var(--color-danger)]">
          {job.errorCode}: {job.errorMessage}
        </div>
      )}
      {job.log.length > 0 && (
        <details className="pt-1">
          <summary className="cursor-pointer text-[var(--color-text-muted)]">执行日志</summary>
          <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-[var(--color-text-secondary)]">
            {job.log.map((entry) => (
              <div key={`${entry.at}:${entry.stage}:${entry.message}`}>
                <span className="mono">
                  {new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>{' '}
                [{entry.stage}] {entry.message}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const FEEDBACK_TONE_CLASS: Record<FeedbackTone, string> = {
  success: 'text-[var(--color-success)]',
  warning: 'text-[var(--color-warning)]',
  info: 'text-[var(--color-info)]',
  danger: 'text-[var(--color-danger)]',
  neutral: 'text-[var(--color-text-secondary)]',
};

function fmtTime(iso: string | null | undefined): string {
  if (iso == null || iso === '') return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function coolifyBase(host: string | null | undefined): string {
  return host != null ? `https://${host}` : '';
}
