// Bundles the server into a single ESM file for production (node dist/server/index.js).
// tsc --noEmit remains the type gate; esbuild only transpiles.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.resolve(root, 'dist/server/index.js');
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  entryPoints: [path.resolve(root, 'src/server/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile,
  sourcemap: true,
  packages: 'external',
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    // Keep the SDK retry override ahead of any registry module load.
    js: "process.env.DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES ??= '0';",
  },
});
