// Real-registry read-only smoke: Docker Hub / GHCR / LSCR with the production
// adapter configuration. Run explicitly: npx tsx scripts/smoke-registry.ts
// Never part of `npm test` (offline reproducibility).
import '../src/server/sdk-env.js';
import { resolveTagDigest } from '../src/server/integrations/registry/adapter.js';

const targets = [
  { registry: 'docker.io', repository: 'library/busybox', tag: 'latest', platform: 'linux/amd64' },
  {
    registry: 'ghcr.io',
    repository: 'navidrome/navidrome',
    tag: 'latest',
    platform: 'linux/amd64',
  },
  {
    registry: 'lscr.io',
    repository: 'linuxserver/jackett',
    tag: 'latest',
    platform: 'linux/amd64',
  },
];

let failures = 0;
for (const t of targets) {
  try {
    const r = await resolveTagDigest(t);
    console.log(
      `OK  ${t.registry}/${t.repository}:${t.tag} -> ${r.digest} (${r.referenceKind}, platform ${r.platformManifestDigest})`,
    );
  } catch (err) {
    failures += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERR ${t.registry}/${t.repository}:${t.tag} -> ${msg}`);
  }
}
process.exit(failures > 0 ? 1 : 0);
