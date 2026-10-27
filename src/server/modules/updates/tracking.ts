// Tracking recovery service: adopt the live Coolify image as the new managed
// channel, recover a source save from external_change, and the local
// reset-to-ignore fallback (plan §1/§3/§4).
//
// Boundaries (hard constraints):
//  - This service never writes Coolify image fields; the only Coolify writes
//    stay in Jobs/Executor. Adopt only flips local tracking state and enqueues
//    a normal manual task; the executor deploys it.
//  - Network requests happen OUTSIDE database transactions; the final short
//    transaction re-validates revision/eligibility/in-flight jobs atomically.

import { and, eq, inArray, or } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import { ApiRequestError, errorCodes } from '../../../shared/errors.js';
import { digestSchema } from '../../../shared/schemas.js';
import type {
  AdoptChannelSource,
  AdoptPreviewDTO,
  AdoptResultDTO,
  ResetTrackingDTO,
} from '../../../shared/types.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { ImageTrackRow, ResourceRow, UpdateJobRow } from '../../db/schema.js';
import { imageTracks, resources, settings, updateJobs } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import type { CoolifyClient } from '../../integrations/coolify/client.js';
import { applicationImageRef } from '../../integrations/coolify/mapper.js';
import {
  credentialsFor,
  RegistryFailure,
  resolveTagDigestCoalesced,
} from '../../integrations/registry/adapter.js';
import { type NormalizedRef, normalizeReference } from '../../integrations/registry/reference.js';
import { resourceToDTO } from '../dto.js';
import { classifyImage, effectiveManagementGate } from '../inventory/management-state.js';
import { parentRowOf } from '../inventory/parent-row.js';
import {
  applicationDigestReference,
  channelFromLive,
  composeDigestReference,
} from './image-state.js';
import type { JobsService } from './jobs.js';

const ACTIVE_JOB_STATUSES = ['pending', 'running'] as const;

/** Track revision preview record (separate key namespace from update previews). */
interface AdoptPreviewRecord {
  resourceId: number;
  purpose: 'adopt';
  createdAt: number;
  expiresAt: number;
  trackingRevision: number;
  liveReference: string;
  channel: {
    source: AdoptChannelSource;
    registry: string;
    repository: string;
    repositoryAuthored: string;
    tag: string;
  };
  platform: string | null;
  targetDigest: string;
  targetReference: string;
  referenceKind: 'index' | 'manifest';
}

export interface TrackingServiceDeps {
  db: Db;
  cfg: AppConfig;
  settings: SettingsRepo;
  coolify: CoolifyClient;
  jobs: JobsService;
  resolve?: typeof resolveTagDigestCoalesced;
}

/** Statues that must never overlap an adopt/reset state change. */
const SUBMIT_UNKNOWN = 'unknown_submit';

export class TrackingService {
  private readonly db: Db;
  private readonly cfg: AppConfig;
  private readonly settings: SettingsRepo;
  private readonly coolify: CoolifyClient;
  private readonly jobs: JobsService;
  private readonly resolve: typeof resolveTagDigestCoalesced;

  constructor(deps: TrackingServiceDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.settings = deps.settings;
    this.coolify = deps.coolify;
    this.jobs = deps.jobs;
    this.resolve = deps.resolve ?? resolveTagDigestCoalesced;
  }

  // --- shared qualification ---------------------------------------------------

