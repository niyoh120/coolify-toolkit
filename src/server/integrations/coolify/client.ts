// Coolify API client (contract per v4.3.23, verified against routes + controllers).
// All responses pass through zod schemas before any data is used.
import { Agent, fetch as undiciFetch } from 'undici';

import { ApiRequestError, errorCodes } from '../../../shared/errors.js';
import {
  type CoolifyApplication,
  type CoolifyDeployment,
  type CoolifyResourceEntry,
  type CoolifyService,
  type CoolifyServiceApplication,
  coolifyApplicationSchema,
  coolifyDeploymentSchema,
  coolifyResourceEntrySchema,
  coolifyServiceApplicationSchema,
  coolifyServiceSchema,
} from '../../../shared/schemas.js';

const REQUEST_TIMEOUT_MS = 30_000;

type undiciRequestInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

export class CoolifyApiError extends ApiRequestError {
  constructor(
    message: string,
    public readonly statusCode: number | null,
  ) {
    super(errorCodes.coolifyUnavailable, message, 502);
    this.name = 'CoolifyApiError';
  }
}

export interface CoolifyClientOptions {
  baseUrl: string;
  apiKey: string;
  verifyTls: boolean;
  fetchImpl?: typeof undiciFetch;
}

interface RawListEnvelope<_T> {
  data?: unknown;
  meta?: { last_page?: number };
}

async function parseJson(res: globalThis.Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text; // plain-text endpoints (e.g. /version on some builds)
  }
}

/** Extract `data` from both bare-array and {data,meta} pagination shapes. */
function extractList<T>(body: unknown, validate: (item: unknown) => T): T[] {
  let items: unknown;
  if (Array.isArray(body)) {
    items = body;
  } else if (
    typeof body === 'object' &&
    body != null &&
    Array.isArray((body as RawListEnvelope<T>).data)
  ) {
    items = (body as RawListEnvelope<T>).data;
  } else {
    throw new CoolifyApiError('Coolify list response had unexpected shape', null);
  }
  return (items as unknown[]).map((item) => validate(item));
}

export class CoolifyClient {
  private readonly fetchImpl: typeof undiciFetch;
  /** TLS verification wired to COOLIFY_VERIFY_TLS; false = self-signed setups. */
  private readonly dispatcher: Agent;

