// Shared status rendering rules for tracks and jobs.

import type { BlockReason, TrackDTO } from '../../shared/types.js';
import { api } from '../lib/api.js';
import { Badge, type BadgeTone, Button, Mono } from './ui.js';

export function shortDigest(digest: string | null | undefined): string {
  if (digest == null || digest === '') return '—';
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return hex.slice(0, 12);
}

const CHECK_LABEL: Record<string, { text: string; tone: BadgeTone }> = {
  matching: { text: '无更新', tone: 'success' },
  candidate: { text: '有更新', tone: 'warning' },
  unfixed: { text: '未初始化', tone: 'info' },
  error: { text: '检查失败', tone: 'danger' },
  blocked: { text: '已阻塞', tone: 'neutral' },
};

const DEPLOY_LABEL: Record<string, { text: string; tone: BadgeTone }> = {
  unknown: { text: '部署状态未知', tone: 'neutral' },
  deploying: { text: '部署中', tone: 'info' },
  success: { text: '部署成功', tone: 'success' },
  failed: { text: '部署失败', tone: 'danger' },
  pending_confirmation: { text: '已提交 / 待确认', tone: 'warning' },
};

const BLOCK_LABEL: Record<Exclude<BlockReason, null>, string> = {
  external_change: '外部修改，需重新确认',
  platform_missing: '目标平台待配置',
  excluded: '已排除（基础设施）',
  compose_confirmation_pending: 'Compose 提交待确认',
  stopped: '资源已停止',
  update_failed: '更新失败已暂停',
};

export const POLICY_LABEL: Record<string, string> = {
  ignore: '忽略',
  notify: '通知',
  manual: '手动',
  auto: '自动',
};

export function CheckBadge({ track }: { track: TrackDTO | null }) {
  if (track == null) return <Badge>无追踪</Badge>;
  const info = CHECK_LABEL[track.view.checkOutcome] ?? {
    text: track.view.checkOutcome,
    tone: 'neutral' as BadgeTone,
  };
  return <Badge tone={info.tone}>{info.text}</Badge>;
}

export function DeployBadge({ track }: { track: TrackDTO | null }) {
  if (track == null) return null;
  const info = DEPLOY_LABEL[track.view.deployState] ?? {
    text: track.view.deployState,
    tone: 'neutral' as BadgeTone,
  };
  return <Badge tone={info.tone}>{info.text}</Badge>;
}

export function BlockedBadge({ blockedReason }: { blockedReason: BlockReason }) {
  if (blockedReason == null) return null;
  // 阻塞原因可能较长：允许受控换行，保持完整标签可读。
  return (
    <Badge tone="danger" className="whitespace-normal">
      {BLOCK_LABEL[blockedReason] ?? blockedReason}
    </Badge>
  );
}

const JOB_STATUS: Record<string, { text: string; tone: BadgeTone }> = {
  pending: { text: '排队中', tone: 'neutral' },
  running: { text: '执行中', tone: 'info' },
  success: { text: '成功', tone: 'success' },
  failed: { text: '失败', tone: 'danger' },
  conflict: { text: '冲突', tone: 'warning' },
  unknown_submit: { text: '提交结果未知', tone: 'warning' },
  blocked: { text: '已阻塞', tone: 'neutral' },
};

export function JobStatusBadge({ status }: { status: string }) {
  const info = JOB_STATUS[status] ?? { text: status, tone: 'neutral' as BadgeTone };
  return <Badge tone={info.tone}>{info.text}</Badge>;
}

export function DigestCell({
  label,
  digest,
}: {
  label: string;
  digest: string | null | undefined;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] text-[var(--color-text-muted)]">{label}</span>
      <Mono copyable={digest != null}>{shortDigest(digest)}</Mono>
    </div>
  );
}

export interface CoolifyLinkInput {
  kind: 'application' | 'service_application' | 'compose_service';
  uuid: string;
  projectUuid: string | null;
  environmentUuid: string | null;
  /** Children open their parent service page. */
  parentCoolifyUuid: string | null;
}

/** Coolify v4 UI deep link; null when the required uuids are unknown. */
export function coolifyLink(input: CoolifyLinkInput): string | null {
  const { kind, uuid, projectUuid, environmentUuid, parentCoolifyUuid } = input;
  if (projectUuid == null || environmentUuid == null) return null;
  if (kind === 'application') {
    return `/project/${projectUuid}/environment/${environmentUuid}/application/${uuid}`;
  }
  const serviceUuid = kind === 'service_application' ? (parentCoolifyUuid ?? uuid) : uuid;
  return `/project/${projectUuid}/environment/${environmentUuid}/service/${serviceUuid}`;
}

/** Human-browsable tag list for the supported registries; null when unknown. */
export function registryTagsUrl(registry: string | null, repository: string): string | null {
  if (repository === '') return null;
  const name = repository.split('/').pop() ?? repository;
  if (registry === 'docker.io') return `https://hub.docker.com/r/${repository}/tags`;
  if (registry === 'ghcr.io') {
    return `https://github.com/${repository}/pkgs/container/${name}`;
  }
  if (registry === 'lscr.io') return `https://hub.docker.com/r/linuxserver/${name}/tags`;
  return null;
}

export function CoolifyLinkButton({
  kind,
  uuid,
  projectUuid,
  environmentUuid,
  parentCoolifyUuid,
  baseUrl,
}: CoolifyLinkInput & {
  baseUrl: string;
}) {
  const path = coolifyLink({ kind, uuid, projectUuid, environmentUuid, parentCoolifyUuid });
  if (path == null) {
    return (
      <Button variant="ghost" disabled title="缺少 project/environment UUID，重新同步后可用">
        在 Coolify 打开 ↗
      </Button>
    );
  }
  return (
    <Button variant="ghost" onClick={() => window.open(`${baseUrl}${path}`, '_blank', 'noopener')}>
      在 Coolify 打开 ↗
    </Button>
  );
}

export function retryJob(refresh: () => void) {
  return async (jobId: number) => {
    await api.retryJob(jobId);
    refresh();
  };
}
