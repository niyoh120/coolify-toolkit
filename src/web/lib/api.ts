// Typed fetch client for the toolkit API.
import type {
  JobDTO,
  NotificationDTO,
  OverviewDTO,
  Policy,
  ResourceDTO,
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

export const api = {
  overview: () => request<OverviewDTO>('/api/overview'),
  resources: (params?: string) =>
    request<{ resources: ResourceDTO[] }>(`/api/resources${params ? `?${params}` : ''}`),
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
    request<{ check: { outcome: string; message: string | null } }>(`/api/resources/${id}/check`, {
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

export type { Policy, TrackDTO };
