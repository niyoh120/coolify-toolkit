// Local OCI/Docker-registry HTTP fixture for offline adapter contract tests.
// Serves raw bytes so digests can be verified against original payloads.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const ctManifest = 'application/vnd.docker.distribution.manifest.v2+json';
export const ctList = 'application/vnd.docker.distribution.manifest.list.v2+json';
export const ctOciManifest = 'application/vnd.oci.image.manifest.v1+json';
export const ctOciIndex = 'application/vnd.oci.image.index.v1+json';

export function sha256(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export interface StoredManifest {
  /** Reference to serve under (tag or digest). */
  ref: string;
  contentType: string;
  /** Exact bytes; digest tests rely on preserved whitespace/key order. */
  body: string;
}

export interface FixtureOptions {
  /** When set, unauthenticated reads get a 401 Bearer challenge. */
  requireToken?: boolean;
  /** Status to serve for the configured "flaky" repository (e.g. 429). */
  flakyStatus?: number;
  flakyRepo?: string;
  /** Extra Retry-After header for the flaky response. */
  retryAfter?: string;
  /** Count requests; exposed via .requestLog(). */
}

export interface LoggedRequest {
  method: string;
  url: string;
  authorization: string | null;
  accept: string | null;
}

export class RegistryFixture {
  private server: Server | null = null;
  private manifests = new Map<string, StoredManifest>(); // key: repo|ref
  private requestLog: LoggedRequest[] = [];
  private tokens = new Set<string>();

  constructor(private readonly opts: FixtureOptions = {}) {}

  putManifest(repo: string, manifest: StoredManifest): void {
    this.manifests.set(`${repo}|${manifest.ref}`, manifest);
  }

  requestLogSnapshot(): LoggedRequest[] {
    return [...this.requestLog];
  }

  issueToken(): string {
    const t = `tok-${Math.random().toString(36).slice(2)}`;
    this.tokens.add(t);
    return t;
  }

  async start(port = 0): Promise<{ host: string; port: number }> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (addr == null || typeof addr === 'string') throw new Error('fixture listen failed');
    return { host: 'localhost', port: addr.port };
  }

  async stop(): Promise<void> {
    if (this.server != null) {
      await new Promise<void>((resolve, reject) =>
        this.server!.close((err) => (err == null ? resolve() : reject(err))),
      );
      this.server = null;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requestLog.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization ?? null,
      accept: Array.isArray(req.headers.accept)
        ? req.headers.accept[0]
        : (req.headers.accept ?? null),
    });

    if (this.opts.requireToken === true) {
      const auth = req.headers.authorization;
      const isTokenReq = (req.url ?? '').startsWith('/token');
      if (
        !isTokenReq &&
        (typeof auth !== 'string' || !this.tokens.has(auth.slice('Bearer '.length)))
      ) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer realm="http://registry.test.local/token",service="registry.test"`,
        });
        res.end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
        return;
      }
    }

    if ((req.url ?? '').startsWith('/token')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: this.issueToken(), expires_in: 300 }));
      return;
    }

    // /v2/<repo>/manifests/<ref>
    const m = /^\/v2\/(.+)\/manifests\/([^/]+)$/.exec(req.url ?? '');
    if (m == null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }));
      return;
    }
    const [, repo, ref] = m;
    if (this.opts.flakyRepo === repo && this.opts.flakyStatus != null) {
      const headers: Record<string, string | number> = { 'Content-Type': 'application/json' };
      if (this.opts.retryAfter != null) headers['Retry-After'] = this.opts.retryAfter;
      res.writeHead(this.opts.flakyStatus, headers);
      res.end(JSON.stringify({ errors: [{ code: 'TOOMANYREQUESTS' }] }));
      return;
    }
    const stored =
      this.manifests.get(`${repo}|${ref}`) ??
      // Digest lookups for platform sub-manifests.
      [...this.manifests.values()].find(
        (v) => sha256(v.body) === ref || `sha256-${sha256(v.body).slice(7)}` === ref,
      );
    if (stored == null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': stored.contentType,
      'Docker-Content-Digest': sha256(stored.body),
      'Content-Length': Buffer.byteLength(stored.body),
    });
    res.end(stored.body);
  }
}
