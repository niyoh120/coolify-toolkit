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
import { normalizeReference } from '../../integrations/registry/reference.js';
import { fingerprintObject, sha256Hex } from '../fingerprint.js';
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
    const byId = new Map(rows.map((r) => [r.resource.id, r.resource]));
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
      this.db
        .update(imageTracks)
        .set({
          targetPlatform: resolved.platform,
          platformSource: resolved.platform == null ? null : resolved.source,
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
        await this.upsertChild(parentRow, svc, child, platform, childExcluded, now, result);
        seenKeys.add(`service_application|${child.uuid}`);
      }
    }

    for (const app of applications) {
      const excluded = this.cfg.excludedUuids.includes(app.uuid);
      await this.upsertApplication(app, excluded, now, result);
      seenKeys.add(`application|${app.uuid}`);
    }

    // Complete sync succeeded for listed parents/children/apps we saw; mark stale rows removed.
    const allActive = await this.db.select().from(resources).where(eq(resources.status, 'active'));
    const stale = allActive.filter((r) => !seenKeys.has(`${r.kind}|${r.coolifyUuid}`));
    for (const row of stale) {
      await this.db
        .update(resources)
        .set({ status: 'removed', updatedAt: now })
        .where(eq(resources.id, row.id));
      result.removed += 1;
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
      await this.db
        .update(resources)
        .set({
          name: svc.name ?? existing.name,
          projectUuid: svc.project?.uuid ?? existing.projectUuid,
          environmentUuid: svc.environment?.uuid ?? existing.environmentUuid,
          serverName: this.serverNameFor(
            svc.destination?.id != null ? String(svc.destination.id) : null,
            existing.serverName,
          ),
          currentImage: null,
          configFingerprint: fingerprint,
          excludedInfra: excluded,
          isStopped,
          status: 'active',
          lastSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(resources.id, existing.id));
      // Return the post-update values so children inherit the fresh server name.
      return {
        ...existing,
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
        isStopped,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return inserted;
  }

  private async upsertChild(
    parent: ResourceRow,
    _svc: Awaited<ReturnType<CoolifyClient['listServices']>>[number],
    child: CoolifyServiceApplication,
    composePlatform: string | null,
    excluded: boolean,
    now: number,
    result: SyncResult,
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
    let parsed: ReturnType<typeof normalizeReference> | null = null;
    try {
      parsed = image == null ? null : normalizeReference(image);
    } catch {
      parsed = null; // unparseable image: keep row, surface as needs-attention
    }

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
          excludedInfra: excluded || parsed == null,
          isStopped: stopped,
          // First discovery is never an external change; unparseable images
          // surface via track==null views instead of external_change.
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

    // Existing child: detect external image changes against the track's expectations.
    const track = await this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, existing.id))
      .get();
    const matchesExpectation = this.imageMatchesTrack(track, parsed);
    const revertToTag = track?.configuredDigest != null && parsed != null && parsed.digest == null;
    const externalChange =
      existing.lastSyncedAt != null &&
      !matchesExpectation &&
      (existing.configFingerprint !== fingerprint || revertToTag);

    if (externalChange) result.externalChanges += 1;

    await this.db
      .update(resources)
      .set({
        name: child.human_name ?? child.name ?? existing.name,
        projectUuid: parent.projectUuid ?? existing.projectUuid,
        environmentUuid: parent.environmentUuid ?? existing.environmentUuid,
        serverName: parent.serverName,
        domains: child.fqdn,
        currentImage: image,
        configFingerprint: fingerprint,
        excludedInfra: excluded || parsed == null,
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
      .where(eq(resources.id, existing.id));

    if (parsed != null && track == null) {
      const fallback = this.resolveServerPlatform(parent.serverUuid);
      await this.ensureTrack(
        { id: existing.id } as ResourceRow,
        parsed,
        composePlatform ?? fallback.platform,
        composePlatform != null ? 'compose' : fallback.source,
        image,
        now,
      );
    } else if (parsed != null && track != null && !externalChange) {
      // Refresh configured reference/digest from live Coolify values.
      // On external change the prior target is preserved for re-confirmation.
      await this.db
        .update(imageTracks)
        .set({
          configuredReference: image,
          configuredDigest: parsed.digest,
          configuredReferenceKind: null,
          updatedAt: now,
        })
        .where(eq(imageTracks.id, track.id));
    }
  }

  /**
   * Plan §3 rule 5: a live image matches the track's expectation when it is the
   * pinned digest, or — for never-pinned tracks — the tracked tag. Once pinned,
   * a revert to the plain tag is an external change even when the tag matches.
   */
  private imageMatchesTrack(
    track: typeof imageTracks.$inferSelect | undefined,
    parsed: ReturnType<typeof normalizeReference> | null,
  ): boolean {
    if (track == null || parsed == null) return true;
    if (parsed.registry !== track.sourceRegistry || parsed.repository !== track.sourceRepository) {
      return false;
    }
    if (parsed.digest != null) {
      return parsed.digest === track.configuredDigest;
    }
    // Pure-tag reference: only acceptable while the track was never pinned.
    if (track.configuredDigest != null) return false;
    return track.sourceTag === '' || parsed.tag === track.sourceTag;
  }

  private async upsertApplication(
    app: AppLike,
    excluded: boolean,
    now: number,
    result: SyncResult,
  ): Promise<void> {
    const existing = await this.db
      .select()
      .from(resources)
      .where(and(eq(resources.kind, 'application'), eq(resources.coolifyUuid, app.uuid)))
      .get();

    let parsed: ReturnType<typeof normalizeReference> | null = null;
    try {
      parsed = app.image == null ? null : normalizeReference(app.image);
    } catch {
      parsed = null;
    }

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
          excludedInfra: excluded || parsed == null,
          isStopped: app.stopped,
          // First discovery is never an external change; unparseable images
          // surface via track==null views instead of external_change.
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

    const track = await this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, existing.id))
      .get();
    const matchesExpectation = this.imageMatchesTrack(track, parsed);
    // A pinned track reverting to a plain tag is an external change even when
    // the resulting fingerprint equals the discovery-time state (same tag).
    const revertToTag = track?.configuredDigest != null && parsed != null && parsed.digest == null;

    const externalChange =
      existing.lastSyncedAt != null &&
      !matchesExpectation &&
      (existing.configFingerprint !== app.fingerprint || revertToTag);
    if (externalChange) result.externalChanges += 1;

    await this.db
      .update(resources)
      .set({
        name: app.name ?? existing.name,
        projectUuid: app.projectUuid ?? existing.projectUuid,
        environmentUuid: app.environmentUuid ?? existing.environmentUuid,
        serverName: this.serverNameFor(app.serverUuid, existing.serverName),
        domains: app.domains,
        currentImage: app.image,
        configFingerprint: app.fingerprint,
        excludedInfra: excluded || parsed == null,
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
      .where(eq(resources.id, existing.id));

    if (parsed != null && track == null) {
      await this.ensureTrack(
        { id: existing.id } as ResourceRow,
        parsed,
        this.resolveServerPlatform(app.serverUuid).platform,
        this.resolveServerPlatform(app.serverUuid).source,
        app.image,
        now,
      );
    } else if (parsed != null && track != null && !externalChange) {
      // On external change the prior pinned digest is preserved for re-confirmation.
      await this.db
        .update(imageTracks)
        .set({ configuredReference: app.image, configuredDigest: parsed.digest, updatedAt: now })
        .where(eq(imageTracks.id, track.id));
    }
  }

  /** First sight of a resource: create its track from the current Coolify config. */
  private async ensureTrack(
    resource: Pick<ResourceRow, 'id'>,
    parsed: ReturnType<typeof normalizeReference>,
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
