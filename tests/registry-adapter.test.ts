// Registry adapter contract tests against the real SDK + local fixture (offline).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AdapterOverrides } from '../src/server/integrations/registry/adapter.js';
import {
  ghcrTagUpdatedAt,
  RegistryFailure,
  resolveTagDigest,
} from '../src/server/integrations/registry/adapter.js';
import {
  ctList,
  ctManifest,
  ctOciIndex,
  ctOciManifest,
  RegistryFixture,
  sha256,
} from './fixtures/registry-server.js';

let fixture: RegistryFixture;
let endpoint: { host: string; port: number };
let overrides: AdapterOverrides;

// Single-arch Docker manifest with odd whitespace/key order (byte-preservation).
const singleBody = `{"schemaVersion":2,  "mediaType":"${ctManifest}","config":{"mediaType":"application/vnd.docker.container.image.v1+json","size":1,"digest":"sha256:${'b'.repeat(64)}"},"layers":[]}`;

beforeAll(async () => {
  fixture = new RegistryFixture();

  fixture.putManifest('app/single', { ref: 'latest', contentType: ctManifest, body: singleBody });
  // Multi-arch Docker manifest list (amd64 + arm64), spaced formatting.
  const amd = `sha256:${'c'.repeat(64)}`;
  const arm = `sha256:${'d'.repeat(64)}`;
  const listBody = `{"schemaVersion":2, "mediaType":"${ctList}",\n "manifests":[{"mediaType":"${ctManifest}","size":528,"digest":"${amd}","platform":{"architecture":"amd64","os":"linux"}},{"mediaType":"${ctManifest}","size":528,"digest":"${arm}","platform":{"architecture":"arm64","os":"linux"}}]}`;
  fixture.putManifest('app/multi', { ref: 'latest', contentType: ctList, body: listBody });
  fixture.putManifest('app/multi', {
    ref: amd,
    contentType: ctManifest,
    body: '{"schemaVersion":2,"amd":true}',
  });
  fixture.putManifest('app/multi', {
    ref: arm,
    contentType: ctManifest,
    body: '{"schemaVersion":2,"arm":true}',
  });

  // OCI index with a platform that the caller will request explicitly.
  const ociAmd = `sha256:${'e'.repeat(64)}`;
  const ociIndexBody = `{"schemaVersion":2,"mediaType":"${ctOciIndex}","manifests":[{"mediaType":"${ctOciManifest}","size":1,"digest":"${ociAmd}","platform":{"os":"linux","architecture":"arm64","variant":"v8"}}]}`;
  fixture.putManifest('app/oci', { ref: 'stable', contentType: ctOciIndex, body: ociIndexBody });
  fixture.putManifest('app/oci', {
    ref: ociAmd,
    contentType: ctOciManifest,
    body: '{"schemaVersion":3,"oci":true}',
  });

  // Auth-protected repository.
  const authBody = `{"schemaVersion":2,"mediaType":"${ctManifest}","config":{},"layers":[]}`;
  fixture.putManifest('private/hidden', { ref: 'latest', contentType: ctManifest, body: authBody });

  endpoint = await fixture.start(0);
  overrides = {
    protocol: 'http:',
    hostMappings: [
      ['registry-1.docker.io', `${endpoint.host}:${endpoint.port}`],
      ['registry.test.local', `${endpoint.host}:${endpoint.port}`],
    ],
    extraAllowedHosts: [endpoint.host, 'registry.test.local'],
    disableDangerousHostCheck: true,
  };
});

afterAll(async () => {
  await fixture.stop();
});

function req(repository: string, tag: string, platform: string | null = 'linux/amd64') {
  return { registry: 'docker.io', repository, tag, platform };
}

describe('digest selection', () => {
  it('pins the raw-byte digest for a single-arch manifest (no index)', async () => {
    const r = await resolveTagDigest(req('app/single', 'latest'), overrides);
    expect(r.referenceKind).toBe('manifest');
    expect(r.digest).toBe(sha256(singleBody));
  });

  it('returns indexDigest as the pinned digest for multi-arch lists', async () => {
    const r = await resolveTagDigest(req('app/multi', 'latest', 'linux/amd64'), overrides);
    expect(r.referenceKind).toBe('index');
    const indexDigest = sha256(
      `{"schemaVersion":2, "mediaType":"${ctList}",\n "manifests":[{"mediaType":"${ctManifest}","size":528,"digest":"sha256:${'c'.repeat(64)}","platform":{"architecture":"amd64","os":"linux"}},{"mediaType":"${ctManifest}","size":528,"digest":"sha256:${'d'.repeat(64)}","platform":{"architecture":"arm64","os":"linux"}}]}`,
    );
    expect(r.digest).toBe(indexDigest);
    expect(r.platformManifestDigest).toBe(`sha256:${'c'.repeat(64)}`);
  });

  it('honors an explicit platform (linux/arm64) for the platform manifest', async () => {
    const r = await resolveTagDigest(req('app/multi', 'latest', 'linux/arm64'), overrides);
    expect(r.referenceKind).toBe('index');
    expect(r.platformManifestDigest).toBe(`sha256:${'d'.repeat(64)}`);
  });

  it('handles OCI index + OCI manifest with explicit variant platform', async () => {
    const r = await resolveTagDigest(req('app/oci', 'stable', 'linux/arm64/v8'), overrides);
    expect(r.referenceKind).toBe('index');
    expect(r.digest).toBe(
      sha256(
        `{"schemaVersion":2,"mediaType":"${ctOciIndex}","manifests":[{"mediaType":"${ctOciManifest}","size":1,"digest":"sha256:${'e'.repeat(64)}","platform":{"os":"linux","architecture":"arm64","variant":"v8"}}]}`,
      ),
    );
    expect(r.platformManifestDigest).toBe(`sha256:${'e'.repeat(64)}`);
  });

  it('sends the full Docker+OCI Accept set', async () => {
    fixture.requestLogSnapshot().length = 0;
    await resolveTagDigest(req('app/single', 'latest'), overrides);
    const log = fixture.requestLogSnapshot();
    const manifestReq = log.find((l) => l.url.includes('/manifests/latest'));
    expect(manifestReq?.accept).toContain('application/vnd.docker.distribution.manifest.v2+json');
    expect(manifestReq?.accept).toContain('application/vnd.oci.image.index.v1+json');
  });
});

