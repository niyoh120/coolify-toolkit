// Reference normalization and platform parsing: the确定性 core of the toolkit.
import { describe, expect, it } from 'vitest';
import {
  coolifyDigestTag,
  formatDigestReference,
  formatPlatform,
  formatTaggedReference,
  normalizeReference,
  parsePlatform,
  UnsupportedRegistryError,
} from '../src/server/integrations/registry/reference.js';

const HEX64 = 'a'.repeat(64);
const DIGEST = `sha256:${HEX64}`;

describe('normalizeReference', () => {
  it('normalizes docker hub shorthand, official images, ghcr and lscr', () => {
    expect(normalizeReference('nginx')).toEqual({
      registry: 'docker.io',
      repository: 'library/nginx',
      authoredPath: 'nginx',
      tag: 'latest',
      digest: null,
      original: 'nginx',
    });
    expect(normalizeReference('jellyfin/jellyfin:latest')).toMatchObject({
      registry: 'docker.io',
      repository: 'jellyfin/jellyfin',
      authoredPath: 'jellyfin/jellyfin',
      tag: 'latest',
    });
    expect(normalizeReference('ghcr.io/navidrome/navidrome')).toMatchObject({
      registry: 'ghcr.io',
      repository: 'navidrome/navidrome',
      authoredPath: 'ghcr.io/navidrome/navidrome',
      tag: 'latest',
    });
    expect(normalizeReference('lscr.io/linuxserver/jackett:latest')).toMatchObject({
      registry: 'lscr.io',
      repository: 'linuxserver/jackett',
      authoredPath: 'lscr.io/linuxserver/jackett',
      tag: 'latest',
    });
  });

  it('treats the coolify digest-as-tag form and @digest form as pinned digests', () => {
    expect(normalizeReference(`jellyfin/jellyfin:sha256-${HEX64}`)).toMatchObject({
      digest: DIGEST,
      tag: null,
    });
    expect(normalizeReference(`lscr.io/linuxserver/jackett@${DIGEST}`)).toMatchObject({
      registry: 'lscr.io',
      repository: 'linuxserver/jackett',
      digest: DIGEST,
      tag: null,
    });
  });

  it('rejects unsupported registries and malformed digests', () => {
    expect(() => normalizeReference('gcr.io/owner/img:1')).toThrow(UnsupportedRegistryError);
    expect(() => normalizeReference('nginx@sha256:short')).toThrow();
    expect(() => normalizeReference('')).toThrow();
  });
});

describe('formats', () => {
  it('formats tagged and digest references', () => {
    const ref = normalizeReference('jellyfin/jellyfin');
    expect(formatTaggedReference(ref)).toBe('docker.io/jellyfin/jellyfin:latest');
    expect(formatDigestReference(ref, DIGEST)).toBe(`docker.io/jellyfin/jellyfin@${DIGEST}`);
  });

  it('converts between digest and coolify tag field encoding', () => {
    expect(coolifyDigestTag(DIGEST)).toBe(`sha256-${HEX64}`);
    const back = normalizeReference(`jellyfin/jellyfin:${coolifyDigestTag(DIGEST)}`);
    expect(back.digest).toBe(DIGEST);
  });
});

describe('platform', () => {
  it('parses and formats os/arch[/variant]', () => {
    expect(parsePlatform('linux/amd64')).toEqual({ os: 'linux', architecture: 'amd64' });
    expect(parsePlatform('linux/arm/v7')).toEqual({
      os: 'linux',
      architecture: 'arm',
      variant: 'v7',
    });
    expect(formatPlatform({ os: 'linux', architecture: 'arm', variant: 'v7' })).toBe(
      'linux/arm/v7',
    );
    expect(() => parsePlatform('linux')).toThrow();
  });
});
