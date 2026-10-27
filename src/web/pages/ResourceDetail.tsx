// Resource detail: source/platform editing, check, preview, update, job history.
// Entry point dispatches by resource kind: compose services render the
// aggregated ServiceDetail; everything else renders the single-resource view.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import type { AdoptPreviewDTO, JobDTO, ResourceDTO } from '../../shared/types.js';
import {
  BlockedBadge,
  CheckBadge,
  CoolifyLinkButton,
  DeployBadge,
  JobStatusBadge,
  ManagementBadge,
  POLICY_LABEL,
  registryTagsUrl,
  SUCCESS_SOURCE_LABEL,
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
  Modal,
  Mono,
  Select,
} from '../components/ui.js';
import { api, type Policy, type PreviewResult } from '../lib/api.js';
import {
  adoptBlockedHint,
  checkBlockedHint,
  checkOutcomeFeedback,
  type FeedbackTone,
  isConfigReadOnly,
  managementReason,
  managementReasonDetail,
  resetBlockedHint,
  unfixedNotice,
} from '../lib/resource-view.js';
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
  const [adoptPreview, setAdoptPreview] = useState<AdoptPreviewDTO | null>(null);
  const [adoptTag, setAdoptTag] = useState('');
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const [adoptFeedback, setAdoptFeedback] = useState<{ text: string; tone: FeedbackTone } | null>(
    null,
  );
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const deployTimeQ = useQuery({
    queryKey: ['deploy-time', id],
    queryFn: () => api.deployTime(id),
  });

  // F17: any successful state change (save/adopt/reset) invalidates locally
  // cached previews and old feedback — they described the previous state.
  const clearStaleActionState = () => {
    setPreview(null);
    setActionError(null);
    setAdoptPreview(null);
    setAdoptError(null);
    setAdoptTag('');
    setCheckFeedback(null);
  };

  const patch = useMutation({
    mutationFn: (p: Parameters<typeof api.patchResource>[1]) => api.patchResource(id, p),
    onSuccess: (res) => {
      clearStaleActionState();
      setAdoptFeedback({
        text: '保存成功：配置已更新，追踪状态已刷新。',
        tone: 'success',
      });
      void refresh();
      return res;
    },
  });
  const check = useMutation({
    mutationFn: api.checkResource,
    onSuccess: (res) => {
      // blocked（HTTP 200）不改变任何数据，必须显式展示结果，否则像“没反应”。
      setCheckFeedback(checkOutcomeFeedback(resource.name, res.check.outcome, res.check.message));
      void refresh();
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
      clearStaleActionState();
      void refresh();
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : String(e)),
  });
  const adoptPreviewMut = useMutation({
    mutationFn: () => api.adoptPreview(id, adoptTag.trim() !== '' ? adoptTag.trim() : undefined),
    onSuccess: (res) => {
      setAdoptPreview(res.preview);
      setAdoptError(null);
    },
    onError: (e) => setAdoptError(e instanceof Error ? e.message : String(e)),
  });
  const adoptMut = useMutation({
    mutationFn: () => {
      if (adoptPreview == null) throw new Error('请先预览采纳');
      return api.adopt(id, adoptPreview.previewToken);
    },
    onSuccess: (res) => {
      clearStaleActionState();
      setAdoptFeedback({ text: res.message, tone: res.status === 'skipped' ? 'info' : 'success' });
      void refresh();
    },
    onError: (e) => setAdoptError(e instanceof Error ? e.message : String(e)),
  });
  const resetMut = useMutation({
    mutationFn: () => api.resetTracking(id),
    onSuccess: (res) => {
      setResetOpen(false);
      setResetError(null);
      clearStaleActionState();
      setAdoptFeedback({ text: res.message, tone: 'success' });
      void refresh();
    },
    onError: (e) => setResetError(e instanceof Error ? e.message : String(e)),
  });

  const track = resource.track;
  const checkHint = checkBlockedHint(resource);
  const readOnly = isConfigReadOnly(resource);
  const reason = managementReason(resource);
  const reasonDetail = managementReasonDetail(resource);
  const parentResourceId =
    resource.kind === 'service_application' ? resource.parentResourceId : null;
  const adoptHint = adoptBlockedHint(resource);
  const resetHint = resetBlockedHint(resource);
  const externalChange = resource.blockedReason === 'external_change';
  const ignoreUnfixed = unfixedNotice(resource);

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
          <ManagementBadge resource={resource} />
          <Badge
            tone={
              resource.policy === 'auto'
                ? 'accent'
                : resource.policy === 'notify' || resource.policy === 'manual'
                  ? 'info'
                  : 'neutral'
            }
            title={readOnly ? '当前管理受限，已保存策略暂停生效' : undefined}
          >
            {readOnly
              ? `已保存策略：${POLICY_LABEL[resource.policy]}（当前暂停）`
              : POLICY_LABEL[resource.policy]}
          </Badge>
        </div>
      </div>

      {reason != null && reasonDetail != null && (
        <div
          role="note"
          className={`rounded border px-3 py-2 text-[12px] ${
            resource.blockedReason === 'external_change'
              ? 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 text-[var(--color-warning)]'
              : 'border-[var(--color-info)]/40 bg-[var(--color-info)]/5 text-[var(--color-info)]'
          }`}
        >
          <div className="font-medium">{reason}</div>
          <div className="pt-0.5">{reasonDetail}</div>
        </div>
      )}

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
              <span className="text-[11px] text-[var(--color-text-muted)]">
                Coolify 当前配置（同步时读取）
              </span>
              <div className="mono break-all text-[12px]">
                {resource.currentImage != null ? (
                  <Mono copyable>{resource.currentImage}</Mono>
                ) : (
                  '—'
                )}
              </div>
              {track?.configuredReference != null && (
                <div className="pt-1">
                  <span className="text-[11px] text-[var(--color-text-muted)]">已记录配置基线</span>
                  <div className="mono break-all text-[12px]">
                    <Mono copyable>{track.configuredReference}</Mono>
                    {track.configuredDigest == null && (
                      <span className="pl-2 text-[11px] text-[var(--color-text-muted)]">
                        （浮动 tag，摘要待任务确认）
                      </span>
                    )}
                  </div>
                </div>
              )}
              {track == null && (
                <div className="pt-1 text-[11px] text-[var(--color-text-muted)]">
                  尚未建立追踪{reason != null && `（${reason}）`}；镜像修复并同步后自动建立。
                </div>
              )}
              {track != null && (
                <div className="pt-1 text-[11px] text-[var(--color-text-muted)]">
                  追踪渠道：{track.sourceRegistry}/{track.sourceRepository}:{track.sourceTag}
                  {resource.lastSyncedAt != null &&
                    ` · 配置读取时间 ${fmtTime(resource.lastSyncedAt)}`}
                </div>
              )}
              {track?.lastSuccessfulDigest != null && (
                <div className="pt-1">
                  <span className="text-[11px] text-[var(--color-text-muted)]">
                    已确认成功摘要（
                    {SUCCESS_SOURCE_LABEL[track.lastSuccessSource ?? 'deployment'] ?? '部署证据'}）
                  </span>
                  <div className="mono break-all text-[12px]">
                    <Mono copyable>
                      {track.lastSuccessDeploymentUuid == null
                        ? track.lastSuccessfulDigest
                        : `${track.sourceRegistry}/${track.sourceRepository}:${track.lastSuccessfulDigest.replace(/^sha256:/, 'sha256-')}`}
                    </Mono>
                    <span className="pl-2 text-[11px] text-[var(--color-text-muted)]">
                      {fmtTime(track.lastSuccessAt)}
                    </span>
                  </div>
                </div>
              )}
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
                disabled={readOnly}
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
                disabled={readOnly || patch.isPending}
                title={readOnly ? '当前管理受限，配置只读' : undefined}
              >
                {externalChange ? '保存并确认当前配置' : '保存'}
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
                disabled={readOnly}
                onChange={(e) => setCheckCron(e.target.value)}
              />
            </label>
            <div className="col-span-full flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]">
              <span className="text-[11px] text-[var(--color-text-muted)]">策略</span>
              {readOnly ? (
                <span title="当前管理受限，策略只读">{POLICY_LABEL[resource.policy]}（只读）</span>
              ) : (
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
              )}
            </div>
          </div>
          {patch.isError && (
            <div role="alert" className="text-[12px] text-[var(--color-danger)]">
              本次保存未完成：{patch.error instanceof Error ? patch.error.message : '请求错误'}。
              状态已刷新，请核对后重试。
            </div>
          )}
          {externalChange && (
            <div className="rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 px-3 py-2 text-[12px] text-[var(--color-warning)]">
              检测到 Coolify 中的镜像引用被外部修改。旧基线已保留在上方「已记录配置基线」；
              核对后用下方「采纳当前镜像并更新」接管新配置，或在镜像追踪卡片修改追踪 tag
              后点「保存并确认当前配置」（保存会采纳现场为新基线并解除阻塞）。
            </div>
          )}
          {ignoreUnfixed != null ? (
            <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
              {ignoreUnfixed}
            </div>
          ) : (
            track?.view.checkOutcome === 'unfixed' &&
            !readOnly && (
              <div className="rounded border border-[var(--color-info)]/40 bg-[var(--color-info)]/5 px-3 py-2 text-[12px] text-[var(--color-info)]">
                该资源尚未初始化，下次检查（定时或手动「检查更新」）将自动创建初始化任务；也可通过
                「预览更新 → 确认更新」立即执行。
              </div>
            )
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="更新" />
        <CardBody className="flex flex-col gap-3">
          {readOnly && (
            <div className="text-[12px] text-[var(--color-text-muted)]">
              当前资源管理受限（{reason}），更新操作已停用；核对 Coolify 配置并同步后恢复。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => previewMut.mutate()}
              disabled={readOnly || previewMut.isPending}
              title={readOnly ? '当前管理受限' : undefined}
            >
              预览更新
            </Button>
            {preview != null && (
              <Button
                variant="accent"
                className="whitespace-normal"
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
            <div className="break-words rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px]">
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
        <CardHeader title="恢复管理" />
        <CardBody className="flex flex-col gap-3">
          {adoptFeedback != null && (
            <div role="status" className={`text-[12px] ${FEEDBACK_TONE_CLASS[adoptFeedback.tone]}`}>
              {adoptFeedback.text}
            </div>
          )}
          <div className="text-[12px] text-[var(--color-text-secondary)]">
            绕过 toolkit 手动改过镜像或外部修改阻塞时，从这里恢复：采纳会把 Coolify
            当前配置作为新基线并按需部署一次；重置则停止管理并清空追踪账本（Coolify
            配置与任务历史保留）。
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setAdoptError(null);
                setAdoptFeedback(null);
                adoptPreviewMut.mutate();
              }}
              disabled={adoptHint != null || adoptPreviewMut.isPending}
              title={adoptHint ?? '把 Coolify 当前镜像采纳为新追踪渠道，并按需更新'}
            >
              {adoptPreviewMut.isPending ? '读取中…' : '采纳当前镜像并更新'}
            </Button>
            <label
              htmlFor="adopt-source-tag"
              className="flex flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]"
            >
              <span className="text-[11px] text-[var(--color-text-muted)]">
                追踪 tag（可选，覆盖现场 tag）
              </span>
              <Input
                id="adopt-source-tag"
                value={adoptTag}
                placeholder="默认取 Coolify 当前 tag"
                className="max-w-[220px]"
                disabled={adoptHint != null || adoptPreviewMut.isPending || adoptPreview != null}
                onChange={(e) => setAdoptTag(e.target.value)}
              />
            </label>
            <Button
              variant="ghost"
              onClick={() => {
                setResetError(null);
                setResetOpen(true);
              }}
              disabled={resetHint != null || resetMut.isPending}
              title={resetHint ?? '停止管理并清空追踪账本（本地操作，Coolify 可达性无关）'}
            >
              重置追踪并忽略
            </Button>
          </div>
          {adoptHint != null && (
            <div className="text-[12px] text-[var(--color-text-muted)]">采纳停用：{adoptHint}</div>
          )}
          {resetHint != null && (
            <div className="text-[12px] text-[var(--color-text-muted)]">重置停用：{resetHint}</div>
          )}
          {adoptError != null && (
            <div
              role="alert"
              className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-3 py-2 text-[12px] text-[var(--color-danger)]"
            >
              {adoptError}
            </div>
          )}
          {adoptPreview != null && (
            <div className="break-words rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] px-3 py-2 text-[12px]">
              <div className="font-medium">确认采纳</div>
              <div className="pt-1">
                原追踪渠道：{track?.sourceRegistry}/{track?.sourceRepository}:
                {track?.sourceTag ?? '（未配置）'}
              </div>
              <div>
                Coolify 实时配置：
                <Mono copyable>{adoptPreview.liveReference}</Mono>
              </div>
              <div>
                将采用的渠道：{adoptPreview.channel.registry}/{adoptPreview.channel.repository}:
                {adoptPreview.channel.tag}
                {adoptPreview.channel.source === 'user_tag' && '（你填写的 tag）'}
              </div>
              {adoptPreview.channel.source !== 'user_tag' && adoptTag.trim() !== '' && (
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  注意：输入框中的 tag「{adoptTag}」未用于本次预览；清空或重新预览后生效。
                </div>
              )}
              <div>
                目标完整引用（预览时解析）：
                <Mono copyable>{adoptPreview.targetReference}</Mono>
              </div>
              <div className="pt-1 text-[var(--color-text-secondary)]">
                影响范围：{adoptPreview.impact.note}；解析时间
                {new Date(adoptPreview.resolvedAt).toLocaleString('zh-CN', { hour12: false })}。
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button
                  variant="accent"
                  onClick={() => adoptMut.mutate()}
                  disabled={adoptMut.isPending}
                >
                  {adoptMut.isPending ? '提交中…' : '确认采纳'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setAdoptPreview(null)}
                  disabled={adoptMut.isPending}
                >
                  取消
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={resetOpen}
        title="重置追踪并忽略"
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setResetOpen(false)}
              disabled={resetMut.isPending}
            >
              取消
            </Button>
            <Button
              variant="accent"
              onClick={() => resetMut.mutate()}
              disabled={resetMut.isPending}
            >
              {resetMut.isPending ? '执行中…' : '确认重置'}
            </Button>
          </>
        }
      >
        <div>此操作会：</div>
        <ul className="list-disc pl-5">
          <li>停止后续检查与自动更新（策略置为忽略）</li>
          <li>清空追踪账本（基线、观察、成功证据投影）</li>
          <li>保留 Coolify 配置与任务历史</li>
        </ul>
        <div>重新选择管理策略即可恢复管理；恢复后下一次检查会按所选策略初始化或检查。</div>
        {resetError != null && (
          <div role="alert" className="text-[12px] text-[var(--color-danger)]">
            本次重置未执行：{resetError}
          </div>
        )}
      </Modal>

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
  const [actionError, setActionError] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => api.retryJob(job.id),
    onSuccess: () => {
      setActionError(null);
      void refresh();
    },
    onError: (e) =>
      setActionError(`本次重试未执行：${e instanceof Error ? e.message : '请求错误'}`),
  });
  const confirm = useMutation({
    mutationFn: () => api.confirmJob(job.id, job.candidateDigest),
    onSuccess: () => {
      setActionError(null);
      void refresh();
    },
    onError: (e) =>
      setActionError(`本次确认未完成：${e instanceof Error ? e.message : '请求错误'}`),
  });
  const awaiting = job.status === 'running' && job.stage === 'awaiting_confirmation';
  return (
    <div className="rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)]/40 px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <JobStatusBadge status={job.status} awaiting={awaiting} />
        <Badge>{job.kind === 'initial_pin' ? '初始化' : '更新'}</Badge>
        <Badge tone={job.trigger === 'auto' ? 'accent' : 'neutral'}>
          {job.trigger === 'auto' ? '自动' : '手动'}
        </Badge>
        <span>
          {shortDigest(job.priorDigest)} → <Mono>{shortDigest(job.candidateDigest)}</Mono>
        </span>
        {job.successSource != null && (
          <Badge tone="neutral">
            {SUCCESS_SOURCE_LABEL[job.successSource] ?? job.successSource}
          </Badge>
        )}
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
          {awaiting && (
            <Button
              variant="accent"
              className="whitespace-normal"
              title="记录人工确认并解除等待；也可等提交约 60 秒后的单次自动检查"
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending}
            >
              我已确认容器正常，记录人工确认
            </Button>
          )}
        </span>
      </div>
      {awaiting && job.confirmationDueAt != null && (
        <div className="pt-1 text-[var(--color-text-secondary)]">
          提交约 60 秒后自动检查一次运行状态（预计{' '}
          {new Date(job.confirmationDueAt).toLocaleTimeString('zh-CN', { hour12: false })}，受 5
          秒轮询与负载影响）；期间可随时人工确认。
        </div>
      )}
      {job.errorMessage != null && (
        <div className="pt-1 break-all text-[var(--color-danger)]">
          {job.errorCode}: {job.errorMessage}
        </div>
      )}
      {actionError != null && (
        <div role="alert" className="pt-1 text-[var(--color-danger)]">
          {actionError}
        </div>
      )}
      {job.log.length > 0 && (
        <details className="pt-1">
          <summary className="cursor-pointer text-[var(--color-text-muted)]">执行日志</summary>
          <div className="mt-1 flex flex-col gap-0.5 text-[11px] text-[var(--color-text-secondary)]">
            {job.log.map((entry) => (
              <div key={`${entry.at}:${entry.stage}:${entry.message}`} className="break-all">
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