describe('auth + failure classification', () => {
  it('fails clearly when the host is not on the trusted list', async () => {
    const strictOverrides: AdapterOverrides = { ...overrides, extraAllowedHosts: [] };
    await expect(
      resolveTagDigest(req('app/single', 'latest'), strictOverrides),
    ).rejects.toBeInstanceOf(RegistryFailure);
  });

  it('completes the bearer-token flow for a protected repository', async () => {
    const authFixture = new RegistryFixture({ requireToken: true });
    const authBody = '{"schemaVersion":2,"auth":true}';
    authFixture.putManifest('private/hidden', {
      ref: 'latest',
      contentType: ctManifest,
      body: authBody,
    });
    const ep = await authFixture.start(0);
    try {
      const authOverrides: AdapterOverrides = {
        protocol: 'http:',
        hostMappings: [
          ['registry-1.docker.io', `${ep.host}:${ep.port}`],
          ['registry.test.local', `${ep.host}:${ep.port}`],
          ['auth.docker.io', `${ep.host}:${ep.port}`],
        ],
        extraAllowedHosts: [ep.host, 'registry.test.local'],
        disableDangerousHostCheck: true,
      };
      const r = await resolveTagDigest(
        { ...req('private/hidden', 'latest'), credentials: { username: 'user', password: 'pass' } },
        authOverrides,
      );
      expect(r.digest).toBe(sha256(authBody));
      const log = authFixture.requestLogSnapshot();
      expect(log.some((l) => l.url.startsWith('/token'))).toBe(true);
      expect(log.filter((l) => l.authorization?.startsWith('Bearer tok-')).length).toBeGreaterThan(
        0,
      );
    } finally {
      await authFixture.stop();
    }
  });

  it('classifies 404 as non-retryable not_found', async () => {
    const p = resolveTagDigest(req('app/missing', 'latest'), overrides);
    await expect(p).rejects.toMatchObject({ normalized: { kind: 'not_found', retryable: false } });
  });

  it('classifies 429 as retryable and surfaces Retry-After', async () => {
    const rateFixture = new RegistryFixture({
      flakyRepo: 'app/single',
      flakyStatus: 429,
      retryAfter: '7',
    });
    const ep = await rateFixture.start(0);
    try {
      const rateOverrides: AdapterOverrides = {
        protocol: 'http:',
        hostMappings: [
          ['registry-1.docker.io', `${ep.host}:${ep.port}`],
          ['registry.test.local', `${ep.host}:${ep.port}`],
        ],
        extraAllowedHosts: [ep.host, 'registry.test.local'],
        disableDangerousHostCheck: true,
      };
      const err = await resolveTagDigest(req('app/single', 'latest'), rateOverrides).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(RegistryFailure);
      expect(err.normalized).toMatchObject({
        kind: 'rate_limited',
        retryable: true,
        retryAfterSeconds: 7,
      });
    } finally {
      await rateFixture.stop();
    }
  });

  it('classifies 5xx as retryable server errors', async () => {
    const badFixture = new RegistryFixture({ flakyRepo: 'app/single', flakyStatus: 503 });
    const ep = await badFixture.start(0);
    try {
      const badOverrides: AdapterOverrides = {
        protocol: 'http:',
        hostMappings: [
          ['registry-1.docker.io', `${ep.host}:${ep.port}`],
          ['registry.test.local', `${ep.host}:${ep.port}`],
        ],
        extraAllowedHosts: [ep.host, 'registry.test.local'],
        disableDangerousHostCheck: true,
      };
      const err = await resolveTagDigest(req('app/single', 'latest'), badOverrides).catch((e) => e);
      expect(err.normalized).toMatchObject({ kind: 'server', retryable: true });
    } finally {
      await badFixture.stop();
    }
  });
});

describe('ghcrTagUpdatedAt', () => {
  it('maps the tag to its version updated_at and tolerates owner user/org paths', async () => {
    const calls: string[] = [];
    const stubFetch = async (url: string | URL | Request): Promise<Response> => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/users/')) {
        return new Response(JSON.stringify({ message: 'Requires authentication' }), {
          status: 404,
        });
      }
      return new Response(
        JSON.stringify([
          {
            updated_at: '2026-09-01T10:00:00Z',
            metadata: { container: { tags: ['latest'] } },
          },
        ]),
        { status: 200 },
      );
    };
    vi.stubGlobal('fetch', stubFetch);
    try {
      const ms = await ghcrTagUpdatedAt('tok', 'chenyme/grok2api', 'latest');
      expect(ms).toBe(Date.parse('2026-09-01T10:00:00Z'));
      expect(calls.some((u) => u.includes('/users/chenyme/'))).toBe(true);
      expect(calls.some((u) => u.includes('/orgs/chenyme/'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns null without a token or when the tag is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { status: 200 })),
    );
    try {
      expect(await ghcrTagUpdatedAt('tok', 'owner/pkg', 'nope')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
