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

/** Relative seconds the client should wait before retrying a rate-limited call. */
export interface CoolifyRateLimitDetails {
  /** Upstream status code (429); kept so the UI can distinguish real rate limits. */
  upstreamStatus: number;
  /** Validated Retry-After; omitted when the upstream hint is missing/invalid. */
  retryAfterSeconds?: number;
}

type undiciRequestInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

export class CoolifyApiError extends ApiRequestError {
  constructor(
    message: string,
    public readonly statusCode: number | null,
    /** Validated Retry-After in seconds for upstream 429 responses. */
    public readonly retryAfterSeconds?: number,
    /** Structured details surfaced through the API error envelope. */
    public readonly details?: CoolifyRateLimitDetails,
  ) {
    // 429 maps to downstream 503 with a Retry-After hint; every other status
    // keeps the legacy 502 shape (executor treats statusCode == null as unknown
    // submit outcome, so the numeric status must be preserved).
    super(
      statusCode === 429 ? errorCodes.coolifyRateLimited : errorCodes.coolifyUnavailable,
      message,
      statusCode === 429 ? 503 : 502,
    );
    this.name = 'CoolifyApiError';
  }
}

/**
 * Parse a Retry-After header into whole seconds. Accepts non-negative finite
 * seconds and RFC 7231 HTTP-dates (converted to remaining seconds from now).
 * Invalid, non-finite, negative and non-HTTP-date values yield undefined so
 * callers omit the hint entirely.
 */
export function retryAfterSeconds(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    // 400-digit inputs parse to Infinity; anything non-finite is unusable.
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
  // Date branch: only real HTTP-date formats (IMF-fixdate, RFC 850, asctime).
  // Loose Date.parse would otherwise accept '-9999' as a year far in the future.
  const date = parseHttpDate(value, now);
  if (date === null || !Number.isFinite(date)) return undefined;
  const remaining = Math.ceil((date - now) / 1000);
  return remaining > 0 ? remaining : undefined;
}

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/**
 * Parse the three RFC 7231 HTTP-date forms to an epoch timestamp.
 * All forms express GMT; IMF-fixdate and RFC 850 carry an explicit GMT suffix
 * (Date.parse handles them correctly), while asctime carries none — V8 would
 * parse it in the server's local timezone (TZ-dependent), so it is parsed
 * explicitly as UTC here. Field ranges and real calendar dates are validated
 * (Date.UTC would silently roll 32 Jan into Feb, 00:99 into 01:39); invalid
 * inputs return null.
 */
function parseHttpDate(value: string, now: number): number | null {
  // IMF-fixdate: 'Sun, 06 Nov 1994 08:49:37 GMT'
  const imf = /^(?:[A-Za-z]{3}, )?(\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
    value,
  );
  if (imf !== null) return httpDatePartsToEpoch(imf, Number.parseInt(imf[3] ?? '', 10));
  // RFC 850: 'Sunday, 06-Nov-94 08:49:37 GMT' (2-digit year per RFC 7231)
  const rfc850 = /^[A-Za-z]+, (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
    value,
  );
  if (rfc850 !== null) {
    // RFC 7231: interpret the two-digit year inside a 50-year window relative
    // to the current date, computed on the UTC calendar (add/subtract exactly
    // 50 calendar years — no average-year-length drift at leap boundaries).
    const yy = Number.parseInt(rfc850[3] ?? '', 10);
    const nowDate = new Date(now);
    const currentYear = nowDate.getUTCFullYear();
    const candidateYear = currentYear - (currentYear % 100) + yy;
    const candidate = httpDatePartsToEpoch(rfc850, candidateYear);
    // 日期粒度界限（忽略时刻）：50 个日历年内的同月同日都算在窗口内，
    // 避免 now 之后的时刻抖动（00:01:30 vs 00:00:00）把边界年份推出窗口。
    const futureLimit = Date.UTC(currentYear + 50, nowDate.getUTCMonth(), nowDate.getUTCDate());
    const pastLimit = Date.UTC(currentYear - 50, nowDate.getUTCMonth(), nowDate.getUTCDate());
    const candidateDay =
      candidate === null
        ? null
        : Date.UTC(
            new Date(candidate).getUTCFullYear(),
            new Date(candidate).getUTCMonth(),
            new Date(candidate).getUTCDate(),
          );
    if (candidateDay !== null && candidateDay >= pastLimit && candidateDay <= futureLimit) {
      return candidate;
    }
    // Outside the window (or the candidate rolled over a calendar edge):
    // shift a century toward `now` and re-validate.
    const shiftedYear = candidateYear > currentYear ? candidateYear - 100 : candidateYear + 100;
    return httpDatePartsToEpoch(rfc850, shiftedYear);
  }
  // asctime: 'Sun Nov  6 08:49:37 1994' (no timezone — parse as UTC explicitly)
  const asctime = /^([A-Za-z]{3}) ([A-Za-z]{3}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    value,
  );
  if (asctime !== null) {
    const month = MONTHS[asctime[2] ?? ''];
    if (month === null || month === undefined) return null;
    return utcStrict(
      Number.parseInt(asctime[7] ?? '', 10),
      month,
      Number.parseInt((asctime[3] ?? '').trim(), 10),
      asctime.slice(4, 7).map((g) => Number.parseInt(g ?? '', 10)),
    );
  }
  return null;
}

