// Inventory sync: discovery defaults, external-change detection, removal safety.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { migrate, type OpenDbResult, openDatabase } from '../src/server/db/client.js';
import { pruneJobHistory, pruneNotificationHistory } from '../src/server/db/retention.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import type { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import { InventorySync } from '../src/server/modules/inventory/sync.js';
import type {
  CoolifyApplication,
  CoolifyService,
  CoolifyServiceApplication,
} from '../src/shared/schemas.js';

let handle: OpenDbResult;
let dir: string;
let sync: InventorySync;
let cfg: AppConfig;
let settings: SettingsRepo;

const APP = (over: Partial<CoolifyApplication> = {}): CoolifyApplication =>
  ({
    id: 1,
    uuid: 'app-1',
    name: 'jellyfin',
    build_pack: 'dockerimage',
    docker_image: 'jellyfin/jellyfin',
    docker_image_tag: 'latest',
    fqdn: 'https://jf.example.com',
    status: 'running',
    ...over,
  }) as CoolifyApplication;

const SVC = (over: Partial<CoolifyService> = {}): CoolifyService =>
  ({
    id: 2,
    uuid: 'svc-1',
    name: 'stack',
    docker_compose_raw: 'services:\n  web:\n    image: nginx:1.27\n    platform: linux/arm64\n',
    status: 'running',
    ...over,
  }) as CoolifyService;

const CHILD = (over: Partial<CoolifyServiceApplication> = {}): CoolifyServiceApplication =>
  ({
    uuid: 'child-1',
    name: 'web',
    human_name: 'Web',
    image: 'nginx:1.27',
    fqdn: 'https://web.example.com',
    status: 'running',
    ...over,
  }) as CoolifyServiceApplication;

type TopologyEntry = {
  destination?: {
    id?: number | null;
    server?: {
      uuid?: string | null;
      name?: string | null;
      server_metadata?: { arch?: string | null } | null;
    };
  };
};

function stubCoolify(
  apps: CoolifyApplication[],
  services: CoolifyService[],
  children: CoolifyServiceApplication[],
  topology: TopologyEntry[] = [],
): CoolifyClient {
  return {
    listApplications: async () => apps,
    listServices: async () => services,
    listServiceApplications: async (uuid: string) => (uuid === services[0]?.uuid ? children : []),
    listResourceEntries: async () => topology,
  } as unknown as CoolifyClient;
}