  /** Strict ID/type/active/mirror checks shared by preview, confirm and reset. */
  private loadResource(id: number): ResourceRow {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiRequestError(errorCodes.validation, 'Invalid resource id', 400);
    }
    const resource = this.db.select().from(resources).where(eq(resources.id, id)).get();
    if (resource == null) {
      throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
    }
    if (resource.kind === 'compose_service') {
      throw new ApiRequestError(errorCodes.validation, 'Parent services carry no image', 400);
    }
    if (resource.status !== 'active') {
      throw new ApiRequestError(errorCodes.blocked, 'Resource is not active', 409);
    }
    return resource;
  }

  /** In-flight jobs (resource or same parent) and any unknown-submit candidate. */
  private assertNoConflictingJobs(resource: ResourceRow): void {
    const inFlight = this.db
      .select({
        id: updateJobs.id,
        status: updateJobs.status,
        candidateDigest: updateJobs.candidateDigest,
      })
      .from(updateJobs)
      .where(
        or(
          and(
            eq(updateJobs.resourceId, resource.id),
            inArray(updateJobs.status, [...ACTIVE_JOB_STATUSES]),
          ),
          and(eq(updateJobs.resourceId, resource.id), eq(updateJobs.status, SUBMIT_UNKNOWN)),
        ),
      )
      .all();
    const hit = inFlight[0];
    if (hit != null) {
      throw new ApiRequestError(
        errorCodes.conflict,
        hit.status === SUBMIT_UNKNOWN
          ? '提交结果未知的任务待对账；先在任务历史处理后再执行该操作'
          : '有正在执行的更新任务；等待其结束后再执行该操作',
        409,
        { jobId: hit.id },
      );
    }
    if (resource.parentId != null) {
      const children = this.db
        .select({ id: resources.id })
        .from(resources)
        .where(eq(resources.parentId, resource.parentId))
        .all();
      const siblingIds = children.map((c) => c.id).filter((cid) => cid !== resource.id);
      if (siblingIds.length > 0) {
        const siblingJobs = this.db
          .select({ id: updateJobs.id, status: updateJobs.status })
          .from(updateJobs)
          .where(
            and(
              inArray(updateJobs.resourceId, siblingIds),
              inArray(updateJobs.status, [...ACTIVE_JOB_STATUSES, SUBMIT_UNKNOWN]),
            ),
          )
          .all();
        const sib = siblingJobs[0];
        if (sib != null) {
          throw new ApiRequestError(
            errorCodes.conflict,
            '同一父服务下有在途/未知提交任务；先处理后再执行该操作',
            409,
            { jobId: sib.id },
          );
        }
      }
    }
  }

  /**
   * Management qualification for adopt-and-update: pending_sync/excluded/
   * image issues all block (same gate as updates). ignore/stopped/global
   * pause additionally block only the deploy-capable confirm.
   */
  private assertAdoptable(resource: ResourceRow, track: ImageTrackRow | null): void {
    const gate = effectiveManagementGate(
      resource,
      parentRowOf(this.db, resource),
      resource.currentImage,
    );
    if (!gate.ok) {
      throw new ApiRequestError(errorCodes.blocked, gate.reason, 409, { code: gate.code });
    }
    if (track == null) {
      throw new ApiRequestError(errorCodes.blocked, 'No image track for this resource', 409);
    }
    // F14: adopt-and-update deploys — the platform must be verifiable, same
    // as the checker/update path (no deployment without a target platform).
    if (track.targetPlatform == null || track.targetPlatform === '') {
      throw new ApiRequestError(
        errorCodes.blocked,
        '目标平台待配置；先在镜像追踪中设置平台，再采纳并更新',
        409,
      );
    }
    if (resource.policy === 'ignore') {
      throw new ApiRequestError(
        errorCodes.policyForbidden,
        '资源处于忽略策略；先选择管理策略，再采纳当前镜像',
        403,
      );
    }
    if (resource.isStopped) {
      throw new ApiRequestError(
        errorCodes.blocked,
        '资源已停止；先在 Coolify 启动后再采纳更新',
        409,
      );
    }
    if (this.settings.get().globalPaused) {
      throw new ApiRequestError(errorCodes.blocked, '全局暂停生效；恢复后再采纳并更新', 409);
    }
  }

  /** Local read of the live reference for applications (GET Coolify). */
  private async fetchApplicationRef(uuid: string): Promise<{ ref: string | null; raw: unknown }> {
    const app = await this.coolify.getApplication(uuid);
    return { ref: applicationImageRef(app), raw: app };
  }

  /** Local read of the live child reference for compose children. */
  private async fetchChildRef(
    parentUuid: string,
    childUuid: string,
  ): Promise<{ ref: string | null; rawCompose: string | null }> {
    const children = await this.coolify.listServiceApplications(parentUuid);
    const child = children.find((c) => c.uuid === childUuid);
    if (child == null) {
      throw new ApiRequestError(
        errorCodes.conflict,
        '目标子容器已从父服务中消失；请在 Coolify 核对后同步',
        409,
      );
    }
    let rawCompose: string | null = null;
    try {
      const svc = await this.coolify.getService(parentUuid);
      rawCompose = svc.docker_compose_raw ?? null;
    } catch {
      rawCompose = null;
    }
    return { ref: child.image ?? null, rawCompose };
  }

  /** Parse a live reference into a managed NormalizedRef or throw a clear 409. */
  private parseLiveRef(ref: string | null, where: string): NormalizedRef {
    if (ref == null || ref.trim() === '') {
      throw new ApiRequestError(
        errorCodes.blocked,
        `${where}镜像引用缺失；请在 Coolify 修复配置后同步`,
        409,
      );
    }
    const cls = classifyImage(ref);
    if (cls.parsed == null) {
      throw new ApiRequestError(
        errorCodes.blocked,
        `${where}镜像引用无法解析（${cls.issue}）；请在 Coolify 修复后重试`,
        409,
      );
    }
    return cls.parsed;
  }

  // --- adopt preview ------------------------------------------------------------

  /**
   * Read-only preview: fetch live config, resolve the channel (explicit tag
   * wins), resolve the current upstream digest for that channel and return the
   * full target plus a short-lived adopt token. Never mutates tracking state
   * and never calls checkResource (no side-effect job creation).
   */
  async adoptPreview(id: number, sourceTag: string | null): Promise<AdoptPreviewDTO> {
    const resource = this.loadResource(id);
    const track =
      this.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get() ?? null;
    this.assertAdoptable(resource, track);
    this.assertNoConflictingJobs(resource);

    // Live reads stay outside any transaction.
    const isChild = resource.kind === 'service_application';
    let liveRef: string | null;
    let rawCompose: string | null = null;
    if (isChild) {
      const parent =
        resource.parentId != null
          ? this.db.select().from(resources).where(eq(resources.id, resource.parentId)).get()
          : null;
      if (parent == null) {
        throw new ApiRequestError(errorCodes.blocked, '父服务行缺失；先同步一次', 409);
      }
      const got = await this.fetchChildRef(parent.coolifyUuid, resource.coolifyUuid);
      liveRef = got.ref;
      rawCompose = got.rawCompose;
    } else {
      liveRef = (await this.fetchApplicationRef(resource.coolifyUuid)).ref;
    }
    const live = this.parseLiveRef(liveRef, isChild ? '子容器' : '应用');

    // Raw-compose cross-check (F15): parse the YAML properly and compare
    // NORMALIZED references so quoting/registry-default forms don't false-posit.
    if (isChild && rawCompose != null && rawCompose.trim() !== '') {
      const nodeImage = composeNodeImage(rawCompose, resource.composeServiceName);
      if (nodeImage != null) {
        // R5-F5/R6-F2: compare NORMALIZED identity, never the raw string —
        // `nginx:latest` ≡ `docker.io/library/nginx:latest`. Digest state is
        // authoritative: same repository + both digests equal → equivalent
        // even when one side spells the tag (`repo:stable@sha256:A` vs
        // `repo@sha256:A`); both floating → compare tags; digest vs floating
        // stays a contradiction.
        let nodeParsed: NormalizedRef | null = null;
        try {
          nodeParsed = normalizeReference(nodeImage);
        } catch {
          nodeParsed = null;
        }
        const sameIdentity =
          nodeParsed != null &&
          nodeParsed.registry === live.registry &&
          nodeParsed.repository === live.repository;
        const sameState =
          nodeParsed != null &&
          (nodeParsed.digest != null || live.digest != null
            ? nodeParsed.digest === live.digest
            : nodeParsed.tag === live.tag);
        const same = sameIdentity && sameState;
        if (!same) {
          throw new ApiRequestError(
            errorCodes.conflict,
            `raw compose 中 services.${resource.composeServiceName ?? ''}.image（${nodeImage}）与子容器实时引用（${liveRef}）矛盾；请先在 Coolify 修复配置`,
            409,
          );
        }
      }
    }

    const previous =
      track != null
        ? {
            sourceRegistry: track.sourceRegistry,
            sourceRepository: track.sourceRepository,
            sourceTag: track.sourceTag,
          }
        : null;
    const channel = channelFromLive(live, previous, sourceTag);
    if (channel.tag == null) {
      // Digest-only live ref in a different repository (or no previous tag):
      // the user must supply the tag to track.
      throw new ApiRequestError(
        errorCodes.validation,
        '当前现场仅含摘要且无法确定追踪 tag；请在预览时填写要追踪的 tag',
        400,
      );
    }
    const channelSource: AdoptChannelSource = sourceTag != null ? 'user_tag' : 'live';

    // Resolve the current upstream digest for the new channel (no persistence).
    const platform = track?.targetPlatform ?? null;
    let resolved: Awaited<ReturnType<typeof resolveTagDigestCoalesced>>;
    try {
      resolved = await this.resolve(
        {
          registry: channel.registry,
          repository: channel.repository,
          tag: channel.tag,
          platform,
          credentials: credentialsFor(this.cfg, channel.registry),
        },
        'v1',
      );
    } catch (err) {
      if (err instanceof RegistryFailure) {
        throw new ApiRequestError(errorCodes.registryError, err.normalized.message, 502);
      }
      throw new ApiRequestError(
        errorCodes.registryError,
        err instanceof Error ? err.message : 'registry resolve failed',
        502,
      );
    }
    const digest = digestSchema.parse(resolved.digest);

    // Shared constructor (F3): application targets carry the registry host;
    // compose child targets use the authored path + @sha256 form. Identical to
    // the job's candidateReference and the token binding.
    const targetFull =
      isChild || track == null
        ? composeDigestReference(channel.repositoryAuthored, digest)
        : applicationDigestReference(channel.registry, channel.repository, digest);

    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const now = Date.now();
    const record: AdoptPreviewRecord = {
      resourceId: id,
      purpose: 'adopt',
      createdAt: now,
      expiresAt: now + ADOPT_TTL_MS,
      trackingRevision: track?.trackingRevision ?? 0,
      liveReference: (liveRef ?? '').trim(),
      channel: {
        source: channelSource,
        registry: channel.registry,
        repository: channel.repository,
        repositoryAuthored: channel.repositoryAuthored,
        tag: channel.tag,
      },
      platform,
      targetDigest: digest,
      targetReference: targetFull,
      referenceKind: resolved.referenceKind,
    };
    this.settings.setMeta(`adopt.${token}`, record);
    this.pruneExpiredAdoptTokens();

    return {
      liveReference: record.liveReference,
      configuredReference: track?.configuredReference ?? null,
      configuredDigest: track?.configuredDigest ?? null,
      channel: record.channel,
      targetReference: targetFull,
      targetDigest: digest,
      referenceKind: resolved.referenceKind,
      resolvedAt: new Date(resolved.observedAt).toISOString(),
      platform,
      impact: isChild
        ? {
            kind: 'compose_child',
            parentName: this.parentName(resource.parentId),
            note: '采纳后创建一条普通更新任务；子容器部署按既有确认机制执行',
          }
        : {
            kind: 'application',
            parentName: null,
            note: '采纳后创建一条普通更新任务，按既有执行器部署',
          },
      previewToken: token,
    };
  }

  // --- adopt confirm ---------------------------------------------------------------

  /**
   * Consume the adopt token, re-verify the live config still matches the
   * preview, then atomically: switch channel + baseline, clear stale
   * observations/evidence projections, consume the token and create one normal
   * manual update task. When the live digest already equals the target the
   * adopt skips task creation (`skipped`).
   */
  async adoptConfirm(id: number, previewToken: string): Promise<AdoptResultDTO> {
    const resource = this.loadResource(id);
    const rec = this.readAdoptToken(previewToken, id);
    const trackBefore = this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, id))
      .get();
    if (trackBefore == null) {
      throw new ApiRequestError(errorCodes.blocked, 'No image track for this resource', 409);
    }
    if (trackBefore.trackingRevision !== rec.trackingRevision) {
      throw new ApiRequestError(errorCodes.conflict, '追踪配置已变化；请重新预览后再采纳', 409);
    }
    this.assertAdoptable(resource, trackBefore);

    // Re-verify the live config still matches what the preview saw.
    const isChild = resource.kind === 'service_application';
    const liveNow = isChild
      ? (await this.fetchChildRef(this.parentUuidOrThrow(resource), resource.coolifyUuid)).ref
      : (await this.fetchApplicationRef(resource.coolifyUuid)).ref;
    if (liveNow?.trim() !== rec.liveReference) {
      throw new ApiRequestError(
        errorCodes.conflict,
        `Coolify 现场已在预览后变化（预览 ${rec.liveReference}，当前 ${liveNow ?? '空'}）；请重新预览`,
        409,
      );
    }

    // Shared qualification re-check before the short transaction.
    this.assertNoConflictingJobs(resource);

    const now = Date.now();
    const channel = rec.channel;
    const digest = rec.targetDigest;
    const live = this.parseLiveRef(liveNow, isChild ? '子容器' : '应用');
    // Baseline always records the CONFIRMED LIVE configuration (F2): digest
    // live → digest reference; float-tag live → tagged reference with digest
    // null. The preview's upstream candidate (digest) only feeds the
    // observation and the task — never the baseline.
    const liveDigestPinned = live.digest != null;
    const adoptTargetsLive = liveDigestPinned && live.digest === digest;
    const liveDigest = live.digest ?? '';
    // Baseline reference = the RAW live string (F6): Coolify applications may
    // carry `repo:tag@sha256:…` which cannot round-trip through the tag field;
    // recording the live string keeps prior comparable and honest.
    const baselineReference = liveNow?.trim() ?? null;

    // Network work is done; everything below is one short local transaction.
    const txJob = this.db.transaction((tx): UpdateJobRow | null => {
      // Re-read within the transaction: eligibility + in-flight + revision.
      const res = tx.select().from(resources).where(eq(resources.id, id)).get();
      if (res == null || res.status !== 'active') {
        throw new ApiRequestError(errorCodes.blocked, 'Resource is not active', 409);
      }
      const track = tx.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
      if (track == null || track.trackingRevision !== rec.trackingRevision) {
        throw new ApiRequestError(errorCodes.conflict, '追踪配置已变化；请重新预览', 409);
      }
      this.assertAdoptable(res, track);
      this.assertNoConflictingJobsTx(tx, res);

      // Token single-use: delete inside the same transaction.
      tx.delete(settings)
        .where(eq(settings.key, `meta.adopt.${previewToken}`))
        .run();

      const newRevision = track.trackingRevision + 1;
      tx.update(imageTracks)
        .set({
          sourceRegistry: channel.registry,
          sourceRepository: channel.repository,
          sourceRepositoryAuthored: channel.repositoryAuthored,
          sourceTag: channel.tag,
          trackSource: 'user',
          // Baseline = the confirmed live config (F2), never the candidate.
          configuredReference: baselineReference,
          configuredDigest: liveDigestPinned ? liveDigest : null,
          configuredReferenceKind: null,
          pinnedAt: null,
          trackingRevision: newRevision,
          // Fresh channel: old observations belong to the old stream; the
          // preview's own resolution seeds the new channel's observation.
          observedDigest: digest,
          observedAt: now,
          observedReferenceKind: rec.referenceKind,
          platformManifestDigest: null,
          observedError: null,
          upstreamTagUpdatedAt: null,
          // Config adoption is not deployment evidence.
          lastSuccessfulDigest: null,
          lastSuccessAt: null,
          lastSuccessDeploymentUuid: null,
          lastSuccessSource: null,
          updatedAt: now,
        })
        .where(eq(imageTracks.id, track.id))
        .run();

      // Clear resolved external_change; other blocks keep their own gates.
      // F19(C5): also refresh the live-config snapshot so the executor's
      // reads (currentImage) reflect the confirmed state immediately.
      tx.update(resources)
        .set({
          blockedReason: res.blockedReason === 'external_change' ? null : res.blockedReason,
          currentImage: baselineReference,
          updatedAt: now,
        })
        .where(eq(resources.id, id))
        .run();
      // Task creation inside the SAME transaction (F4): insert failure rolls
      // back the channel/baseline/token changes entirely. prior = the live
      // config just recorded as baseline (executor accepts it via shared check).
      if (adoptTargetsLive) return null;
      const job = this.jobs.createManualJobInTx(tx, id, digest, track.trackingRevision + 1);
      return job;
    });

    // Task result: skipped when live already equals the target.
    let jobDTO: AdoptResultDTO['job'] = null;
    let status: AdoptResultDTO['status'] = 'adopted';
    let message: string;
    if (txJob == null) {
      status = 'skipped';
      message =
        '已采纳当前镜像为新追踪渠道；现场摘要已与该渠道一致，无需部署。后续运行成功仍以独立部署证据为准。';
    } else {
      jobDTO = txJob as unknown as Record<string, unknown>;
      message = `已采纳 ${channel.registry}/${channel.repository}:${channel.tag} 为追踪渠道；已创建${liveDigestPinned ? '更新' : '初始化'}任务部署到预览摘要。`;
    }
    return {
      status,
      message,
      job: jobDTO,
      resource: this.resourceDTO(id),
    };
  }

  private assertNoConflictingJobsTx(_tx: Pick<Db, 'select'>, resource: ResourceRow): void {
    // Re-validation inside the adopt transaction. Root-handle reads are safe
    // here (node:sqlite serializes; no nested BEGIN), and no root WRITE may
    // appear inside any transaction body — enforced by tests/tmp audit and
    // review. Reuses the identical query shape as the pre-transaction check.
    this.assertNoConflictingJobs(resource);
  }

  // --- reset ---------------------------------------------------------------

  /**
   * Reset tracking and ignore: purely local — no Coolify calls, works while
   * Coolify is unreachable. Atomically: policy=ignore, ledger cleared, source
   * tag/repository/platform/cron kept, recoverable blocks cleared.
   */
  resetTracking(id: number): ResetTrackingDTO {
    const resource = this.loadResource(id);
    const track = this.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
    if (track == null) {
      throw new ApiRequestError(errorCodes.blocked, 'No image track for this resource', 409);
    }
    // Management classification still gates: unclassified/excluded rows have a
    // pending management state; image problems keep their diagnosis but allow
    // this shrinking local reset.
    if (!resource.managementClassified) {
      throw new ApiRequestError(
        errorCodes.blocked,
        '待同步确认：完成一次资源同步后再执行重置',
        409,
      );
    }
    if (resource.excludedInfra) {
      throw new ApiRequestError(errorCodes.blocked, '已排除的资源无需重置追踪', 409);
    }
    // F14: a classified+excluded parent blocks the child (inherited boundary),
    // mirroring effectiveManagementGate's parent rule.
    if (resource.parentId != null) {
      const parent = this.db
        .select()
        .from(resources)
        .where(eq(resources.id, resource.parentId))
        .get();
      if (parent?.managementClassified && parent.excludedInfra) {
        throw new ApiRequestError(
          errorCodes.blocked,
          '父服务已配置排除，子容器继承受限；无需重置追踪',
          409,
        );
      }
    }
    this.assertNoConflictingJobs(resource);

    const now = Date.now();
    this.db.transaction((tx) => {
      const res = tx.select().from(resources).where(eq(resources.id, id)).get();
      if (res == null) {
        throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
      }
      const tr = tx.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
      if (tr == null) {
        throw new ApiRequestError(errorCodes.blocked, 'No image track', 409);
      }
      tx.update(resources)
        .set({ policy: 'ignore', updatedAt: now })
        .where(eq(resources.id, id))
        .run();
      tx.update(imageTracks)
        .set({
          // Channel bookkeeping cleared; source/channel identifiers stay.
          configuredReference: null,
          configuredDigest: null,
          configuredReferenceKind: null,
          pinnedAt: null,
          trackingRevision: tr.trackingRevision + 1,
          observedDigest: null,
          observedAt: null,
          observedReferenceKind: null,
          platformManifestDigest: null,
          observedError: null,
          upstreamTagUpdatedAt: null,
          lastSuccessfulDigest: null,
          lastSuccessAt: null,
          lastSuccessDeploymentUuid: null,
          lastSuccessSource: null,
          updatedAt: now,
        })
        .where(eq(imageTracks.id, tr.id))
        .run();
      // Clear recoverable operational blocks; classification and image issues
      // remain authoritative diagnostics. external_change / update_failed are
      // resolved by this action; compose_confirmation_pending and stopped
      // cannot coexist (in-flight guard above) and are kept defensively.
      const nextBlocked =
        res.blockedReason === 'external_change' || res.blockedReason === 'update_failed'
          ? null
          : (res.blockedReason ?? null);
      tx.update(resources)
        .set({ blockedReason: nextBlocked, updatedAt: now })
        .where(eq(resources.id, id))
        .run();
    });
    return {
      resource: this.resourceDTO(id),
      message:
        '已重置追踪并忽略：后续检查与自动初始化暂停，Coolify 配置与任务历史保留；重新选择策略即可恢复管理。',
    };
  }

  // --- save-source recovery (used by the PATCH route) ------------------------------

  /**
   * Source save while external_change (F5): READ-ONLY live fetch for the PATCH
   * route. The caller validates everything first, then writes the recovered
   * baseline inside its own final transaction — this method never mutates
   * state. Returns null when the live fetch fails (caller rejects atomically).
   */
  async fetchExternalChangeLive(id: number): Promise<{
    configuredReference: string;
    configuredDigest: string | null;
    live: NormalizedRef;
  } | null> {
    const resource = this.loadResource(id);
    if (resource.kind === 'service_application') {
      const parent = this.parentUuidOrThrow(resource);
      const got = await this.fetchChildRef(parent, resource.coolifyUuid).catch(() => null);
      if (got == null) return null;
      const live = this.parseLiveRef(got.ref, '子容器');
      return {
        configuredReference: got.ref?.trim() ?? '',
        configuredDigest: live.digest,
        live,
      };
    }
    const got = await this.fetchApplicationRef(resource.coolifyUuid).catch(() => null);
    if (got == null) return null;
    const live = this.parseLiveRef(got.ref, '应用');
    return {
      configuredReference: got.ref?.trim() ?? '',
      configuredDigest: live.digest,
      live,
    };
  }

  // --- helpers ---------------------------------------------------------------

  private readAdoptToken(token: string, resourceId: number): AdoptPreviewRecord {
    const rec = this.settings.getMeta<AdoptPreviewRecord>(`adopt.${token}`);
    if (
      rec == null ||
      rec.purpose !== 'adopt' ||
      rec.resourceId !== resourceId ||
      rec.expiresAt < Date.now()
    ) {
      throw new ApiRequestError(errorCodes.conflict, '采纳预览已过期或不匹配；请重新预览', 409);
    }
    return rec;
  }

  /** Bounded cleanup of expired previews — delegates to the shared helper. */
  private pruneExpiredAdoptTokens(): void {
    this.jobs.pruneExpiredPreviewTokens();
  }

  private parentUuidOrThrow(resource: ResourceRow): string {
    if (resource.parentId == null) {
      throw new ApiRequestError(errorCodes.blocked, '父服务行缺失；先同步一次', 409);
    }
    const parent = this.db
      .select()
      .from(resources)
      .where(eq(resources.id, resource.parentId))
      .get();
    if (parent == null) {
      throw new ApiRequestError(errorCodes.blocked, '父服务行缺失；先同步一次', 409);
    }
    return parent.coolifyUuid;
  }

  private parentName(parentId: number | null): string | null {
    if (parentId == null) return null;
    const row = this.db
      .select({ name: resources.name })
      .from(resources)
      .where(eq(resources.id, parentId))
      .get();
    return row?.name ?? null;
  }

  /** Shared DTO mapping (F16): full ResourceDTO incl. track view/exclusions. */
  private resourceDTO(id: number) {
    const res = this.db.select().from(resources).where(eq(resources.id, id)).get();
    const track =
      this.db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get() ?? null;
    if (res == null) throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
    const parent =
      res.parentId != null
        ? (this.db.select().from(resources).where(eq(resources.id, res.parentId)).get() ?? null)
        : null;
    const dto = resourceToDTO(res, track, null, null, {
      excludedUuids: this.cfg.excludedUuids,
      parentExcluded: parent?.excludedInfra ?? null,
    });
    if (parent != null) {
      dto.parentName = parent.name;
      dto.parentCoolifyUuid = parent.coolifyUuid;
    }
    return dto;
  }
}

const ADOPT_TTL_MS = 10 * 60_000;

/**
 * Extract `services.<name>.image` from raw compose via real YAML parsing
 * (F15): quoted values, comments and registry-default forms are handled by
 * the parser; unreadable shapes return null and skip the cross-check.
 */
function composeNodeImage(raw: string, serviceName: string | null): string | null {
  if (serviceName == null || raw.trim() === '') return null;
  try {
    const doc = parseYaml(raw) as { services?: Record<string, { image?: unknown }> } | null;
    if (doc == null || typeof doc !== 'object' || doc.services == null) return null;
    const node = doc.services[serviceName];
    if (node == null || typeof node !== 'object') return null;
    const image = node.image;
    return typeof image === 'string' && image.trim() !== '' ? image.trim() : null;
  } catch {
    return null;
  }
}
