// Acceptance seed: isolated SQLite fixture for browser verification.
// Fictional images/uuids only; offline; no external calls.
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { migrate, openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources, settings } from '../src/server/db/schema.js';

const outDir = process.argv[2];
if (outDir == null || outDir === '') throw new Error('usage: node seed-acceptance.mjs <dir>');
const dbPath = path.join(outDir, 'seed.sqlite');

const handle = openDatabase(dbPath);
const db = handle.db;
migrate(db);

const now = Date.now();
const D_A = `sha256:${'a'.repeat(64)}`;
const D_B = `sha256:${'b'.repeat(64)}`;

let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

function svcRow(name: string, serverName: string, over: Record<string, unknown> = {}) {
  const id = nextId();
  db.insert(resources)
    .values({
      kind: 'compose_service',
      coolifyUuid: `svc-uuid-${id}`,
      name,
      serverName,
      projectName: 'homelab',
      environmentName: 'production',
      projectUuid: 'proj-1',
      environmentUuid: 'env-1',
      policy: 'ignore',
      configFingerprint: 'fp',
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
  const row = db.select().from(resources).where(eq(resources.id, id)).get();
  if (row == null) throw new Error(`service row ${id} missing`);
  return row;
}

function childRow(
  name: string,
  parentId: number,
  opts: {
    image?: string;
    tag?: string;
    platform?: string | null;
    configured?: string | null;
    observed?: string | null;
    policy?: 'ignore' | 'notify' | 'manual' | 'auto';
    stopped?: boolean;
    parentName?: string;
    parentIdOverride?: number;
  } = {},
) {
  const id = nextId();
  db.insert(resources)
    .values({
      kind: 'service_application',
      coolifyUuid: `child-uuid-${id}`,
      parentId: opts.parentIdOverride ?? parentId,
      name,
      serverName: 'node-a',
      projectName: 'homelab',
      environmentName: 'production',
      projectUuid: 'proj-1',
      environmentUuid: 'env-1',
      currentImage: opts.image ?? 'nginx:1.27',
      policy: opts.policy ?? 'notify',
      configFingerprint: 'fp',
      isStopped: opts.stopped ?? false,
      lastSyncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  if (opts.tag != null) {
    db.insert(imageTracks)
      .values({
        resourceId: id,
        sourceRegistry: 'docker.io',
        sourceRepository: 'library/nginx',
        sourceRepositoryAuthored: 'library/nginx',
        sourceTag: opts.tag,
        targetPlatform: opts.platform === undefined ? 'linux/amd64' : opts.platform,
        platformSource: opts.platform == null ? null : 'node',
        configuredReference: 'nginx',
        configuredDigest: opts.configured ?? null,
        observedDigest: opts.observed ?? null,
        observedAt: opts.observed != null ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  return id;
}

// Rich fixture: two same-name services.
const stack1 = svcRow('stack', 'node-a');
const stack2 = svcRow('stack', 'node-b');
childRow('cache', stack1.id, { tag: 'latest', platform: null, observed: null }); // 平台缺失
childRow('db', stack1.id, { policy: 'ignore', tag: 'latest' }); // 忽略策略
childRow('unfixed-web', stack1.id, { tag: '1.27', configured: null, observed: D_A }); // 未初始化
childRow('web', stack1.id, { tag: '1.27', configured: D_A, observed: D_B }); // 有候选
childRow('stopped-worker', stack1.id, {
  tag: 'latest',
  policy: 'manual',
  stopped: true,
  configured: D_A,
  observed: D_A,
});
childRow('api', stack2.id, { tag: '2', image: 'api:v2', configured: D_A, observed: D_B });

// Orphan child: parent not in the active list.
const orphan = childRow('lost-child', 0, { tag: 'latest', parentName: 'gone-service' });
db.update(resources).set({ parentId: 99999 }).where(eq(resources.id, orphan)).run();

// Bulk: 25 extra services so services tab paginates (default 20 groups/page).
for (let i = 1; i <= 25; i++) {
  const g = svcRow(`batch-svc-${String(i).padStart(2, '0')}`, i % 2 === 0 ? 'node-b' : 'node-a');
  childRow(`app-${i}`, g.id, {
    tag: 'latest',
    configured: D_A,
    observed: i % 5 === 0 ? D_B : D_A,
  });
}

// Standalone application with a candidate.
const appId = nextId();
db.insert(resources)
  .values({
    kind: 'application',
    coolifyUuid: 'solo-app-uuid',
    name: 'solo-app',
    serverName: 'node-a',
    projectName: 'homelab',
    environmentName: 'production',
    projectUuid: 'proj-1',
    environmentUuid: 'env-1',
    currentImage: 'jellyfin/jellyfin:latest',
    policy: 'notify',
    configFingerprint: 'fp',
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  .run();
db.insert(imageTracks)
  .values({
    resourceId: appId,
    sourceRegistry: 'docker.io',
    sourceRepository: 'jellyfin/jellyfin',
    sourceRepositoryAuthored: 'jellyfin/jellyfin',
    sourceTag: 'latest',
    targetPlatform: 'linux/amd64',
    platformSource: 'node',
    configuredReference: 'jellyfin',
    configuredDigest: D_A,
    observedDigest: D_B,
    observedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  .run();

// Pause everything: no scheduled sync/check while humans click around.
db.insert(settings)
  .values({
    key: 'toolkit.settings',
    value: {
      syncCron: '0 3 * * *',
      checkCron: '0 4 * * *',
      cronTimezone: 'UTC',
      globalPaused: true,
    },
  })
  .onConflictDoUpdate({
    target: settings.key,
    set: {
      value: {
        syncCron: '0 3 * * *',
        checkCron: '0 4 * * *',
        cronTimezone: 'UTC',
        globalPaused: true,
      },
    },
  })
  .run();

console.log(dbPath);
handle.close();