const DEST = (
  id: number,
  serverUuid: string,
  arch: string | null,
  serverName?: string,
): TopologyEntry => ({
  destination: {
    id,
    server: { uuid: serverUuid, name: serverName, server_metadata: { arch } },
  },
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'toolkit-sync-'));
  handle = openDatabase(path.join(dir, 'db.sqlite'));
  migrate(handle.db);
  settings = new SettingsRepo(handle.db);
  cfg = {
    coolifyBaseUrl: 'http://x',
    coolifyApiKey: 'k',
    coolifyVerifyTls: true,
    excludedUuids: ['infra-uuid'],
    databasePath: path.join(dir, 'db.sqlite'),
    registryCredentials: {},
    githubToken: null,
    port: 0,
    publicOrigin: null,
    apprise: { apiUrl: null, configKey: null, tag: null, user: null, password: null },
    deployConcurrency: 1,
    dataDir: dir,
  };
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('inventory sync', () => {
  it('discovers applications with policy ignore and creates tracks', async () => {
    sync = new InventorySync(handle.db, stubCoolify([APP()], [], []), cfg, settings);
    const r = await sync.run();
    expect(r.created).toBe(1);
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row).toMatchObject({ policy: 'ignore', kind: 'application', excludedInfra: false });
    const track = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, row!.id))
      .get();
    expect(track).toMatchObject({
      sourceRegistry: 'docker.io',
      sourceRepository: 'jellyfin/jellyfin',
      sourceRepositoryAuthored: 'jellyfin/jellyfin',
      sourceTag: 'latest',
      // stub 拓扑未带节点架构：平台保持待配置。
      targetPlatform: null,
      platformSource: null,
    });
  });

  it('reads compose platform for children and marks infra exclusions', async () => {
    sync = new InventorySync(
      handle.db,
      stubCoolify([], [SVC({ uuid: 'infra-uuid' })], [CHILD()]),
      cfg,
      settings,
    );
    await sync.run();
    const parent = handle.db
      .select()
      .from(resources)
      .where(eq(resources.coolifyUuid, 'infra-uuid'))
      .get();
    expect(parent?.kind).toBe('compose_service');
    expect(parent?.excludedInfra).toBe(true);
    const child = handle.db
      .select()
      .from(resources)
      .where(eq(resources.coolifyUuid, 'child-1'))
      .get();
    expect(child?.parentId).toBe(parent?.id);
    expect(child?.excludedInfra).toBe(true); // excluded parent propagates
    const childTrack = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, child!.id))
      .get();
    expect(childTrack).toMatchObject({
      sourceRepository: 'library/nginx',
      targetPlatform: 'linux/arm64',
      platformSource: 'compose',
    });
  });

  it('flags external image changes and keeps them blocked', async () => {
    sync = new InventorySync(handle.db, stubCoolify([APP()], [], []), cfg, settings);
    await sync.run();
    const first = handle.db
      .select()
      .from(resources)
      .where(eq(resources.coolifyUuid, 'app-1'))
      .get();

    // Second sync: Coolify now shows a different tag (external edit).
    sync = new InventorySync(
      handle.db,
      stubCoolify([APP({ docker_image_tag: '10.9.2' })], [], []),
      cfg,
      settings,
    );
    const r = await sync.run();
    expect(r.externalChanges).toBe(1);
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBe('external_change');
    expect(row?.currentImage).toBe('jellyfin/jellyfin:10.9.2');
    void first;
  });

  it('does not flag external change when the image matches the pinned digest', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    sync = new InventorySync(handle.db, stubCoolify([APP()], [], []), cfg, settings);
    await sync.run();
    // Simulate the executor having completed: track.configuredDigest advanced.
    const row0 = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    handle.db
      .update(imageTracks)
      .set({ configuredDigest: digest })
      .where(eq(imageTracks.resourceId, row0!.id))
      .run();
    // Coolify now shows the written digest tag.
    sync = new InventorySync(
      handle.db,
      stubCoolify([APP({ docker_image_tag: `sha256-${'a'.repeat(64)}` })], [], []),
      cfg,
      settings,
    );
    const r = await sync.run();
    expect(r.externalChanges).toBe(0);
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBeNull();
    const track = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, row!.id))
      .get();
    expect(track?.configuredDigest).toBe(digest);
  });

  it('marks removed only after a complete sync; partial failure keeps rows', async () => {
    sync = new InventorySync(handle.db, stubCoolify([APP()], [SVC()], [CHILD()]), cfg, settings);
    await sync.run();
    // Partial failure: listApplications throws -> abort, nothing removed.
    const failing = {
      listApplications: async () => {
        throw new Error('boom');
      },
      listServices: async () => [],
      listServiceApplications: async () => [],
    } as unknown as CoolifyClient;
    sync = new InventorySync(handle.db, failing, cfg, settings);
    await expect(sync.run()).rejects.toThrow('boom');
    const rows1 = handle.db.select().from(resources).all();
    expect(rows1.every((r) => r.status === 'active')).toBe(true);

    // Complete sync without the app: it becomes removed.
    sync = new InventorySync(handle.db, stubCoolify([], [], []), cfg, settings);
    const r = await sync.run();
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const rows2 = handle.db.select().from(resources).all();
    expect(rows2.find((x) => x.coolifyUuid === 'app-1')?.status).toBe('removed');
  });
});

