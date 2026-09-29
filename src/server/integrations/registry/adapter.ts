// Thin adapter over @snyk/docker-registry-v2-client 4.0.6.
// The SDK owns: V2 protocol, challenge/token auth, redirects, manifest fetch/parse.
// This adapter owns: reference normalization, trusted hosts, credentials, platform,
// option hardening, digest field selection, error mapping and request coalescing.

import type { types as sdkTypes } from '@snyk/docker-registry-v2-client';
import { contentTypes, getManifest } from '@snyk/docker-registry-v2-client';
import { digestSchema } from '../../../shared/schemas.js';
import type { ReferenceKind } from '../../../shared/types.js';
import type { AppConfig } from '../../config.js';
import { classifyRegistryError } from './errors.js';
import {
  formatTaggedReference,
  normalizeReference,
  parsePlatform,
  REGISTRY_HOSTS,
} from './reference.js';

type ImageManifest = sdkTypes.ImageManifest;
type Platform = sdkTypes.Platform;

/** All four Docker/OCI manifest types, as the plan pins (§4). */
const ACCEPT_MANIFEST = [
  contentTypes.MANIFEST_V2,
  contentTypes.MANIFEST_LIST_V2,
  contentTypes.OCI_MANIFEST_V1,
  contentTypes.OCI_INDEX_V1,
].join(', ');

const OPEN_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;

export interface ResolveRequest {
  registry: string;
  repository: string;
  tag: string;
  platform: string | null;
  /** Credentials profile from server-side file; never logged. */
  credentials?: { username?: string; password?: string };
}

/**
 * Offline-test seam: loopback redirection and HTTP for local fixtures only.
 * Production callers pass nothing; trusted-host hardening stays intact.
 */
export interface AdapterOverrides {
  protocol?: string;
  hostMappings?: Array<[RegExp | string, string]>;
  extraAllowedHosts?: string[];
  /** Offline fixtures only. */
  disableDangerousHostCheck?: boolean;
}

export interface ResolvedImageReference {
  /** Top-level digest: index digest when index, else the manifest digest. */
  digest: string;
  referenceKind: ReferenceKind;
  /** Platform-specific manifest digest chosen by the SDK. */
  platformManifestDigest: string;
  observedAt: number;
  manifestContentType: string | null;
}

function buildOptions(registry: string, overrides?: AdapterOverrides): Record<string, unknown> {
  const hosts = REGISTRY_HOSTS[registry];
  if (hosts == null) throw new Error(`No trusted host profile for registry ${registry}`);
  const allowed = [hosts.index, ...hosts.auth, ...(overrides?.extraAllowedHosts ?? [])];
  return {
    acceptManifest: ACCEPT_MANIFEST,
    parse_response: false,
    encoding: 'utf8',
    allowedHosts: allowed,
    disallowDangerousHosts: overrides?.disableDangerousHostCheck !== true,
    ssrfProtectionDryRun: false,
    open_timeout: OPEN_TIMEOUT_MS,
    response_timeout: RESPONSE_TIMEOUT_MS,
    read_timeout: READ_TIMEOUT_MS,
    ...(overrides?.protocol != null ? { protocol: overrides.protocol } : {}),
    ...(overrides?.hostMappings != null ? { hostMappings: overrides.hostMappings } : {}),
  };
}

function sdkRegistryBase(registry: string): string {
  const hosts = REGISTRY_HOSTS[registry];
  if (hosts == null) throw new Error(`No trusted host profile for registry ${registry}`);
  return hosts.index;
}