/** Build an epoch from captured (day, month-name, time) groups + resolved year. */
function httpDatePartsToEpoch(m: RegExpExecArray, year: number): number | null {
  const month = MONTHS[m[2] ?? ''];
  if (month === null || month === undefined) return null;
  return utcStrict(
    year,
    month,
    Number.parseInt(m[1] ?? '', 10),
    m.slice(4, 7).map((g) => Number.parseInt(g ?? '', 10)),
  );
}

/**
 * Strict UTC construction: rejects out-of-range fields and non-calendar dates
 * instead of letting Date.UTC roll them over (32 Jan → 1 Feb, 00:99 → 01:39).
 */
function utcStrict(year: number, month: number, day: number, hms: number[]): number | null {
  // 正则保证三个分组都存在；Number.parseInt 对 undefined 返回 NaN，
  // 由下面的范围检查统一拒绝（严格相等风格下避免逐项 null 判断）。
  const hour = Number.parseInt(String(hms[0]), 10);
  const minute = Number.parseInt(String(hms[1]), 10);
  const second = Number.parseInt(String(hms[2]), 10);
  if (
    !Number.isFinite(year) ||
    day < 1 ||
    day > 31 ||
    Number.isNaN(hour) ||
    hour > 23 ||
    Number.isNaN(minute) ||
    minute > 59 ||
    Number.isNaN(second) ||
    second > 59
  ) {
    return null;
  }
  const d = new Date(Date.UTC(year, month, day, hour, minute, second));
  // Calendar validation: fields must survive the round-trip unchanged.
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day ||
    !Number.isFinite(d.getTime())
  ) {
    return null;
  }
  return d.getTime();
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
  ): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
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
      return {
        status: res.status,
        body,
        // Capture the hint now: it is only meaningful on 429 and would be
        // lost once expectOk throws.
        retryAfterSeconds: retryAfterSeconds(res.headers.get('retry-after')),
      };
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
    res: { status: number; body: unknown; retryAfterSeconds?: number },
  ): Promise<{ status: number; body: unknown }> {
    if (res.status >= 200 && res.status < 300) return res;
    const message =
      typeof (res.body as { message?: unknown })?.message === 'string'
        ? (res.body as { message: string }).message
        : `HTTP ${res.status}`;
    throw new CoolifyApiError(`Coolify ${path}: ${message}`, res.status, res.retryAfterSeconds, {
      upstreamStatus: res.status,
      ...(res.retryAfterSeconds !== undefined && { retryAfterSeconds: res.retryAfterSeconds }),
    });
  }

  async version(): Promise<string | null> {
    // Non-2xx surfaces as CoolifyApiError (via expectOk) so probe() can report
    // a real failure; a 2xx with an unreadable body still degrades to null.
    const res = await this.expectOk('/version', await this.request('/version'));
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
