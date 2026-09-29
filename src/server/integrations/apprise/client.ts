const NOTIFY_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;

export type AppriseMessageType = 'info' | 'success' | 'warning' | 'failure';

export interface AppriseClientOptions {
  apiUrl: string;
  configKey: string;
  tag?: string | null;
  /** HTTP Basic credentials for 已锁定/用户 access modes (password-only allowed). */
  user?: string | null;
  password?: string | null;
  fetchImpl?: typeof fetch;
}

export interface NotifyPayload {
  title: string;
  body: string;
  type: AppriseMessageType;
}

/** Classification driving outbox retry behavior (§7). */
export type AppriseResult =
  | { ok: true }
  | { ok: false; kind: 'missing_config'; message: string; retryable: false }
  | { ok: false; kind: 'config_error'; message: string; retryable: false }
  | {
      ok: false;
      kind: 'rate_limited';
      message: string;
      retryAfterSeconds?: number;
      retryable: true;
    }
  | { ok: false; kind: 'transient'; message: string; retryable: true };

export class AppriseClient {
  private readonly fetchImpl: typeof fetch;
  private readonly basicAuthHeader: string | null;

  constructor(private readonly opts: AppriseClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.password != null || opts.user != null) {
      const raw = `${opts.user ?? ''}:${opts.password ?? ''}`;
      this.basicAuthHeader = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
    } else {
      this.basicAuthHeader = null;
    }
  }

  get endpoint(): string {
    // apprise-api reads tag filters from the query string; the body `tag` field
    // alone is ignored by v2.0.0 stateful (multi) configs.
    const tagQs = this.opts.tag ? `?tags=${encodeURIComponent(this.opts.tag)}` : '';
    return `${this.opts.apiUrl}/notify/${encodeURIComponent(this.opts.configKey)}${tagQs}`;
  }

  async notify(payload: NotifyPayload): Promise<AppriseResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.basicAuthHeader != null ? { Authorization: this.basicAuthHeader } : {}),
        },
        body: JSON.stringify({
          title: payload.title,
          body: payload.body,
          type: payload.type,
          format: 'text',
          ...(this.opts.tag ? { tag: this.opts.tag } : {}),
        }),
      });
      if (res.ok) return { ok: true };
      // 404 and legacy 204-with-success quirk: treat 404 as missing config.
      if (res.status === 404) {
        return {
          ok: false,
          kind: 'missing_config',
          message: 'Apprise config key not found (HTTP 404)',
          retryable: false,
        };
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return {
          ok: false,
          kind: 'config_error',
          message: `Apprise rejected the request (HTTP ${res.status}); check config/auth`,
          retryable: false,
        };
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after'));
        return {
          ok: false,
          kind: 'rate_limited',
          message: 'Apprise rate limited (HTTP 429)',
          retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined,
          retryable: true,
        };
      }
      return {
        ok: false,
        kind: 'transient',
        message: `Apprise error (HTTP ${res.status})`,
        retryable: true,
      };
    } catch (err) {
      const msg =
        err instanceof Error && err.name === 'AbortError'
          ? 'Apprise request timed out'
          : 'Apprise request failed';
      return { ok: false, kind: 'transient', message: msg, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Test notification used from the settings page. */
  async test(): Promise<AppriseResult> {
    return this.notify({
      title: 'Coolify Toolkit',
      body: 'Test notification from Coolify Toolkit settings.',
      type: 'info',
    });
  }
}

export { MAX_ATTEMPTS as APPRISE_MAX_ATTEMPTS };
