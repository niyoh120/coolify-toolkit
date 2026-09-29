// Image reference parsing and normalization.
// Supported registries phase 1: Docker Hub, GHCR, LSCR (plan §4).
import { ApiRequestError, errorCodes } from '../../../shared/errors.js';

export interface NormalizedRef {
  /** Canonical registry identity: docker.io | ghcr.io | lscr.io. */
  registry: string;
  repository: string;
  /** Repository path exactly as typed (registry host included when present). */
  authoredPath: string;
  tag: string | null;
  digest: string | null;
  original: string;
}

export class UnsupportedRegistryError extends ApiRequestError {
  constructor(registry: string) {
    super(
      errorCodes.registryError,
      `Registry "${registry}" is outside the phase-1 supported set (docker.io, ghcr.io, lscr.io)`,
      400,
    );
    this.name = 'UnsupportedRegistryError';
  }
}

const KNOWN_REGISTRIES = new Set(['docker.io', 'ghcr.io', 'lscr.io']);

/** Registries the SDK may contact, by canonical registry identity. */
export const REGISTRY_HOSTS: Record<string, { index: string; auth: string[] }> = {
  'docker.io': { index: 'registry-1.docker.io', auth: ['auth.docker.io'] },
  'ghcr.io': { index: 'ghcr.io', auth: [] },
  'lscr.io': { index: 'lscr.io', auth: ['ghcr.io'] },
};

export function isSupportedRegistry(registry: string): boolean {
  return KNOWN_REGISTRIES.has(registry);
}

/**
 * Parse and normalize a Docker image reference.
 * - `nginx` / `nginx:1.27` → docker.io/library/nginx
 * - `jellyfin/jellyfin:latest` → docker.io/jellyfin/jellyfin
 * - `ghcr.io/owner/repo:v1` → ghcr.io/owner/repo
 * - digest forms: `repo@sha256:...` (compose) and `repo:sha256-...` (coolify tag field)
 */
export function normalizeReference(input: string): NormalizedRef {
  const original = input.trim();
  if (original.length === 0)
    throw new ApiRequestError(errorCodes.validation, 'Empty image reference');

  let rest = original;
  let digest: string | null = null;

  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new ApiRequestError(errorCodes.validation, `Invalid digest in reference: ${original}`);
    }
  }

  let tag: string | null = null;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
    // Coolify digest-as-tag form: sha256-<hex>
    if (/^sha256-[a-f0-9]{64}$/.test(tag)) {
      digest = `sha256:${tag.slice('sha256-'.length)}`;
      tag = null;
    } else if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
      throw new ApiRequestError(errorCodes.validation, `Invalid tag in reference: ${original}`);
    }
  }

  let registry = 'docker.io';
  let repository = rest;
  const firstSlash = rest.indexOf('/');
  if (firstSlash > 0) {
    const maybeRegistry = rest.slice(0, firstSlash);
    if (maybeRegistry.includes('.') || maybeRegistry === 'localhost') {
      registry = maybeRegistry.toLowerCase();
      repository = rest.slice(firstSlash + 1);
    }
  }

  if (!isSupportedRegistry(registry)) throw new UnsupportedRegistryError(registry);

  // Docker Hub official images live under library/.
  if (registry === 'docker.io' && !repository.includes('/')) {
    repository = `library/${repository}`;
  }
  if (repository.length === 0) {
    throw new ApiRequestError(
      errorCodes.validation,
      `Missing repository in reference: ${original}`,
    );
  }

  if (tag == null && digest == null) tag = 'latest';

  return { registry, repository, authoredPath: rest, tag, digest, original };
}

/** `registry/repository:tag` (no digest). */
export function formatTaggedReference(
  ref: Pick<NormalizedRef, 'registry' | 'repository' | 'tag'>,
): string {
  return `${ref.registry}/${ref.repository}:${ref.tag ?? 'latest'}`;
}

/** `registry/repository@sha256:...` — canonical pinned form. */
export function formatDigestReference(
  ref: Pick<NormalizedRef, 'registry' | 'repository'>,
  digest: string,
): string {
  return `${ref.registry}/${ref.repository}@${digest}`;
}

export interface PlatformSpec {
  os: string;
  architecture: string;
  variant?: string;
}

export function parsePlatform(platform: string): PlatformSpec {
  const m = /^([a-z0-9]+)\/([a-z0-9]+)(?:\/([a-z0-9-]+))?$/.exec(platform);
  if (m == null) throw new ApiRequestError(errorCodes.validation, `Invalid platform: ${platform}`);
  const os = m[1];
  const architecture = m[2];
  const variant = m[3];
  if (os == null || architecture == null) {
    throw new ApiRequestError(errorCodes.validation, `Invalid platform: ${platform}`);
  }
  return variant == null ? { os, architecture } : { os, architecture, variant };
}

export function formatPlatform(p: PlatformSpec): string {
  return p.variant == null ? `${p.os}/${p.architecture}` : `${p.os}/${p.architecture}/${p.variant}`;
}

/** Coolify application tag field encoding for a digest. */
export function coolifyDigestTag(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new ApiRequestError(errorCodes.validation, `Invalid digest: ${digest}`);
  }
  return `sha256-${digest.slice('sha256:'.length)}`;
}