describe('inventory sync fixes (review round 1)', () => {
  it('keeps parent+children when only the child list call fails (F1)', async () => {
    sync = new InventorySync(handle.db, stubCoolify([], [SVC()], [CHILD()]), cfg, settings);
    await sync.run();
    // Next round: child list throws, parent still listed.
    const failingChildren = {
      listApplications: async () => [],
      listServices: async () => [SVC()],
      listServiceApplications: async () => {
        throw new Error('transient');
      },
    } as unknown as CoolifyClient;
    sync = new InventorySync(handle.db, failingChildren, cfg, settings);
    const r = await sync.run();
    expect(r.errors.length).toBe(1);
    expect(r.removed).toBe(0);
    const parent = handle.db
      .select()
      .from(resources)
      .where(eq(resources.coolifyUuid, 'svc-1'))
      .get();
    expect(parent?.status).toBe('active');
    const child = handle.db
      .select()
      .from(resources)
      .where(eq(resources.coolifyUuid, 'child-1'))
      .get();
    expect(child?.status).toBe('active');
  });

  it('records sync time under the key the API reads (F2)', async () => {
    sync = new InventorySync(handle.db, stubCoolify([], [], []), cfg, settings);
    await sync.run();
    expect(settings.getMeta<number>('lastSyncAt')).not.toBeNull();
  });

  it('labels resources with the real server name from topology (server column)', async () => {
    const app = APP({
      destination: { id: 7, name: 'coolify' } as CoolifyApplication['destination'],
    });
    sync = new InventorySync(
      handle.db,
      stubCoolify([app], [], [], [DEST(7, 'srv-7', 'x86_64', 'ser7')]),
      cfg,
      settings,
    );
    await sync.run();
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.serverName).toBe('ser7');
  });

  it('leaves the platform unset when the node reports no arch', async () => {
    const app = APP({
      destination: { id: 9, name: 'coolify' } as CoolifyApplication['destination'],
    });
    sync = new InventorySync(
      handle.db,
      stubCoolify([app], [], [], [DEST(9, 'srv-9', null, 'dmit-us-1')]),
      cfg,
      settings,
    );
    await sync.run();
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    const track = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, row!.id))
      .get();
    expect(track?.targetPlatform).toBeNull();
    expect(track?.platformSource).toBeNull();
  });

  it('flags digest→same-tag revert as external change and keeps the pinned digest (F9)', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    sync = new InventorySync(handle.db, stubCoolify([APP()], [], []), cfg, settings);
    await sync.run();
    const row0 = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    // Executor completed a pin at digest a; Coolify then reverted to the plain tag.
    handle.db
      .update(imageTracks)
      .set({
        configuredDigest: digest,
        configuredReference: `jellyfin/jellyfin:sha256-${'a'.repeat(64)}`,
      })
      .where(eq(imageTracks.resourceId, row0!.id))
      .run();
    sync = new InventorySync(
      handle.db,
      stubCoolify([APP({ docker_image_tag: 'latest' })], [], []),
      cfg,
      settings,
    );
    const r = await sync.run();
    expect(r.externalChanges).toBe(1);
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBe('external_change');
    const track = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, row!.id))
      .get();
    expect(track?.configuredDigest).toBe(digest); // preserved for re-confirmation
  });
});

describe('external_change hygiene (registry-field round)', () => {
  it('creates registry-field apps without external_change even when the classic fields are empty', async () => {
    const app = APP({
      docker_image: null,
      docker_image_tag: null,
      docker_registry_image_name: 'haroldli/xiaoya-tvbox',
      docker_registry_image_tag: 'latest',
    });
    sync = new InventorySync(handle.db, stubCoolify([app], [], []), cfg, settings);
    await sync.run();
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBeNull();
    expect(row?.excludedInfra).toBe(false);
    const track = handle.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, row!.id))
      .get();
    expect(track?.sourceRepository).toBe('haroldli/xiaoya-tvbox');
    expect(track?.sourceTag).toBe('latest');
  });

  it('leaves blocked_reason null when the image is unparseable at creation', async () => {
    const app = APP({
      docker_image: null,
      docker_image_tag: null,
      docker_registry_image_name: null,
      docker_registry_image_tag: null,
    });
    sync = new InventorySync(handle.db, stubCoolify([app], [], []), cfg, settings);
    await sync.run();
    const row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBeNull();
    expect(row?.excludedInfra).toBe(true);
  });

  it('heals a stale external_change once the reference matches the tracked tag again', async () => {
    sync = new InventorySync(handle.db, stubCoolify([APP()], [], []), cfg, settings);
    await sync.run();

    sync = new InventorySync(
      handle.db,
      stubCoolify([APP({ docker_image_tag: '10.9.2' })], [], []),
      cfg,
      settings,
    );
    expect((await sync.run()).externalChanges).toBe(1);
    let row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBe('external_change');

    // User reverts the external edit: the live ref matches the track again.
    sync = new InventorySync(handle.db, stubCoolify([APP()], [], []), cfg, settings);
    const r = await sync.run();
    expect(r.externalChanges).toBe(0);
    row = handle.db.select().from(resources).where(eq(resources.coolifyUuid, 'app-1')).get();
    expect(row?.blockedReason).toBeNull();
  });
});

