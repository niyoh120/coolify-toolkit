// Inventory sync: pull Coolify applications + services into the local projection.
// Sync is full-scan; partial API failures abort the run and keep existing rows
// (removal is only marked after a complete, successful sync).

import { and, eq, isNull, or } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import type { CoolifyServiceApplication } from '../../../shared/schemas.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { ResourceRow } from '../../db/schema.js';
import { imageTracks, resources } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import type { CoolifyClient } from '../../integrations/coolify/client.js';
import { applicationImageRef } from '../../integrations/coolify/mapper.js';
import type { NormalizedRef } from '../../integrations/registry/reference.js';
import { fingerprintObject, sha256Hex } from '../fingerprint.js';
import { clearedObservation, liveMatchesBaseline } from '../updates/image-state.js';
import { classifyImage } from './management-state.js';
export interface SyncResult {
  resourcesSeen: number;
  created: number;
  externalChanges: number;
  removed: number;
  errors: string[];
}

const MANAGEABLE_BUILD_PACK = 'dockerimage';

interface AppLike {
  uuid: string;
  name: string | null;
  serverName: string | null;
  serverUuid: string | null;
  projectUuid: string | null;
  environmentUuid: string | null;
  projectName: string | null;
  environmentName: string | null;
  domains: string | null;
  status: string | null;
  image: string | null; // full current image reference (tag or digest form)
  fingerprint: string;
  stopped: boolean;
}

function appToAppLike(
  a: Awaited<ReturnType<CoolifyClient['listApplications']>>[number],
): AppLike | null {
  if (a.build_pack !== MANAGEABLE_BUILD_PACK) return null;
  const image = applicationImageRef(a);
  return {
    uuid: a.uuid,
    name: a.name ?? null,
    serverName: a.destination?.name ?? null,
    serverUuid: a.destination?.id != null ? String(a.destination.id) : null,
    projectUuid: a.project?.uuid ?? null,
    environmentUuid: a.environment?.uuid ?? null,
    projectName: a.project?.name ?? null,
    environmentName: a.environment?.name ?? null,
    domains: a.fqdn,
    status: a.status,
    image,
    fingerprint: fingerprintObject({
      docker_registry: a.docker_registry ?? '',
      docker_image: a.docker_image ?? '',
      docker_image_tag: a.docker_image_tag ?? '',
      docker_registry_image_name: a.docker_registry_image_name ?? '',
      docker_registry_image_tag: a.docker_registry_image_tag ?? '',
      fqdn: a.fqdn ?? '',
    }),
    stopped: (a.status ?? '').includes('stopped') || (a.status ?? '').includes('exited'),
  };
}

/** Sentinel node arch → registry platform; unknown architectures stay unset. */
export function archToPlatform(arch: string): string | null {
  const a = arch.toLowerCase();
  if (a === 'x86_64' || a === 'amd64') return 'linux/amd64';
  if (a === 'aarch64' || a === 'arm64') return 'linux/arm64';
  if (a === 'armv7l' || a === 'armhf') return 'linux/arm/v7';
  if (a === 'armv6l') return 'linux/arm/v6';
  return null;
}

/**
 * External change blocks auto flows until the live reference matches the
 * tracked expectation again. Creation-time flags (legacy artifact of the
 * unparseable-image path) heal automatically once a sync observes a matching,
 * parseable reference.
 */
function resolveBlockedReason(
  externalChange: boolean,
  matchesNow: boolean,
  existing: string | null,
): string | null {
  if (externalChange) return 'external_change';
  if (existing === 'external_change' && matchesNow) return null;
  return existing;
}

