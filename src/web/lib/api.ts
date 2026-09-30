// Typed fetch client for the toolkit API.
import type {
  CheckOutcome,
  JobDTO,
  NotificationDTO,
  OverviewDTO,
  Policy,
  ResourceDTO,
  ResourceKind,
  ResourceStatus,
  SettingsDTO,
  TrackDTO,
} from '../../shared/types.js';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const body = (await res.json().catch(() => null)) as
    | { error?: { code: string; message: string } }
    | T
    | null;
  if (!res.ok) {
    const err = (body as { error?: { code: string; message: string } } | null)?.error;
    throw new ApiError(err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

export interface PreviewResult {
  preview: {
    candidateDigest: string;
    candidateReference: string;
    observedAt: string | null;
    referenceKind: string | null;
    previewToken: string;
    impact: { kind: string; parentName: string | null; note: string };
  } | null;
  message?: string;
}

export interface CheckResultDTO {
  resourceId: number;
  outcome: CheckOutcome;
  observedDigest: string | null;
  candidate: boolean;
  message: string | null;
}

/** /api/resources 查询参数：字段间取交集；缺省字段保持服务端默认。 */
export interface ResourceListParams {
  kind?: ResourceKind;
  policy?: Policy;
  status?: ResourceStatus | 'all';
  /** 只返回该父服务的子容器；服务端严格校验十进制正安全整数。 */
  parent?: number;
}

export function resourceListQuery(params: ResourceListParams = {}): string {
  const pairs: string[] = [];
  if (params.kind != null) pairs.push(`kind=${params.kind}`);
  if (params.policy != null) pairs.push(`policy=${params.policy}`);
  if (params.status != null) pairs.push(`status=${params.status}`);
  if (params.parent != null) pairs.push(`parent=${params.parent}`);
  return pairs.join('&');
}

export const api = {
  overview: () => request<OverviewDTO>('/api/overview'),
  resources: (params?: string | ResourceListParams) => {
    const qs = typeof params === 'string' ? params : resourceListQuery(params);
    return request<{ resources: ResourceDTO[] }>(`/api/resources${qs ? `?${qs}` : ''}`);
  },
  /** 服务详情用：按父资源筛选 active 子容器。 */
  resourcesByParent: (parentId: number) =>
    request<{ resources: ResourceDTO[] }>(
      `/api/resources?${resourceListQuery({ parent: parentId })}`,
    ),
  resource: (id: number) =>
    request<{ resource: ResourceDTO; jobs: JobDTO[] }>(`/api/resources/${id}`),
  patchResource: (
    id: number,
    patch: Partial<{
      policy: Policy;
      sourceTag: string;
      targetPlatform: string | null;
      checkCron: string | null;
    }>,
  ) =>
    request<{ resource: ResourceDTO }>(`/api/resources/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  batchPolicy: (resourceIds: number[], policy: Policy) =>
    request<{ updated: number }>('/api/resources/batch-policy', {
      method: 'POST',
      body: JSON.stringify({ resourceIds, policy }),
    }),
  checkResource: (id: number) =>
    request<{ check: CheckResultDTO }>(`/api/resources/${id}/check`, {
      method: 'POST',
      body: '{}',
    }),
  preview: (id: number) =>
    request<PreviewResult>(`/api/resources/${id}/preview`, { method: 'POST', body: '{}' }),
  deployTime: (id: number) =>
    request<{ lastDeployedAt: string | null }>(`/api/resources/${id}/deploy-time`),
  submitUpdate: (id: number, candidateDigest: string, previewToken: string) =>
    request<{ job: JobDTO }>(`/api/resources/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ candidateDigest, previewToken }),
    }),
  /** Skip preview: server takes the latest fresh observation as candidate. */
  executeUpdate: (id: number) =>
    request<{ job?: JobDTO; skipped?: boolean; message?: string }>(`/api/resources/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({ skipPreview: true }),
    }),
  jobs: (status?: string) =>
    request<{ jobs: JobDTO[] }>(`/api/jobs${status ? `?status=${status}` : ''}`),
  retryJob: (id: number) =>
    request<{ job: JobDTO }>(`/api/jobs/${id}/retry`, { method: 'POST', body: '{}' }),
  confirmJob: (id: number, digest: string) =>
    request<{ job: JobDTO }>(`/api/jobs/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ digest }),
    }),
  notifications: () =>
    request<{ notifications: NotificationDTO[]; appriseConfigured: boolean }>('/api/notifications'),
  redeliver: (id: number) =>
    request<{ ok: boolean }>(`/api/notifications/${id}/redeliver`, { method: 'POST', body: '{}' }),
  notifyTest: () =>
    request<{ ok: boolean }>('/api/notifications/test', { method: 'POST', body: '{}' }),
  settings: () => request<SettingsDTO>('/api/settings'),
  patchSettings: (
    patch: Partial<{
      syncCron: string;
      checkCron: string;
      cronTimezone: string;
      globalPaused: boolean;
    }>,
  ) => request<unknown>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  sync: () =>
    request<{
      ok: boolean;
      sync: { resourcesSeen: number; created: number; externalChanges: number; removed: number };
    }>('/api/sync', { method: 'POST', body: '{}' }),
  checkAll: () =>
    request<{ ok: boolean; checked: number }>('/api/check', { method: 'POST', body: '{}' }),
  probe: () =>
    request<{ ok: boolean; version: string | null }>('/api/coolify/probe', {
      method: 'POST',
      body: '{}',
    }),
};

export type { CheckOutcome, Policy, TrackDTO };
