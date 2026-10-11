// Migration + reopen persistence: source tag, platform, policy, pending jobs survive.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { migrate, openDatabase } from '../src/server/db/client.js';
import { imageTracks, resources, updateJobs } from '../src/server/db/schema.js';
import { SettingsRepo } from '../src/server/db/settings-repo.js';
import type { CoolifyClient } from '../src/server/integrations/coolify/client.js';
import { InventorySync } from '../src/server/modules/inventory/sync.js';
import type { CoolifyApplication } from '../src/shared/schemas.js';

describe('sqlite migrations', () => {
  it('migrates an empty database and preserves data across reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-db-'));
    const dbPath = path.join(dir, 'toolkit.db');
    try {
      // First open: migrate + seed.
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        const now = Date.now();
        const res = db
          .insert(resources)
          .values({
            kind: 'application',
            coolifyUuid: 'app-uuid-1',
            name: 'jellyfin',
            policy: 'notify',
            configFingerprint: 'fp1',
            lastSyncedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
        db.insert(imageTracks)
          .values({
            resourceId: res.id,
            sourceRegistry: 'docker.io',
            sourceRepository: 'jellyfin/jellyfin',
            sourceRepositoryAuthored: 'jellyfin/jellyfin',
            sourceTag: 'latest',
            targetPlatform: 'linux/amd64',
            platformSource: 'server_default',
            createdAt: now,
            updatedAt: now,
          })
          .run();
        db.insert(updateJobs)
          .values({
            resourceId: res.id,
            kind: 'initial_pin',
            trigger: 'manual',
            candidateDigest: `sha256:${'a'.repeat(64)}`,
            candidateReference: 'jellyfin/jellyfin:sha256-aaaa',
            status: 'pending',
            stage: 'queued',
            idempotencyKey: 'manual:1:digest:0',
            log: [],
            createdAt: now,
            updatedAt: now,
          })
          .run();
        close();
      }
      // Second open: migrations are idempotent, data intact.
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        const row = db
          .select()
          .from(resources)
          .where(eq(resources.coolifyUuid, 'app-uuid-1'))
          .get();
        expect(row?.policy).toBe('notify');
        const track = db
          .select()
          .from(imageTracks)
          .where(eq(imageTracks.resourceId, row!.id))
          .get();
        expect(track?.sourceTag).toBe('latest');
        expect(track?.targetPlatform).toBe('linux/amd64');
        const job = db.select().from(updateJobs).where(eq(updateJobs.resourceId, row!.id)).get();
        expect(job?.status).toBe('pending');
        close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upgrades a pre-confirmation database: adds confirmation_due_at and keeps rows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-upg-'));
    const dbPath = path.join(dir, 'toolkit.db');
    try {
      // Simulate the previous schema: replay the real first migration (full old
      // shape, update_jobs without confirmation_due_at) and record only it in the
      // journal, so every later migration applies on top during upgrade.
      {
        const { DatabaseSync } = require('node:sqlite') as {
          DatabaseSync: typeof import('node:sqlite').DatabaseSync;
        };
        const raw = new DatabaseSync(dbPath);
        const oldSql = readFileSync(
          path.join('drizzle', FIRST_MIGRATION_DIR, 'migration.sql'),
          'utf8',
        );
        for (const stmt of oldSql.split('--> statement-breakpoint')) {
          raw.exec(stmt);
        }
        raw.exec(`
          CREATE TABLE __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at TEXT
          );
        `);
        raw
          .prepare(
            `INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
             VALUES ('seed', 0, ?, 'seeded')`,
          )
          .run(FIRST_MIGRATION_DIR);
        const now = Date.now();
        raw
          .prepare(
            `INSERT INTO resources (kind, coolify_uuid, name, policy, config_fingerprint,
             current_image, created_at, updated_at) VALUES ('application', 'legacy-app', 'jellyfin',
             'notify', 'fp', 'nginx:1.25', ?, ?)`,
          )
          .run(now, now);
        raw
          .prepare(
            `INSERT INTO update_jobs (resource_id, kind, trigger, candidate_digest,
             candidate_reference, status, stage, idempotency_key, log, created_at, updated_at)
             VALUES (1, 'update', 'manual', ?, ?, 'running', 'awaiting_confirmation',
             'legacy:1', '[]', ?, ?)`,
          )
          .run(`sha256:${'a'.repeat(64)}`, 'nginx@legacy', now, now);
        raw.close();
      }
      // Upgrade: the new migration applies cleanly on the old shape.
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        const legacy = db.select().from(updateJobs).all();
        expect(legacy).toHaveLength(1);
        expect(legacy[0]).toMatchObject({ status: 'running', stage: 'awaiting_confirmation' });
        expect(legacy[0]?.confirmationDueAt).toBeNull();
        // The added column is writable and readable.
        db.update(updateJobs)
          .set({ confirmationDueAt: 1234 })
          .where(eq(updateJobs.id, legacy[0]!.id))
          .run();
        expect(db.select().from(updateJobs).all()[0]?.confirmationDueAt).toBe(1234);
        close();
      }
      // Reopen again: idempotent, data intact.
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        expect(db.select().from(updateJobs).all()[0]?.confirmationDueAt).toBe(1234);
        close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- 旧库升级：真实旧 schema → 版本化 SQL migration → 正常同步 -----------------

const FIRST_MIGRATION_DIR = '20260929024617_elite_dagger';
const OLD_MIGRATION_DIR = FIRST_MIGRATION_DIR;
const NEW_MIGRATION_DIR = '20261001000000_management_classification';

/** Build a pre-upgrade database: old schema only, first migration recorded. */
function buildOldSchemaDb(dbPath: string): void {
  const { sqlite, close } = openDatabase(dbPath);
  try {
    const oldSql = readFileSync(path.join('drizzle', OLD_MIGRATION_DIR, 'migration.sql'), 'utf8');
    for (const stmt of oldSql.split('--> statement-breakpoint')) {
      sqlite.exec(stmt);
    }
    sqlite.exec(
      `CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
    );
    sqlite
      .prepare(
        `INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)`,
      )
      .run('old', 0, OLD_MIGRATION_DIR, new Date().toISOString());

    // 旧库存量数据：正常同步过的应用、合并排除行、父子组、removed 行、
    // 追踪、排队任务、通知 —— 全部走 raw SQL（旧 schema 没有新列）。
    const now = Date.now();
    const insRes = (
      kind: string,
      uuid: string,
      name: string,
      policy: string,
      status: string,
      blocked: string | null,
      excl: number,
      stopped: number,
      createdAt: number,
      updatedAt: number,
      syncedAt: number,
      fp: string,
    ): void => {
      sqlite
        .prepare(
          `INSERT INTO resources (kind, coolify_uuid, name, policy, status, blocked_reason, excluded_infra, is_stopped, created_at, updated_at, last_synced_at, config_fingerprint)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          kind,
          uuid,
          name,
          policy,
          status,
          blocked,
          excl,
          stopped,
          createdAt,
          updatedAt,
          syncedAt,
          fp,
        );
    };
    insRes(
      'application',
      'old-app-ok',
      'jellyfin',
      'notify',
      'active',
      null,
      0,
      0,
      now,
      now,
      now,
      'fp',
    );
    insRes(
      'application',
      'old-app-merged',
      'xiaoya',
      'ignore',
      'active',
      null,
      1,
      0,
      now,
      now,
      now,
      'fp',
    );
    insRes(
      'compose_service',
      'old-svc',
      'stack',
      'ignore',
      'active',
      null,
      1,
      0,
      now,
      now,
      now,
      'fp',
    );
    const parentId = sqlite
      .prepare(`SELECT id FROM resources WHERE coolify_uuid = 'old-svc'`)
      .get()!.id as number;
    insRes(
      'service_application',
      'old-child',
      'web',
      'ignore',
      'active',
      null,
      1,
      0,
      now,
      now,
      now,
      'fp',
    );
    sqlite
      .prepare(`UPDATE resources SET parent_id = ? WHERE coolify_uuid = 'old-child'`)
      .run(parentId);
    insRes(
      'application',
      'old-removed',
      'gone',
      'ignore',
      'removed',
      null,
      0,
      0,
      now,
      now,
      now,
      'fp',
    );

    const okId = sqlite.prepare(`SELECT id FROM resources WHERE coolify_uuid = 'old-app-ok'`).get()!
      .id as number;
    const childId = sqlite
      .prepare(`SELECT id FROM resources WHERE coolify_uuid = 'old-child'`)
      .get()!.id as number;
    const insTrack = (
      rid: number,
      reg: string,
      repo: string,
      authored: string,
      tag: string,
      platform: string,
      platformSource: string,
      createdAt: number,
      updatedAt: number,
    ): void => {
      sqlite
        .prepare(
          `INSERT INTO image_tracks (resource_id, source_registry, source_repository, source_repository_authored, source_tag, target_platform, platform_source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(rid, reg, repo, authored, tag, platform, platformSource, createdAt, updatedAt);
    };
    insTrack(
      okId,
      'docker.io',
      'jellyfin/jellyfin',
      'jellyfin/jellyfin',
      'latest',
      'linux/amd64',
      'server_default',
      now,
      now,
    );
    insTrack(
      childId,
      'docker.io',
      'library/nginx',
      'nginx',
      '1.27',
      'linux/arm64',
      'compose',
      now,
      now,
    );

    sqlite
      .prepare(
        `INSERT INTO update_jobs (resource_id, kind, trigger, candidate_digest, candidate_reference, status, stage, attempts, log, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        okId,
        'update',
        'auto',
        `sha256:${'b'.repeat(64)}`,
        'jellyfin/jellyfin:sha256-b',
        'pending',
        'queued',
        0,
        '[]',
        'auto:old:digest:0',
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO notification_outbox (event_type, resource_id, dedupe_key, title, body, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('candidate_found', okId, 'old-dedupe-1', '发现候选更新', 'body', 'pending', 0, now, now);
  } finally {
    close();
  }
}

function columnNames(dbPath: string, table: string): string[] {
  const { sqlite, close } = openDatabase(dbPath);
  try {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    close();
  }
}

describe('old-database upgrade via versioned SQL migration', () => {
  it('initializes legacy rows as unclassified and keeps all history intact', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-upgrade-'));
    const dbPath = path.join(dir, 'toolkit.db');
    try {
      buildOldSchemaDb(dbPath);
      expect(columnNames(dbPath, 'resources')).not.toContain('management_classified');

      // Upgrade: the versioned migration runs exactly once, via the normal migrate().
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        const cols = (
          db.select().from(resources).all() as unknown as Array<{
            coolifyUuid: string;
            excludedInfra: boolean;
            managementClassified: boolean;
            imageIssue: string | null;
            policy: string;
            status: string;
            blockedReason: string | null;
          }>
        ).reduce(
          (acc, r) => acc.set(r.coolifyUuid, r),
          new Map<
            string,
            {
              excludedInfra: boolean;
              managementClassified: boolean;
              imageIssue: string | null;
              policy: string;
              status: string;
              blockedReason: string | null;
            }
          >(),
        );
        // 全部存量记录初始化为待同步确认；旧 excludedInfra 原样保留为历史信息。
        for (const uuid of [
          'old-app-ok',
          'old-app-merged',
          'old-svc',
          'old-child',
          'old-removed',
        ]) {
          const row = cols.get(uuid);
          expect(row, uuid).toBeDefined();
          expect(row!.managementClassified).toBe(false);
          expect(row!.imageIssue).toBeNull();
        }
        // 旧字段与历史完整：合并排除值、策略、状态、blockedReason 不被改写。
        expect(cols.get('old-app-merged')?.excludedInfra).toBe(true);
        expect(cols.get('old-svc')?.excludedInfra).toBe(true);
        expect(cols.get('old-child')?.excludedInfra).toBe(true);
        expect(cols.get('old-app-ok')?.excludedInfra).toBe(false);
        expect(cols.get('old-app-ok')?.policy).toBe('notify');
        expect(cols.get('old-removed')?.status).toBe('removed');
        // 追踪、任务、通知保留。
        const okId = db
          .select()
          .from(resources)
          .where(eq(resources.coolifyUuid, 'old-app-ok'))
          .get()!.id;
        expect(
          db.select().from(imageTracks).where(eq(imageTracks.resourceId, okId)).get()?.sourceTag,
        ).toBe('latest');
        const job = db.select().from(updateJobs).where(eq(updateJobs.resourceId, okId)).get();
        expect(job?.status).toBe('pending');
        expect(job?.deploymentUuid).toBeNull();
        close();
      }

      // 重复 migrate 幂等：初始化不重复执行，状态保持。
      {
        const { db, close } = openDatabase(dbPath);
        migrate(db);
        migrate(db);
        const rows = db.select().from(resources).all();
        expect(rows.every((r) => r.managementClassified === false)).toBe(true);
        close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps classification stable across sync + reopen + repeated migrate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-upgrade-sync-'));
    const dbPath = path.join(dir, 'toolkit.db');
    try {
      buildOldSchemaDb(dbPath);
      const { db, close } = openDatabase(dbPath);
      migrate(db);
      const cfg = {
        coolifyBaseUrl: 'http://x',
        coolifyApiKey: 'k',
        coolifyVerifyTls: true,
        excludedUuids: ['old-svc'],
        databasePath: dbPath,
        registryCredentials: {},
        githubToken: null,
        port: 0,
        publicOrigin: null,
        apprise: { apiUrl: null, configKey: null, tag: null, user: null, password: null },
        deployConcurrency: 1,
        dataDir: dir,
      } satisfies AppConfig;
      const settings = new SettingsRepo(db);
      // Coolify 仍返回旧资源；old-app-merged 的镜像其实是可解析的 —— 正常
      // 同步负责确认真实分类，迁移阶段保持其历史排除值不被改写。
      const apps = [
        {
          id: 1,
          uuid: 'old-app-ok',
          name: 'jellyfin',
          build_pack: 'dockerimage',
          docker_image: 'jellyfin/jellyfin',
          docker_image_tag: 'latest',
          status: 'running',
        },
        {
          id: 2,
          uuid: 'old-app-merged',
          name: 'xiaoya',
          build_pack: 'dockerimage',
          docker_image: 'haroldli/xiaoya-tvbox',
          docker_image_tag: 'latest',
          status: 'running',
        },
      ] as unknown as CoolifyApplication[];
      const sync = new InventorySync(
        db,
        {
          listApplications: async () => apps,
          listServices: async () => [
            {
              id: 3,
              uuid: 'old-svc',
              name: 'stack',
              docker_compose_raw: 'services:\n  web:\n    image: nginx:1.27\n',
              status: 'running',
            },
          ],
          listServiceApplications: async () => [
            {
              uuid: 'old-child',
              name: 'web',
              human_name: 'Web',
              image: 'nginx:1.27',
              status: 'running',
            },
          ],
          listResourceEntries: async () => [],
        } as unknown as CoolifyClient,
        cfg,
        settings,
      );
      await sync.run();

      // 正常同步后：全部 seen 记录已分类；merged 行的真实排除来源（名单外）
      // 被同步纠正；svc 命中名单维持排除；子容器继承。
      const byUuid = new Map(
        db
          .select()
          .from(resources)
          .all()
          .map((r) => [r.coolifyUuid, r]),
      );
      expect(byUuid.get('old-app-ok')?.managementClassified).toBe(true);
      expect(byUuid.get('old-app-merged')).toMatchObject({
        managementClassified: true,
        excludedInfra: false,
        imageIssue: null,
      });
      expect(byUuid.get('old-svc')).toMatchObject({
        managementClassified: true,
        excludedInfra: true,
        imageIssue: null,
      });
      expect(byUuid.get('old-child')?.excludedInfra).toBe(true);
      // removed 行 Coolify 已不再返回 → 同步仅刷新状态；分类保持待确认。
      expect(byUuid.get('old-removed')).toMatchObject({
        status: 'removed',
        managementClassified: false,
      });

      // 重开 + 重复 migrate：分类结果保持，不回退为待确认。
      close();
      {
        const reopened = openDatabase(dbPath);
        migrate(reopened.db);
        migrate(reopened.db);
        const again = new Map(
          reopened.db
            .select()
            .from(resources)
            .all()
            .map((r) => [r.coolifyUuid, r]),
        );
        expect(again.get('old-app-ok')?.managementClassified).toBe(true);
        expect(again.get('old-svc')?.excludedInfra).toBe(true);
        expect(again.get('old-removed')?.managementClassified).toBe(false);
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failed migration atomically and leaves history clean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-upgrade-fail-'));
    const dbPath = path.join(dir, 'toolkit.db');
    try {
      buildOldSchemaDb(dbPath);
      // 预置同名列，使新迁移第一条 ALTER 失败。
      const setup = openDatabase(dbPath);
      setup.sqlite.exec(
        `ALTER TABLE resources ADD COLUMN management_classified integer DEFAULT false NOT NULL`,
      );
      setup.close();

      const { db, close } = openDatabase(dbPath);
      // drizzle 包装了底层错误信息；只断言失败发生且无部分写入。
      expect(() => migrate(db)).toThrow(/management_classified/);
      // 原子回滚：第二条语句的 image_issue 未被添加，迁移历史无新记录。
      expect(columnNames(dbPath, 'resources')).not.toContain('image_issue');
      const applied = openDatabase(dbPath)
        .sqlite.prepare(`SELECT name FROM __drizzle_migrations WHERE name = ?`)
        .all(NEW_MIGRATION_DIR) as unknown[];
      expect(applied).toHaveLength(0);
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