  constructor(private readonly opts: CoolifyClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? undiciFetch;
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: opts.verifyTls !== false },
    });
  }

  private async request(
    path: string,
    init?: undiciRequestInit,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.opts.baseUrl}/api/v1${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        dispatcher: this.dispatcher,
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          Accept: 'application/json',
          ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
      const body = await parseJson(res);
      return { status: res.status, body };
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? 'Coolify request timed out'
          : 'Coolify request failed';
      throw new CoolifyApiError(msg, null);
    } finally {
      clearTimeout(timer);
    }
  }

  private async expectOk(
    path: string,
    res: { status: number; body: unknown },
  ): Promise<{ status: number; body: unknown }> {
    if (res.status >= 200 && res.status < 300) return res;
    const message =
      typeof (res.body as { message?: unknown })?.message === 'string'
        ? (res.body as { message: string }).message
        : `HTTP ${res.status}`;
    throw new CoolifyApiError(`Coolify ${path}: ${message}`, res.status);
  }

  async version(): Promise<string | null> {
    const res = await this.request('/version');
    if (res.status !== 200) return null;
    // Instance-dependent shape: bare string or {version}.
    if (typeof res.body === 'string') return res.body;
    const v = (res.body as { version?: unknown })?.version;
    return typeof v === 'string' ? v : null;
  }

  /** All applications across pages. Stops on missing meta (single page). */
  async listApplications(): Promise<CoolifyApplication[]> {
    const out: CoolifyApplication[] = [];
    let page = 0;
    for (;;) {
      const res = await this.expectOk(
        '/applications',
        await this.request(`/applications?page=${page}`),
      );
      const body = res.body as RawListEnvelope<unknown>;
      const items = extractList(body, (i) => coolifyApplicationSchema.parse(i));
      out.push(...items);
      const lastPage = typeof body.meta?.last_page === 'number' ? body.meta.last_page : null;
      // Coolify paginates from 0; no meta means single page.
      if (lastPage == null || page >= lastPage) break;
      page += 1;
    }
    return out;
  }

  async getApplication(uuid: string): Promise<CoolifyApplication> {
    const res = await this.expectOk(
      `/applications/${uuid}`,
      await this.request(`/applications/${uuid}`),
    );
    return coolifyApplicationSchema.parse(res.body);
  }

  async patchApplication(uuid: string, patch: Record<string, unknown>): Promise<unknown> {
    const res = await this.expectOk(
      `/applications/${uuid}`,
      await this.request(`/applications/${uuid}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    );
    return res.body;
  }

  /** Returns the deployment uuid from the start response. */
  async startApplication(uuid: string, force = false): Promise<{ deploymentUuid: string | null }> {
    const res = await this.expectOk(
      `/applications/${uuid}/start`,
      await this.request(`/applications/${uuid}/start?${force ? 'force=true' : 'latest=true'}`, {
        method: 'POST',
      }),
    );
    const du = (res.body as { deployment_uuid?: unknown })?.deployment_uuid;
    return { deploymentUuid: typeof du === 'string' ? du : null };
  }

  /** Aggregate resources; used for destination→server mapping and node arch. */
  async listResourceEntries(): Promise<CoolifyResourceEntry[]> {
    const res = await this.expectOk('/resources', await this.request('/resources'));
    return extractList(res.body, (i) => coolifyResourceEntrySchema.parse(i));
  }

  async listServices(): Promise<CoolifyService[]> {
    const out: CoolifyService[] = [];
    let page = 0;
    for (;;) {
      const res = await this.expectOk('/services', await this.request(`/services?page=${page}`));
      const body = res.body as RawListEnvelope<unknown>;
      out.push(...extractList(body, (i) => coolifyServiceSchema.parse(i)));
      const lastPage = typeof body.meta?.last_page === 'number' ? body.meta.last_page : null;
      if (lastPage == null || page >= lastPage) break;
      page += 1;
    }
    return out;
  }

  async getService(uuid: string): Promise<CoolifyService> {
    const res = await this.expectOk(`/services/${uuid}`, await this.request(`/services/${uuid}`));
    return coolifyServiceSchema.parse(res.body);
  }

  async listServiceApplications(serviceUuid: string): Promise<CoolifyServiceApplication[]> {
    const res = await this.expectOk(
      `/services/${serviceUuid}/applications`,
      await this.request(`/services/${serviceUuid}/applications`),
    );
    return extractList(res.body, (i) => coolifyServiceApplicationSchema.parse(i));
  }

  async patchServiceApplication(
    serviceUuid: string,
    appUuid: string,
    patch: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await this.expectOk(
      `/services/${serviceUuid}/applications/${appUuid}`,
      await this.request(`/services/${serviceUuid}/applications/${appUuid}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    );
    return res.body;
  }

  async startServiceApplication(
    serviceUuid: string,
    appUuid: string,
    pullLatest = true,
  ): Promise<void> {
    await this.expectOk(
      `/services/${serviceUuid}/applications/${appUuid}/start`,
      await this.request(
        `/services/${serviceUuid}/applications/${appUuid}/start?latest=${pullLatest ? 'true' : 'false'}`,
        {
          method: 'POST',
        },
      ),
    );
  }

  async getDeploymentsForApplication(appUuid: string): Promise<CoolifyDeployment[]> {
    const res = await this.expectOk(
      `/deployments/applications/${appUuid}`,
      await this.request(`/deployments/applications/${appUuid}`),
    );
    // v4.3.23 wraps this endpoint as { count, deployments: [...] }.
    const raw = res.body as { deployments?: unknown } | unknown[];
    const list = Array.isArray(raw) ? raw : (raw.deployments ?? []);
    return (list as unknown[]).map((i) => coolifyDeploymentSchema.parse(i));
  }

  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    const res = await this.expectOk(
      `/deployments/${deploymentUuid}`,
      await this.request(`/deployments/${deploymentUuid}`),
    );
    return coolifyDeploymentSchema.parse(res.body);
  }

  /** Read-only connectivity probe. */
  async probe(): Promise<{ ok: boolean; version: string | null }> {
    try {
      const version = await this.version();
      return { ok: true, version };
    } catch {
      return { ok: false, version: null };
    }
  }
}