describe('history retention', () => {
  it('prunes terminal rows beyond the limit and keeps in-flight ones', async () => {
    const now = Date.now();
    const res = handle.db
      .insert(resources)
      .values({
        kind: 'application',
        coolifyUuid: 'ret-1',
        name: 'ret',
        configFingerprint: 'fp',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    const rid = res.id;
    // 505 个终态任务 + 1 个进行中
    for (let i = 0; i < 505; i++) {
      handle.db
        .insert(updateJobs)
        .values({
          resourceId: rid,
          kind: 'update',
          trigger: 'manual',
          candidateDigest: `sha256:${String(i).padStart(64, '0')}`,
          candidateReference: `x:${i}`,
          idempotencyKey: `job-${i}`,
          status: 'success',
          createdAt: now + i,
          updatedAt: now + i,
        })
        .run();
    }
    handle.db
      .insert(updateJobs)
      .values({
        resourceId: rid,
        kind: 'update',
        trigger: 'manual',
        candidateDigest: `sha256:${'f'.repeat(64)}`,
        candidateReference: 'x:running',
        idempotencyKey: 'job-running',
        status: 'running',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (let i = 0; i < 503; i++) {
      handle.db
        .insert(notificationOutbox)
        .values({
          resourceId: rid,
          eventType: 'candidate_found',
          dedupeKey: `k${i}`,
          title: '发现候选更新',
          body: 'test',
          status: 'sent',
          attempts: 1,
          createdAt: now + i,
          sentAt: now + i,
        })
        .run();
    }

    pruneJobHistory(handle.db);
    pruneNotificationHistory(handle.db);

    const jobs = handle.db.select().from(updateJobs).all();
    expect(jobs.filter((j) => j.status === 'success').length).toBeLessThanOrEqual(500);
    expect(jobs.filter((j) => j.status === 'running')).toHaveLength(1); // 进行中保留
    const notifications = handle.db.select().from(notificationOutbox).all();
    expect(notifications.length).toBeLessThanOrEqual(500);
  });
});

describe('per-node platform resolution', () => {
  it('detects the platform from node metadata', async () => {
    const appArm = APP({
      uuid: 'app-arm',
      destination: { id: 1, name: 'arm-box' } as CoolifyApplication['destination'],
    });
    const appX86 = APP({
      uuid: 'app-x86',
      destination: { id: 2, name: 'x86-box' } as CoolifyApplication['destination'],
    });
    sync = new InventorySync(
      handle.db,
      stubCoolify(
        [appArm, appX86],
        [],
        [],
        [DEST(1, 'srv-arm', 'aarch64'), DEST(2, 'srv-x86', 'x86_64')],
      ),
      cfg,
      settings,
    );
    await sync.run();
    const rows = handle.db.select().from(resources).all();
    const trackFor = (uuid: string) => {
      const row = rows.find((r) => r.coolifyUuid === uuid);
      return handle.db.select().from(imageTracks).where(eq(imageTracks.resourceId, row!.id)).get();
    };
    expect(trackFor('app-arm')?.targetPlatform).toBe('linux/arm64');
    expect(trackFor('app-arm')?.platformSource).toBe('node');
    expect(trackFor('app-x86')?.targetPlatform).toBe('linux/amd64');
    expect(trackFor('app-x86')?.platformSource).toBe('node');
  });

  it('re-resolves existing tracks when the detected node arch changes', async () => {
    const app = APP({
      destination: { id: 7, name: 'box' } as CoolifyApplication['destination'],
    });
    const makeSync = (arch: string | null) =>
      new InventorySync(
        handle.db,
        stubCoolify([app], [], [], [DEST(7, 'srv-7', arch)]),
        cfg,
        settings,
      );
    await makeSync('x86_64').run();
    let track = handle.db.select().from(imageTracks).get();
    expect(track?.targetPlatform).toBe('linux/amd64');

    // Sentinel now reports the node as arm64: discovery-aligned tracks follow.
    await makeSync('aarch64').run();
    track = handle.db.select().from(imageTracks).get();
    expect(track?.targetPlatform).toBe('linux/arm64');
    expect(track?.platformSource).toBe('node');
  });
});
