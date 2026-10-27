// Update job lifecycle service. Jobs are the only path that mutates Coolify targets.

import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { ApiRequestError, errorCodes } from '../../../shared/errors.js';
import { digestSchema } from '../../../shared/schemas.js';
import type { SuccessSource } from '../../../shared/types.js';
import type { Db } from '../../db/client.js';
import { RETENTION_MAX_ROWS } from '../../db/retention.js';
import type { ImageTrackRow, ResourceRow, UpdateJobRow } from '../../db/schema.js';
import { imageTracks, resources, settings, updateJobs } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import { isAwaitingConfirmation } from '../dto.js';
import { effectiveManagementGate } from '../inventory/management-state.js';
import { parentRowOf } from '../inventory/parent-row.js';
import { applicationDigestReference, composeDigestReference } from './image-state.js';

const ACTIVE_STATUSES = ['pending', 'running'] as const;
/** Upper bound on expired tokens pruned per issuance (F18). */
const MAX_TOKEN_PRUNE_EXPIRED = 50;

/** Current token shape: purpose + channel revision bound. */
export interface PreviewRecord {
  resourceId: number;
  digest: string;
  createdAt: number;
  expiresAt: number;
  purpose: 'update' | 'adopt';
  trackingRevision: number;
  /** Full candidate reference the preview showed (update tokens). */
  candidateReference?: string;
}

export const PREVIEW_TTL_MS = 10 * 60_000;