/** Extract `platform:` for a compose service name from raw compose (in memory only). */
function composeServicePlatform(composeRaw: string, serviceName: string | null): string | null {
  try {
    const doc = parseYaml(composeRaw) as {
      services?: Record<string, { platform?: unknown }>;
    } | null;
    if (doc == null || typeof doc !== 'object' || doc.services == null) return null;
    if (serviceName == null) return null;
    const svc = doc.services[serviceName];
    const p = svc?.platform;
    return typeof p === 'string' && /^[a-z0-9]+\/[a-z0-9]+(\/[a-z0-9-]+)?$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

export class InventorySync {
  constructor(
    private readonly db: Db,
    private readonly coolify: CoolifyClient,
    private readonly cfg: AppConfig,
    private readonly settings?: SettingsRepo,
  ) {}

  /** destId→uuid map from the latest /resources call; empty when unavailable. */
  private destToServer = new Map<string, string>();

  /** destId→server name map so resources show their real node. */
  private destToServerName = new Map<string, string>();

  /** server uuid → detected platform from node metadata; empty when unavailable. */
  private nodeArch = new Map<string, string>();

  /** Real node name for a destination id; falls back to the payload name. */
  private serverNameFor(destId: string | null, fallback: string | null): string | null {
    if (destId != null) {
      const mapped = this.destToServerName.get(destId);
      if (mapped != null) return mapped;
    }
    return fallback;
  }

  private resolveServerPlatform(serverId: string | null): {
    platform: string | null;
    source: 'server_default' | 'node' | null;
  } {
    if (serverId != null) {
      const uuid = this.destToServer.get(serverId);
      const detected = uuid != null ? this.nodeArch.get(uuid) : undefined;
      if (detected != null) return { platform: detected, source: 'node' };
    }
    // 节点未上报架构：保持待配置，由详情页手动设置。
    return { platform: null, source: null };
  }

  /**
   * Refresh topology from the aggregate /resources payload: destination→server
   * mapping, real server names, and per-node arch. Nodes without resources are
   * out of scope — platform is a resource attribute.
   */
  private async refreshTopology(): Promise<void> {
    this.destToServer = new Map();
    this.destToServerName = new Map();
    this.nodeArch = new Map();
    try {
      const entries = await this.coolify.listResourceEntries();
      for (const e of entries) {
        // Applications embed destination.server; services expose flat
        // destination_id + server at the top level.
        const destId = e.destination?.id ?? e.destination_id;
        const srv = e.destination?.server ?? e.server ?? null;
        const serverUuid = srv?.uuid ?? null;
        if (destId != null) {
          if (serverUuid != null) this.destToServer.set(String(destId), serverUuid);
          const serverName = srv?.name ?? null;
          if (serverName != null) this.destToServerName.set(String(destId), serverName);
        }
        const arch = srv?.server_metadata?.arch ?? null;
        if (serverUuid != null && arch != null) {
          const platform = archToPlatform(arch);
          if (platform != null) this.nodeArch.set(serverUuid, platform);
        }
      }
    } catch {
      // Detection degrades to the env fallback; nothing to guess.
    }
  }

  /**
   * Re-applies node/global default platforms to discovery-aligned tracks
   * ('server_default' source or never-configured rows). Compose-derived and
   * manually edited platforms stay untouched. Returns the number of rows updated.
   */
  async backfillDefaultPlatforms(): Promise<number> {
    await this.refreshTopology();
    const rows = this.db
      .select({ track: imageTracks, resource: resources })
      .from(imageTracks)
      .innerJoin(resources, eq(resources.id, imageTracks.resourceId))
      .all();
    // 父服务本身没有 image track，join 结果缺少父行；子容器继承父服务的
    // 节点，因此父级查找映射必须覆盖 resources 全表，避免回填把子容器
    // 继承到的平台清空（历史 null 平台也经由同一路径自愈）。
    const byId = new Map(
      this.db
        .select({ id: resources.id, serverUuid: resources.serverUuid })
        .from(resources)
        .all()
        .map((r) => [r.id, r]),
    );
    const now = Date.now();
    let updated = 0;
    for (const { track, resource } of rows) {
      // Only discovery-aligned sources follow the resolution chain;
      // compose-derived and manually edited platforms stay untouched.
      const managed =
        track.platformSource === 'server_default' ||
        track.platformSource === 'node' ||
        (track.platformSource == null && track.targetPlatform == null);
      if (!managed) continue;
      // Children inherit their parent service's server.
      let serverId = resource.serverUuid;
      if (serverId == null && resource.parentId != null) {
        serverId = byId.get(resource.parentId)?.serverUuid ?? null;
      }
      const resolved = this.resolveServerPlatform(serverId);
      if (resolved.platform === track.targetPlatform && resolved.source === track.platformSource) {
        continue;
      }
      // F13: a platform change invalidates platform-scoped observations and
      // bumps the tracking revision (same semantics as the manual PATCH).
      this.db
        .update(imageTracks)
        .set({
          targetPlatform: resolved.platform,
          platformSource: resolved.platform == null ? null : resolved.source,
          trackingRevision: track.trackingRevision + 1,
          ...clearedObservation(),
          updatedAt: now,
        })
        .where(eq(imageTracks.id, track.id))
        .run();
      updated += 1;
    }
    return updated;
  }

  /**
   * project/environment uuids only appear in detail payloads (list responses
   * return null relations). Backfill missing values for the Deep Link, at most
   * 50 detail calls per sync; the sub-containers inherit directly from the parent row.
   */
  private async backfillResourceUuids(): Promise<void> {
    const all = this.db
      .select({
        id: resources.id,
        kind: resources.kind,
        coolifyUuid: resources.coolifyUuid,
        parentId: resources.parentId,
        projectUuid: resources.projectUuid,
        environmentUuid: resources.environmentUuid,
      })
      .from(resources)
      .all();
    const byId = new Map(all.map((r) => [r.id, r]));
    const now = Date.now();
    const needsUuid = (r: (typeof all)[number]): boolean =>
      r.projectUuid == null || r.environmentUuid == null;

    // 1) Children inherit from their parent row (free, no API calls).
    for (const row of all) {
      if (row.kind !== 'service_application' || row.parentId == null || !needsUuid(row)) continue;
      const parent = byId.get(row.parentId);
      if (parent == null || needsUuid(parent)) continue;
      this.db
        .update(resources)
        .set({
          projectUuid: parent.projectUuid,
          environmentUuid: parent.environmentUuid,
          updatedAt: now,
        })
        .where(eq(resources.id, row.id))
        .run();
    }

    // 2) Applications and services: uuids exist only in detail payloads.
    const pending = this.db
      .select({ id: resources.id, kind: resources.kind, coolifyUuid: resources.coolifyUuid })
      .from(resources)
      .where(
        and(
          or(isNull(resources.projectUuid), isNull(resources.environmentUuid)),
          or(eq(resources.kind, 'application'), eq(resources.kind, 'compose_service')),
        ),
      )
      .limit(50)
      .all();
    for (const row of pending) {
      try {
        const detail =
          row.kind === 'application'
            ? await this.coolify.getApplication(row.coolifyUuid)
            : await this.coolify.getService(row.coolifyUuid);
        // v4.3.23 detail payloads: project relation is null; the project uuid
        // rides inside environment.project.
        const environmentUuid = detail.environment?.uuid ?? null;
        const projectUuid = detail.project?.uuid ?? detail.environment?.project?.uuid ?? null;
        if (projectUuid == null && environmentUuid == null) continue;
        this.db
          .update(resources)
          .set({ projectUuid, environmentUuid, updatedAt: now })
          .where(eq(resources.id, row.id))
          .run();
      } catch {
        // Detail call failed: retry on the next sync.
      }
    }
  }

  async run(): Promise<SyncResult> {
    const errors: string[] = [];
    const result: SyncResult = {
      resourcesSeen: 0,
      created: 0,
      externalChanges: 0,
      removed: 0,
      errors,
    };

    // Topology first so upserts can label resources with their real server.
    await this.refreshTopology();

    // Track revisions captured BEFORE every external read (F8): a concurrent
    // adopt/save/reset invalidates the whole batch's external data for that
    // resource, so the snapshot must precede listApplications/listServices.
    const revisionsAtStart = this.trackRevisions();

    // Full lists first — a failure here aborts before any removal marking.
    const applications = (await this.coolify.listApplications())
      .map(appToAppLike)
      .filter((a): a is AppLike => a != null);
    const services = await this.coolify.listServices();
    result.resourcesSeen = applications.length + services.length;

    const now = Date.now();
    const seenKeys = new Set<string>();

    // Compose children are fetched per service; individual failures isolate
    // the *update* for that service while preserving existing rows from the
    // stale-removal pass below (plan §6: partial failure keeps resources).
    for (const svc of services) {
      let children: CoolifyServiceApplication[] = [];
      try {
        children = await this.coolify.listServiceApplications(svc.uuid);
      } catch (err) {
        errors.push(
          `service ${svc.uuid}: child list failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        // Keep the parent and its known children out of removal marking.
        seenKeys.add(`compose_service|${svc.uuid}`);
        const knownParent = await this.db
          .select()
          .from(resources)
          .where(and(eq(resources.kind, 'compose_service'), eq(resources.coolifyUuid, svc.uuid)))
          .get();
        if (knownParent != null) {
          const knownChildren = await this.db
            .select()
            .from(resources)
            .where(eq(resources.parentId, knownParent.id))
            .all();
          for (const kc of knownChildren) {
            seenKeys.add(`${kc.kind}|${kc.coolifyUuid}`);
          }
        }
        continue;
      }
      const svcExcluded = this.cfg.excludedUuids.includes(svc.uuid);
      const parentRow = await this.upsertParentService(svc, svcExcluded, now);
      seenKeys.add(`compose_service|${svc.uuid}`);
      for (const child of children) {
        const platform = composeServicePlatform(svc.docker_compose_raw ?? '', childName(child));
        const childExcluded = svcExcluded || this.cfg.excludedUuids.includes(child.uuid);
        await this.upsertChild(
          parentRow,
          svc,
          child,
          platform,
          childExcluded,
          now,
          result,
          revisionsAtStart,
        );
        seenKeys.add(`service_application|${child.uuid}`);
      }
    }

    for (const app of applications) {
      const excluded = this.cfg.excludedUuids.includes(app.uuid);
      await this.upsertApplication(app, excluded, now, result, revisionsAtStart);
      seenKeys.add(`application|${app.uuid}`);
    }

    // Complete sync succeeded for listed parents/children/apps we saw; mark
    // stale rows removed. F8/R5-F4: the write is CONDITIONAL on the snapshot
    // revision (checked again inside a short transaction per row), so a reset
    // landing between the stale computation and the UPDATE cannot be undone.
    const allActive = await this.db.select().from(resources).where(eq(resources.status, 'active'));
    const stale = allActive.filter((r) => !seenKeys.has(`${r.kind}|${r.coolifyUuid}`));
    for (const row of stale) {
      const before = revisionsAtStart?.get(row.id);
      if (before == null) {
        // No track at snapshot time: nothing to guard (parent rows etc.).
        await this.db
          .update(resources)
          .set({ status: 'removed', updatedAt: now })
          .where(eq(resources.id, row.id));
        result.removed += 1;
        continue;
      }
      const applied = this.db.transaction((tx) => {
        const current = tx
          .select({ rev: imageTracks.trackingRevision })
          .from(imageTracks)
          .where(eq(imageTracks.resourceId, row.id))
          .get();
        if (current == null || current.rev !== before) return false;
        tx.update(resources)
          .set({ status: 'removed', updatedAt: now })
          .where(eq(resources.id, row.id))
          .run();
        return true;
      });
      if (applied) result.removed += 1;
    }

    // Re-apply node/global defaults to discovery-aligned tracks so new
    // settings reach存量 rows without manual edits (compose/manual stay untouched).
    await this.backfillResourceUuids();
    await this.backfillDefaultPlatforms();

    this.settings?.setMeta('lastSyncAt', now);
    return result;
  }

  private async upsertParentService(
    svc: Awaited<ReturnType<CoolifyClient['listServices']>>[number],
    excluded: boolean,
    now: number,
  ): Promise<ResourceRow> {
    const fingerprint = fingerprintObject({
      compose_raw_sha: svc.docker_compose_raw == null ? '' : sha256Hex(svc.docker_compose_raw),
      status: svc.status ?? '',
    });
    const existing = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.kind, 'compose_service'), eq(resources.coolifyUuid, svc.uuid)))
      .get();
    const isStopped =
      (svc.status ?? '').includes('stopped') || (svc.status ?? '').includes('exited');
    if (existing != null) {
      const resolvedServerUuid =
        svc.destination?.id != null ? String(svc.destination.id) : existing.serverUuid;
      await this.db
        .update(resources)
        .set({
          name: svc.name ?? existing.name,
          projectUuid: svc.project?.uuid ?? existing.projectUuid,
          environmentUuid: svc.environment?.uuid ?? existing.environmentUuid,
          // 拓扑归属由 Coolify 数据决定：历史行缺 serverUuid（创建时
          // destination 缺失）或迁移服务器时在同步中补全/更新。
          serverUuid: resolvedServerUuid,
          serverName: this.serverNameFor(
            svc.destination?.id != null ? String(svc.destination.id) : null,
            existing.serverName,
          ),
          currentImage: null,
          configFingerprint: fingerprint,
          excludedInfra: excluded,
          // 父服务不承载镜像：正常同步后永远是已分类、无镜像问题。
          managementClassified: true,
          imageIssue: null,
          isStopped,
          status: 'active',
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(resources.id, existing.id));
      // Return the post-update values so children inherit the fresh server.
      return {
        ...existing,
        serverUuid: resolvedServerUuid,
        serverName: this.serverNameFor(
          svc.destination?.id != null ? String(svc.destination.id) : null,
          existing.serverName,
        ),
        configFingerprint: fingerprint,
      };
    }
    const inserted = await this.db
      .insert(resources)
      .values({
        kind: 'compose_service',
        coolifyUuid: svc.uuid,
        name: svc.name ?? svc.uuid,
        serverUuid: svc.destination?.id != null ? String(svc.destination.id) : null,
        serverName: this.serverNameFor(
          svc.destination?.id != null ? String(svc.destination.id) : null,
          svc.destination?.name ?? null,
        ),
        projectUuid: svc.project?.uuid ?? null,
        environmentUuid: svc.environment?.uuid ?? null,
        projectName: svc.project?.name ?? null,
        environmentName: svc.environment?.name ?? null,
        currentImage: null,
        configFingerprint: fingerprint,
        policy: 'ignore',
        excludedInfra: excluded,
        managementClassified: true,
        imageIssue: null,
        isStopped,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return inserted;
  }

  /** resourceId → trackingRevision snapshot taken before external reads. */
  private trackRevisions(): Map<number, number> {
    return new Map(
      this.db
        .select({ resourceId: imageTracks.resourceId, revision: imageTracks.trackingRevision })
        .from(imageTracks)
        .all()
        .map((r) => [r.resourceId, r.revision]),
    );
  }

  /**
   * True when the resource's tracking revision changed since the batch
   * snapshot: an adopt/save/reset happened mid-sync, so this batch's external
   * read is stale for that resource. Resource/track writes are skipped whole.
   */
  private trackingChangedSince(snapshot: Map<number, number>, resourceId: number): boolean {
    const before = snapshot.get(resourceId);
    if (before == null) return false; // no track at snapshot time: nothing to guard
    const current = this.db
      .select({ revision: imageTracks.trackingRevision })
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, resourceId))
      .get();
    return current != null && current.revision !== before;
  }

  private async upsertChild(
    parent: ResourceRow,
    _svc: Awaited<ReturnType<CoolifyClient['listServices']>>[number],
    child: CoolifyServiceApplication,
    composePlatform: string | null,
    excluded: boolean,
    now: number,
    result: SyncResult,
    revisionsAtStart?: Map<number, number>,
  ): Promise<void> {
    const image = child.image ?? null;
    const domains = child.fqdn ?? child.url;
    const fingerprint = fingerprintObject({ image: image ?? '', domain: domains ?? '' });
    const existing = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.kind, 'service_application'), eq(resources.coolifyUuid, child.uuid)))
      .get();

    const stopped =
      (child.status ?? '').includes('stopped') || (child.status ?? '').includes('exited');
    const cls = classifyImage(image);
    const parsed = cls.parsed;
    const imageIssue = cls.issue; // expected resolution problems, else null

    if (existing == null) {
      const inserted = await this.db
        .insert(resources)
        .values({
          kind: 'service_application',
          coolifyUuid: child.uuid,
          parentId: parent.id,
          name: child.human_name ?? child.name ?? child.uuid,
          composeServiceName: child.name,
          serverName: parent.serverName,
          projectUuid: parent.projectUuid,
          environmentUuid: parent.environmentUuid,
          projectName: parent.projectName,
          environmentName: parent.environmentName,
          domains,
          currentImage: image,
          configFingerprint: fingerprint,
          policy: 'ignore',
          excludedInfra: excluded,
          managementClassified: true,
          imageIssue,
          isStopped: stopped,
          // First discovery is never an external change; image problems
          // surface via the structured imageIssue instead of external_change.
          blockedReason: null,
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      result.created += 1;
      if (parsed != null) {
        const fallback = this.resolveServerPlatform(parent.serverUuid);
        await this.ensureTrack(
          inserted,
          parsed,
          composePlatform ?? fallback.platform,
          composePlatform != null ? 'compose' : fallback.source,
          image,
          now,
        );
      }
      return;
    }

    // Existing child: detect external image changes against the confirmed
    // baseline (shared semantics; see image-state.liveMatchesBaseline).
    // An adopt/save/reset during this batch invalidates the external read:
    // skip the whole projection for this resource (plan §5).
    if (revisionsAtStart != null && this.trackingChangedSince(revisionsAtStart, existing.id)) {
      return;
    }
    // R4-F2: resource write + track backfill form ONE short transaction with
    // an in-transaction revision re-check (same shape as upsertApplication).
    this.db.transaction((tx) => {
      const track = tx
        .select()
        .from(imageTracks)
        .where(eq(imageTracks.resourceId, existing.id))
        .get();
      if (revisionsAtStart != null && this.trackingChangedSince(revisionsAtStart, existing.id)) {
        return;
      }
      const matchesExpectation = this.imageMatchesTrack(track, parsed);
      const externalChange = existing.lastSyncedAt != null && !matchesExpectation;

      if (externalChange) result.externalChanges += 1;

      tx.update(resources)
        .set({
          name: child.human_name ?? child.name ?? existing.name,
          projectUuid: parent.projectUuid ?? existing.projectUuid,
          environmentUuid: parent.environmentUuid ?? existing.environmentUuid,
          serverName: parent.serverName,
          domains: child.fqdn,
          currentImage: image,
          configFingerprint: fingerprint,
          excludedInfra: excluded,
          managementClassified: true,
          imageIssue,
          isStopped: stopped,
          status: 'active',
          blockedReason: resolveBlockedReason(
            externalChange,
            parsed != null && matchesExpectation,
            existing.blockedReason,
          ),
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(resources.id, existing.id))
        .run();

      if (parsed != null && track == null) {
        const fallback = this.resolveServerPlatform(parent.serverUuid);
        const platform = composePlatform ?? fallback.platform;
        // R5-F8: explicit branches instead of a nested ternary.
        let platformSource: string | null = null;
        if (platform != null) {
          platformSource = composePlatform != null ? 'compose' : fallback.source;
        }
        tx.insert(imageTracks)
          .values({
            resourceId: existing.id,
            sourceRegistry: parsed.registry,
            sourceRepository: parsed.repository,
            sourceRepositoryAuthored: parsed.authoredPath,
            sourceTag: parsed.tag ?? '',
            targetPlatform: platform,
            platformSource,
            configuredReference: image,
            configuredDigest: parsed.digest,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else if (parsed != null && track != null && !externalChange) {
        // Refresh the accepted baseline from live Coolify values. On external
        // change the prior baseline is preserved for re-confirmation.
        tx.update(imageTracks)
          .set({
            configuredReference: image,
            configuredDigest: parsed.digest,
            configuredReferenceKind: null,
            updatedAt: now,
          })
          .where(eq(imageTracks.id, track.id))
          .run();
      }
    });
  }

  /**
   * Shared baseline comparison; null track keeps the historic "no expectations
   * yet" behavior (anything goes, nothing drifts).
   */
  private imageMatchesTrack(
    track: typeof imageTracks.$inferSelect | undefined,
    parsed: NormalizedRef | null,
  ): boolean {
    // The track row IS the channel identity source for legacy digest-only rows.
    if (track == null) return true;
    return liveMatchesBaseline(track, parsed, {
      registry: track.sourceRegistry,
      repository: track.sourceRepository,
    });
  }

  private async upsertApplication(
    app: AppLike,
    excluded: boolean,
    now: number,
    result: SyncResult,
    revisionsAtStart?: Map<number, number>,
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.kind, 'application'), eq(resources.coolifyUuid, app.uuid)))
      .get();

    const cls = classifyImage(app.image);
    const parsed = cls.parsed;
    const imageIssue = cls.issue;

    if (existing == null) {
      const inserted = await this.db
        .insert(resources)
        .values({
          kind: 'application',
          coolifyUuid: app.uuid,
          name: app.name ?? app.uuid,
          serverUuid: app.serverUuid,
          serverName: this.serverNameFor(app.serverUuid, app.serverName),
          projectUuid: app.projectUuid,
          environmentUuid: app.environmentUuid,
          projectName: app.projectName,
          environmentName: app.environmentName,
          domains: app.domains,
          currentImage: app.image,
          configFingerprint: app.fingerprint,
          policy: 'ignore',
          excludedInfra: excluded,
          managementClassified: true,
          imageIssue,
          isStopped: app.stopped,
          // First discovery is never an external change; image problems
          // surface via the structured imageIssue instead of external_change.
          blockedReason: null,
          lastSyncedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      result.created += 1;
      if (parsed != null) {
        await this.ensureTrack(
          inserted,
          parsed,
          this.resolveServerPlatform(app.serverUuid).platform,
          this.resolveServerPlatform(app.serverUuid).source,
          app.image,
          now,
        );
      }
      return;
    }

    // Adopt/save/reset during this batch invalidates the external read for
    // this resource: skip the whole projection (plan §5).
    if (revisionsAtStart != null && this.trackingChangedSince(revisionsAtStart, existing.id)) {
      return;
    }
    // R4-F2: resource write + track backfill form ONE short transaction with
    // an in-transaction revision re-check, so an adopt/reset landing between
    // the two writes can never leave a mixed state (e.g. ignore + old baseline).
    this.db.transaction((tx) => {
      const track = tx
        .select()
        .from(imageTracks)
        .where(eq(imageTracks.resourceId, existing.id))
        .get();
      // Re-check inside the transaction: the revision may have moved between
      // the batch snapshot and this write.
      if (revisionsAtStart != null && this.trackingChangedSince(revisionsAtStart, existing.id)) {
        return;
      }
      const matchesExpectation = this.imageMatchesTrack(track, parsed);
      // F6: drift is decided ONLY by the baseline match (see upsertChild).

      const externalChange = existing.lastSyncedAt != null && !matchesExpectation;
      if (externalChange) result.externalChanges += 1;

      tx.update(resources)
        .set({
          name: app.name ?? existing.name,
          projectUuid: app.projectUuid ?? existing.projectUuid,
          environmentUuid: app.environmentUuid ?? existing.environmentUuid,
          // 与服务父行相同：历史行缺 serverUuid 或迁移时在同步中补全/更新。
          serverUuid: app.serverUuid ?? existing.serverUuid,
          serverName: this.serverNameFor(app.serverUuid, existing.serverName),
          domains: app.domains,
          currentImage: app.image,
          configFingerprint: app.fingerprint,
          excludedInfra: excluded,
          managementClassified: true,
          imageIssue,
          isStopped: app.stopped,
          status: 'active',
          blockedReason: resolveBlockedReason(
            externalChange,
            parsed != null && matchesExpectation,
            existing.blockedReason,
          ),
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(resources.id, existing.id))
        .run();

      if (parsed != null && track == null) {
        tx.insert(imageTracks)
          .values({
            resourceId: existing.id,
            sourceRegistry: parsed.registry,
            sourceRepository: parsed.repository,
            sourceRepositoryAuthored: parsed.authoredPath,
            sourceTag: parsed.tag ?? '',
            targetPlatform: this.resolveServerPlatform(app.serverUuid).platform,
            platformSource:
              this.resolveServerPlatform(app.serverUuid).platform == null
                ? null
                : this.resolveServerPlatform(app.serverUuid).source,
            configuredReference: app.image,
            configuredDigest: parsed.digest,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } else if (parsed != null && track != null && !externalChange) {
        // On external change the prior pinned digest is preserved for re-confirmation.
        tx.update(imageTracks)
          .set({
            configuredReference: app.image,
            configuredDigest: parsed.digest,
            updatedAt: now,
          })
          .where(eq(imageTracks.id, track.id))
          .run();
      }
    });
  }

  /** First sight of a resource: create its track from the current Coolify config. */
  private async ensureTrack(
    resource: Pick<ResourceRow, 'id'>,
    parsed: NormalizedRef,
    platform: string | null,
    platformSource: string | null,
    configuredReference: string | null,
    now: number,
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, resource.id))
      .get();
    if (existing != null) return;
    await this.db.insert(imageTracks).values({
      resourceId: resource.id,
      sourceRegistry: parsed.registry,
      sourceRepository: parsed.repository,
      sourceRepositoryAuthored: parsed.authoredPath,
      // Digest-only references lack a channel; tag must be configured before checks.
      sourceTag: parsed.tag ?? '',
      targetPlatform: platform,
      platformSource: platform == null ? null : platformSource,
      configuredReference,
      configuredDigest: parsed.digest,
      createdAt: now,
      updatedAt: now,
    });
  }
}

function childName(child: CoolifyServiceApplication): string | null {
  return child.name;
}