function validateDigest(value: string | undefined, label: string): string {
  const parsed = digestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Registry returned malformed ${label}`);
  }
  return parsed.data;
}

function toPlatformSpec(platform: string | null): Platform | undefined {
  if (platform == null) return undefined; // SDK defaults to linux/amd64 (probe-only semantics)
  const spec = parsePlatform(platform);
  return spec.variant == null
    ? { os: spec.os, architecture: spec.architecture }
    : { os: spec.os, architecture: spec.architecture, variant: spec.variant };
}

/**
 * Resolve the top-level digest for a tracked tag.
 * Deterministic selection (§4): `indexDigest ?? manifestDigest`, both validated.
 */
export async function resolveTagDigest(
  req: ResolveRequest,
  overrides?: AdapterOverrides,
): Promise<ResolvedImageReference> {
  const options = buildOptions(req.registry, overrides);
  const base = sdkRegistryBase(req.registry);
  const platformSpec = toPlatformSpec(req.platform);
  let manifest: ImageManifest;
  try {
    manifest = await getManifest(
      base,
      req.repository,
      req.tag,
      req.credentials?.username,
      req.credentials?.password,
      options,
      platformSpec,
    );
  } catch (err) {
    throw new RegistryFailure(classifyRegistryError(err));
  }
  const indexDigest = manifest.indexDigest;
  const manifestDigest = manifest.manifestDigest;
  if (indexDigest != null) {
    return {
      digest: validateDigest(indexDigest, 'index digest'),
      referenceKind: 'index',
      platformManifestDigest: validateDigest(manifestDigest, 'platform manifest digest'),
      observedAt: Date.now(),
      manifestContentType: manifest.manifestContentType ?? null,
    };
  }
  if (manifestDigest != null) {
    return {
      digest: validateDigest(manifestDigest, 'manifest digest'),
      referenceKind: 'manifest',
      platformManifestDigest: validateDigest(manifestDigest, 'manifest digest'),
      observedAt: Date.now(),
      manifestContentType: manifest.manifestContentType ?? null,
    };
  }
  throw Object.assign(new Error('Registry response carried no digest'), {
    registryErrorKind: 'unknown',
  });
}

/** Thrown form carrying a normalized registry error. */
export class RegistryFailure extends Error {
  constructor(public readonly normalized: ReturnType<typeof classifyRegistryError>) {
    super(normalized.message);
    this.name = 'RegistryFailure';
  }
}

/** Credentials for a registry from config; returns undefined when absent (anonymous). */
export function credentialsFor(
  config: AppConfig,
  registry: string,
): { username?: string; password?: string } | undefined {
  const cred = config.registryCredentials[registry];
  if (cred == null) return undefined;
  const out: { username?: string; password?: string } = {};
  if (cred.username != null) out.username = cred.username;
  if (cred.password != null) out.password = cred.password;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Coalescing in-flight requests by cache key so one scan round shares results
 * across scheduler + API callers (§4: same-key share, concurrency limited here
 * only at call level; the checker owns the round-level budget).
 */
const inflight = new Map<string, Promise<ResolvedImageReference>>();

export function coalesceKey(req: ResolveRequest, credentialVersion: string): string {
  return [req.registry, req.repository, req.tag, req.platform ?? '-', credentialVersion].join('|');
}

export function resolveTagDigestCoalesced(
  req: ResolveRequest,
  credentialVersion: string,
  overrides?: AdapterOverrides,
): Promise<ResolvedImageReference> {
  if (overrides != null) return resolveTagDigest(req, overrides); // never coalesce test calls
  const key = coalesceKey(req, credentialVersion);
  const existing = inflight.get(key);
  if (existing != null) return existing;
  const p = resolveTagDigest(req).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export { formatTaggedReference, normalizeReference };

/**
 * Upstream tag's latest push time, from Docker Hub's public metadata API.
 * Only docker.io and lscr.io (Hub-backed) expose it; GHCR has no public API.
 * Best-effort: any failure returns null and never blocks the check.
 */
export async function tagLastPushedAt(
  registry: string,
  repository: string,
  tag: string,
): Promise<number | null> {
  let repo = repository;
  if (registry === 'lscr.io') {
    const name = repository.split('/').pop() ?? repository;
    repo = `linuxserver/${name}`;
  } else if (registry !== 'docker.io') {
    return null;
  }
  const url = `https://hub.docker.com/v2/repositories/${repo}/tags/${encodeURIComponent(tag)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_last_pushed?: string | null };
    if (body.tag_last_pushed == null) return null;
    const ms = Date.parse(body.tag_last_pushed);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * GHCR tag update time via the GitHub packages API. Requires a GitHub token
 * with read:packages scope — even public packages return 401 anonymously.
 */
export async function ghcrTagUpdatedAt(
  githubToken: string,
  repository: string,
  tag: string,
): Promise<number | null> {
  const [owner, pkg] = repository.split('/');
  if (owner == null || pkg == null) return null;
  const headers = {
    Authorization: `Bearer ${githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Owner 可能是用户或组织，两种路径依次尝试。
  const urls = [
    `https://api.github.com/users/${owner}/packages/container/${pkg}/versions?per_page=100`,
    `https://api.github.com/orgs/${owner}/packages/container/${pkg}/versions?per_page=100`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
      if (res.status === 404) continue;
      if (!res.ok) return null;
      const versions = (await res.json()) as Array<{
        updated_at?: string | null;
        metadata?: { container?: { tags?: string[] } | null } | null;
      }>;
      const hit = versions.find((v) => v.metadata?.container?.tags?.includes(tag));
      if (hit?.updated_at == null) return null;
      const ms = Date.parse(hit.updated_at);
      return Number.isNaN(ms) ? null : ms;
    } catch {
      return null;
    }
  }
  return null;
}