export class JobsService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsRepo,
  ) {}

  // --- preview tokens -------------------------------------------------------

  /**
   * Bounded expired-token cleanup (F18): scans only `meta.preview.*` /
   * `meta.adopt.*` keys, removes at most MAX_TOKEN_PRUNE_EXPIRED per issue.
   * Both namespaces share one helper so stale metadata never accumulates.
   */
  pruneExpiredPreviewTokens(): void {
    const rows = this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        or(sql`${settings.key} LIKE 'meta.preview.%'`, sql`${settings.key} LIKE 'meta.adopt.%'`),
      )
      .all();
    const nowMs = Date.now();
    let removed = 0;
    for (const row of rows) {
      const rec = row.value as { expiresAt?: unknown } | null;
      if (rec == null || typeof rec !== 'object') continue;
      if (typeof rec.expiresAt === 'number' && rec.expiresAt < nowMs) {
        this.db.delete(settings).where(eq(settings.key, row.key)).run();
        removed += 1;
        if (removed >= MAX_TOKEN_PRUNE_EXPIRED) break;
      }
    }
  }

  /**
   * Issue an update-flow preview token bound to the resource's current channel
   * revision. `revision` comes from the caller's track row; the token dies when
   * the channel changes (source/platform edits, adopt, reset).
   */
  issuePreviewToken(
    resourceId: number,
    digest: string,
    revision: number,
    candidateReference?: string,
  ): string {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    this.settings.setMeta(`preview.${token}`, {
      resourceId,
      digest,
      createdAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
      purpose: 'update',
      trackingRevision: revision,
      ...(candidateReference != null ? { candidateReference } : {}),
    } satisfies PreviewRecord);
    this.pruneExpiredPreviewTokens();
    return token;
  }

  /**
   * Verify an update token without consuming it. Purpose must be `update`, the
   * revision must equal the live track revision and the digest must match.
   * Throws 409 on any mismatch (expired, re-preview needed).
   */
  requireUpdateToken(
    token: string,
    resourceId: number,
    digest: string,
    revision: number,
    candidateReference?: string,
  ): PreviewRecord {
    const rec = this.readToken(token);
    if (
      rec == null ||
      rec.purpose !== 'update' ||
      rec.resourceId !== resourceId ||
      rec.digest !== digest ||
      rec.trackingRevision !== revision ||
      rec.expiresAt < Date.now()
    ) {
      throw new ApiRequestError(
        errorCodes.conflict,
        'Preview expired or outdated; re-run the preview',
        409,
      );
    }
    // R5-F6: the token binds the FULL candidate reference the user saw; a
    // submit whose reference diverges from the preview is rejected. Tokens
    // issued before this field existed carry no reference and stay valid for
    // digest-only comparison (upgrade compatibility).
    if (
      candidateReference != null &&
      rec.candidateReference != null &&
      rec.candidateReference !== candidateReference
    ) {
      throw new ApiRequestError(
        errorCodes.conflict,
        'Candidate reference differs from the previewed target; re-run the preview',
        409,
      );
    }
    return rec;
  }

  private readToken(token: string): PreviewRecord | null {
    const rec = this.settings.getMeta<PreviewRecord>(`preview.${token}`);
    if (rec == null) return null;
    // Legacy pre-revision tokens can never satisfy the new guards.
    if ((rec as { purpose?: string }).purpose == null) return null;
    return rec;
  }

  /** Legacy-shape verify used by createManualJob's old signature. */
  consumePreviewToken(token: string, resourceId: number, digest: string): void {
    const rec = this.readToken(token);
    if (
      rec == null ||
      rec.purpose !== 'update' ||
      rec.resourceId !== resourceId ||
      rec.digest !== digest ||
      rec.expiresAt < Date.now()
    ) {
      throw new ApiRequestError(
        errorCodes.conflict,
        'Preview expired or mismatched; re-run the preview',
        409,
      );
    }
  }

  /** Delete a token record inside the caller's transaction (single-use). */
  deletePreviewToken(token: string): void {
    const row = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, `meta.preview.${token}`))
      .get();
    if (row != null) {
      this.db
        .delete(settings)
        .where(eq(settings.key, `meta.preview.${token}`))
        .run();
    }
  }

  // --- guards ----------------------------------------------------------------

  /** Non-terminal or evidence-blocked jobs for a resource. */
  blockingJob(resourceId: number, candidateDigest?: string): UpdateJobRow | null {
    const rows = this.db
      .select()
      .from(updateJobs)
      .where(eq(updateJobs.resourceId, resourceId))
      .orderBy(desc(updateJobs.id))
      .all();
    const track = this.db
      .select({ rev: imageTracks.trackingRevision })
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, resourceId))
      .get();
    const revision = track?.rev ?? null;
    return (
      rows.find(
        (j) =>
          // ACTIVE_STATUSES (pending/running) already covers running+awaiting.
          (ACTIVE_STATUSES as readonly string[]).includes(j.status) ||
          // unknown_submit blocks the whole resource regardless of candidate:
          // the submit result is unknown for the resource's Coolify config.
          j.status === 'unknown_submit' ||
          // Terminal same-candidate failures block only within the CURRENT
          // revision; old-revision conflicts must never block new work (F10).
          (candidateDigest != null &&
            revision != null &&
            j.trackingRevision === revision &&
            j.candidateDigest === candidateDigest &&
            ['failed', 'conflict', 'blocked'].includes(j.status)),
      ) ?? null
    );
  }

  private loadPair(resourceId: number): { resource: ResourceRow; track: ImageTrackRow | null } {
    const resource = this.db.select().from(resources).where(eq(resources.id, resourceId)).get();
    if (resource == null) throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
    const track =
      this.db.select().from(imageTracks).where(eq(imageTracks.resourceId, resourceId)).get() ??
      null;
    return { resource, track };
  }

  private assertUpdatable(resource: ResourceRow, track: ImageTrackRow | null): void {
    if (resource.kind === 'compose_service') {
      throw new ApiRequestError(errorCodes.validation, 'Parent services carry no image', 400);
    }
    if (resource.status !== 'active') {
      throw new ApiRequestError(errorCodes.blocked, 'Resource is not active', 409);
    }
    // 统一资格：分类待确认 → 配置排除（含父级继承） → 镜像问题，全部 409。
    const gate = effectiveManagementGate(
      resource,
      parentRowOf(this.db, resource),
      resource.currentImage,
    );
    if (!gate.ok) {
      throw new ApiRequestError(errorCodes.blocked, gate.reason, 409);
    }
    if (track == null) {
      throw new ApiRequestError(errorCodes.blocked, 'No image track for this resource', 409);
    }
    if (track.sourceTag === '') {
      throw new ApiRequestError(errorCodes.blocked, 'Tracking tag must be configured first', 409);
    }
  }

  // --- job creation ----------------------------------------------------------

  createManualJob(resourceId: number, candidateDigest: string, previewToken: string): UpdateJobRow {
    const digest = digestSchema.parse(candidateDigest);
    const { resource, track } = this.loadPair(resourceId);
    this.assertUpdatable(resource, track);
    if (track == null) throw new ApiRequestError(errorCodes.blocked, 'No image track', 409);
    if (resource.policy === 'ignore') {
      throw new ApiRequestError(
        errorCodes.policyForbidden,
        'Resource is ignored; set a policy first',
        403,
      );
    }
    // Verify inside the creation transaction, then consume: a crashed submit
    // keeps the token (transaction rolled back), a committed one deletes it.
    return this.db.transaction((tx) => {
      const expectedReference =
        resource.kind === 'service_application'
          ? composeDigestReference(track.sourceRepositoryAuthored, digest)
          : applicationDigestReference(track.sourceRegistry, track.sourceRepository, digest);
      this.requireUpdateToken(
        previewToken,
        resourceId,
        digest,
        track.trackingRevision,
        expectedReference,
      );
      const existing = this.blockingJob(resourceId, digest);
      if (existing != null) {
        // Strictly active statuses only: legacy terminal rows with a stale
        // awaiting_confirmation stage must fall through to the normal rules
        // instead of blocking the resource forever as "in flight".
        if (['pending', 'running'].includes(existing.status)) {
          throw new ApiRequestError(
            errorCodes.conflict,
            'An update task is already in flight',
            409,
          );
        }
        if (existing.candidateDigest === digest && existing.status === 'unknown_submit') {
          throw new ApiRequestError(
            errorCodes.blocked,
            'Submit result unknown; reconcile or confirm before re-submission',
            409,
          );
        }
      }
      this.assertNoBlockingJob(resourceId, digest);
      this.assertExclusiveScope(resource);
      const job = this.insertJobWith(
        tx,
        resourceId,
        digest,
        track,
        resource,
        'manual',
        (track?.configuredDigest ?? null) == null,
      );
      tx.delete(settings)
        .where(eq(settings.key, `meta.preview.${previewToken}`))
        .run();
      return job;
    });
  }

  /**
   * Exclusive scope for management actions (F3): pending/running/
   * unknown_submit jobs on the resource or a same-parent sibling block the
   * action. `exceptJobId` lets retry exclude the job being retried.
   */
  assertExclusiveScope(resource: ResourceRow, exceptJobId?: number): void {
    const scopeIds =
      resource.parentId != null
        ? this.db
            .select({ id: resources.id })
            .from(resources)
            .where(or(eq(resources.id, resource.id), eq(resources.parentId, resource.parentId)))
            .all()
            .map((r) => r.id)
        : [resource.id];
    const flying = this.db
      .select({ id: updateJobs.id, status: updateJobs.status })
      .from(updateJobs)
      .where(
        and(
          inArray(updateJobs.status, ['pending', 'running', 'unknown_submit']),
          inArray(updateJobs.resourceId, scopeIds),
        ),
      )
      .all()
      .find((j) => j.id !== exceptJobId);
    if (flying != null) {
      throw new ApiRequestError(
        errorCodes.conflict,
        flying.status === 'unknown_submit'
          ? '提交结果未知的任务待对账（含同父服务子容器）；先对账后再执行该操作'
          : '存在在途更新任务（含同父服务子容器）；等待结束后再执行该操作',
        409,
        { jobId: flying.id },
      );
    }
  }

  /** Blocking-job rules shared by the token path and the adopt-in-tx path. */
  private assertNoBlockingJob(resourceId: number, digest: string): void {
    const existing = this.blockingJob(resourceId, digest);
    if (existing != null) {
      // Strictly active statuses only: legacy terminal rows with a stale
      // awaiting_confirmation stage must fall through to the normal rules
      // instead of blocking the resource forever as "in flight".
      if (['pending', 'running'].includes(existing.status)) {
        throw new ApiRequestError(errorCodes.conflict, 'An update task is already in flight', 409);
      }
      if (existing.candidateDigest === digest && existing.status === 'unknown_submit') {
        throw new ApiRequestError(
          errorCodes.blocked,
          'Submit result unknown; reconcile or confirm before re-submission',
          409,
        );
      }
    }
  }

  /**
   * Create the adopt task INSIDE the caller's transaction (F4): the channel
   * flip, baseline write, token consumption and job insert commit or roll
   * back together. The adopt token was already consumed in the same tx; the
   * revision argument must equal the post-adopt value.
   */
  createManualJobInTx(
    tx: Pick<Db, 'select' | 'insert'>,
    resourceId: number,
    candidateDigest: string,
    postAdoptRevision: number,
  ): UpdateJobRow {
    const digest = digestSchema.parse(candidateDigest);
    const resource = this.db.select().from(resources).where(eq(resources.id, resourceId)).get();
    if (resource == null) {
      throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
    }
    const track = this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, resourceId))
      .get();
    if (track == null) throw new ApiRequestError(errorCodes.blocked, 'No image track', 409);
    if (track.trackingRevision !== postAdoptRevision) {
      throw new ApiRequestError(errorCodes.conflict, '追踪配置已变化；请重新预览', 409);
    }
    this.assertNoBlockingJob(resourceId, digest);
    return this.insertJobWith(
      tx,
      resourceId,
      digest,
      track,
      resource,
      'manual',
      track.configuredDigest == null,
    );
  }

  createAutoJob(resourceId: number, candidateDigest: string): UpdateJobRow | null {
    const digest = digestSchema.parse(candidateDigest);
    const { resource, track } = this.loadPair(resourceId);
    this.assertUpdatable(resource, track);
    if (track == null) return null; // assertUpdatable throws first; narrows for TS
    if (resource.policy !== 'auto') return null;
    // 候选路径仅在已接管时可达，这里恒为普通更新任务。
    return this.createGuardedJob(resourceId, digest, track, resource, 'auto', false);
  }

  /**
   * 首次初始化（固定摘要）：所有非 ignore 策略在检查时未接管即建任务，
   * 定时扫描与手动检查一致；守卫与自动更新相同。返回 null 表示被守卫跳过。
   */
  createInitialPinJob(
    resourceId: number,
    observedDigest: string,
    trigger: 'manual' | 'auto',
  ): UpdateJobRow | null {
    const digest = digestSchema.parse(observedDigest);
    const { resource, track } = this.loadPair(resourceId);
    this.assertUpdatable(resource, track);
    if (track == null) return null; // assertUpdatable throws first; narrows for TS
    if (resource.policy === 'ignore') return null;
    if (track.configuredDigest != null) return null; // 已接管：走候选更新路径
    return this.createGuardedJob(resourceId, digest, track, resource, trigger, true);
  }

  /** 自动路径共用的守卫与落库；被守卫挡下时静默返回 null。 */
  private createGuardedJob(
    resourceId: number,
    digest: string,
    track: ImageTrackRow,
    resource: ResourceRow,
    trigger: 'manual' | 'auto',
    isInitialPin: boolean,
  ): UpdateJobRow | null {
    if (this.settings.get().globalPaused) return null;
    if (resource.isStopped) return null;
    if (resource.blockedReason != null) return null;
    if (this.blockingJob(resourceId, digest) != null) return null;
    // R5-F2: the auto path obeys the same exclusive scope as the manual path —
    // a sibling's unknown_submit blocks new work for the whole parent group.
    try {
      this.assertExclusiveScope(resource);
    } catch {
      return null; // guarded path stays silent (plan: guarded = no job)
    }
    return this.insertJobWith(this.db, resourceId, digest, track, resource, trigger, isInitialPin);
  }

  /** Transaction-parameterized insert so token consumption stays atomic. */
  private insertJobWith(
    exec: Pick<Db, 'select' | 'insert'>,
    resourceId: number,
    digest: string,
    track: ImageTrackRow,
    resource: ResourceRow,
    trigger: 'manual' | 'auto',
    initialPin: boolean,
  ): UpdateJobRow {
    // Shared constructor (F3): application references carry the registry host;
    // compose children use the authored path + @sha256 form.
    const candidateReference =
      resource.kind === 'service_application'
        ? composeDigestReference(track.sourceRepositoryAuthored, digest)
        : applicationDigestReference(track.sourceRegistry, track.sourceRepository, digest);
    const now = Date.now();
    const seq = exec
      .select({ id: updateJobs.id })
      .from(updateJobs)
      .where(and(eq(updateJobs.resourceId, resourceId), eq(updateJobs.candidateDigest, digest)))
      .all().length;
    const job = exec
      .insert(updateJobs)
      .values({
        resourceId,
        kind: initialPin ? 'initial_pin' : 'update',
        trigger,
        candidateDigest: digest,
        candidateReference,
        priorDigest: track.configuredDigest,
        priorReference: track.configuredReference,
        expectedFingerprint: resource.configFingerprint,
        status: 'pending',
        stage: 'queued',
        attempts: 0,
        trackingRevision: track.trackingRevision,
        log: [{ at: new Date(now).toISOString(), stage: 'queued', message: '任务已创建' }],
        idempotencyKey: `${trigger}:${resourceId}:${digest}:${seq}`,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: updateJobs.idempotencyKey })
      .returning()
      .get();
    if (job == null) {
      throw new ApiRequestError(errorCodes.conflict, 'Identical job already exists', 409);
    }
    this.db.run(sql`
      DELETE FROM update_jobs
      WHERE status IN ('success', 'failed', 'conflict', 'unknown_submit', 'blocked')
        AND id NOT IN (SELECT id FROM update_jobs ORDER BY id DESC LIMIT ${RETENTION_MAX_ROWS})
    `);
    return job;
  }

  // --- retry / confirm ---------------------------------------------------------

  retryJob(jobId: number): UpdateJobRow {
    const job = this.get(jobId);
    if (!['failed', 'conflict', 'blocked'].includes(job.status)) {
      throw new ApiRequestError(
        errorCodes.blocked,
        'Only failed, conflicting or blocked tasks can be retried; unknown submits must be reconciled or confirmed first',
        409,
      );
    }
    // 重试即新管理动作：当前资格不满足（待确认/排除/镜像问题/父级继承受限）
    // 时拒绝，原任务保持原值。
    const resource = this.db.select().from(resources).where(eq(resources.id, job.resourceId)).get();
    if (resource == null) {
      throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
    }
    const gate = effectiveManagementGate(
      resource,
      parentRowOf(this.db, resource),
      resource.currentImage,
    );
    if (!gate.ok) {
      throw new ApiRequestError(errorCodes.blocked, gate.reason, 409);
    }
    // 历史任务重试同样复核版本与策略：渠道已变化（采纳/保存/重置）或 ignore
    // 时拒绝，原任务保留历史，用户从当前渠道重新预览。
    const track = this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, job.resourceId))
      .get();
    if (track != null && job.trackingRevision !== track.trackingRevision) {
      throw new ApiRequestError(
        errorCodes.conflict,
        '追踪配置已变化；旧任务不能重试，请从当前渠道重新预览',
        409,
      );
    }
    if (resource.policy === 'ignore') {
      throw new ApiRequestError(
        errorCodes.policyForbidden,
        '资源处于忽略策略；先选择管理策略再重试任务',
        403,
      );
    }
    // F3/F10: retry obeys the same exclusive scope as creation — pending/
    // running/unknown_submit on the resource OR a same-parent sibling.
    this.assertExclusiveScope(resource, job.id);
    const now = Date.now();
    const updated = this.db
      .update(updateJobs)
      .set({
        status: 'pending',
        stage: 'queued',
        // A retry is a fresh deployment attempt; never resume a failed one.
        deploymentUuid: null,
        // A retry re-opens the whole wait window; a stale due time must not fire.
        confirmationDueAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
        log: [
          ...job.log,
          { at: new Date(now).toISOString(), stage: 'queued', message: '用户触发同目标重试' },
        ],
      })
      .where(eq(updateJobs.id, jobId))
      .returning()
      .get();
    return updated ?? job;
  }

  confirmSubmission(jobId: number, digest: string): UpdateJobRow {
    const job = this.get(jobId);
    if (!isAwaitingConfirmation(job)) {
      throw new ApiRequestError(errorCodes.blocked, 'Task is not awaiting confirmation', 409);
    }
    if (digest !== job.candidateDigest) {
      throw new ApiRequestError(
        errorCodes.conflict,
        'Confirmed digest differs from the submitted candidate',
        409,
      );
    }
    const now = Date.now();
    // Expected-state conditional update: a concurrent auto-check, retry or
    // source edit must win over a stale confirmation request.
    const updated = this.db
      .update(updateJobs)
      .set({
        status: 'success',
        stage: 'done',
        confirmedManually: true,
        // Cancels the pending delayed auto-check for this job.
        confirmationDueAt: null,
        finishedAt: now,
        updatedAt: now,
        log: [
          ...job.log,
          { at: new Date(now).toISOString(), stage: 'done', message: '人工确认提交结果' },
        ],
      })
      .where(
        and(
          eq(updateJobs.id, jobId),
          eq(updateJobs.status, 'running'),
          eq(updateJobs.stage, 'awaiting_confirmation'),
          eq(updateJobs.candidateDigest, job.candidateDigest),
        ),
      )
      .returning()
      .get();
    if (updated == null) {
      throw new ApiRequestError(
        errorCodes.conflict,
        'Task state changed during confirmation; refresh and review',
        409,
      );
    }
    this.advanceTrackOnSuccess(job, 'manual', null);
    this.db
      .update(resources)
      .set({ blockedReason: null, updatedAt: now })
      .where(eq(resources.id, job.resourceId))
      .run();
    return updated;
  }

  /** Advance success evidence. source=manual records human attestation only. */
  advanceTrackOnSuccess(
    job: UpdateJobRow,
    source: SuccessSource,
    deploymentUuid: string | null,
  ): void {
    const now = Date.now();
    const track = this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, job.resourceId))
      .get();
    if (track == null) return;
    this.db
      .update(imageTracks)
      .set({
        configuredDigest: job.candidateDigest,
        configuredReference: job.candidateReference,
        lastSuccessfulDigest: job.candidateDigest,
        lastSuccessAt: now,
        lastSuccessDeploymentUuid: deploymentUuid ?? track.lastSuccessDeploymentUuid,
        lastSuccessSource: source,
        pinnedAt: track.pinnedAt ?? now,
        updatedAt: now,
      })
      .where(eq(imageTracks.id, track.id))
      .run();
  }

  get(jobId: number): UpdateJobRow {
    const job = this.db.select().from(updateJobs).where(eq(updateJobs.id, jobId)).get();
    if (job == null) throw new ApiRequestError(errorCodes.notFound, 'Job not found', 404);
    return job;
  }

  listByStatus(statuses: string[]): UpdateJobRow[] {
    if (statuses.length === 0) {
      return this.db.select().from(updateJobs).orderBy(desc(updateJobs.id)).limit(200).all();
    }
    return this.db
      .select()
      .from(updateJobs)
      .where(inArray(updateJobs.status, statuses as UpdateJobRow['status'][]))
      .orderBy(desc(updateJobs.id))
      .limit(200)
      .all();
  }
}
