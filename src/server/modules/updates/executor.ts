// Update executor: the guarded state machine from intent to (un)confirmed result.
// Application: PATCH → readback → start(deployment uuid) → poll → health-agnostic success.
// Compose child: sibling-safe PATCH → raw-compose verification → targeted start →
// awaiting_confirmation (Coolify returns queued-only evidence in v4.3.23).
// Failure keeps the written target config, pauses auto updates and notifies.
// Rollback is explicitly out of scope (phase 1).

import { asc, eq } from 'drizzle-orm';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { ImageTrackRow, ResourceRow, UpdateJobRow } from '../../db/schema.js';
import { imageTracks, resources, updateJobs } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import type { CoolifyClient } from '../../integrations/coolify/client.js';
import { CoolifyApiError } from '../../integrations/coolify/client.js';
import { applicationImageRef, applicationTagField } from '../../integrations/coolify/mapper.js';
import { coolifyDigestTag, normalizeReference } from '../../integrations/registry/reference.js';
import type { Outbox } from '../notifications/outbox.js';
import type { JobsService } from './jobs.js';

const CONFIRM_WINDOW_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
type LogSink = (stage: UpdateJobRow['stage'], message: string) => void;

export interface ExecutorTiming {
  pollIntervalMs: number;
  confirmWindowMs: number;
}

const DEFAULT_TIMING: ExecutorTiming = {
  pollIntervalMs: POLL_INTERVAL_MS,
  confirmWindowMs: CONFIRM_WINDOW_MS,
};

export class UpdateExecutor {
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly coolify: CoolifyClient,
    private readonly jobs: JobsService,
    private readonly outbox: Outbox,
    private readonly settings: SettingsRepo,
    private readonly cfg: AppConfig,
    private readonly timing: ExecutorTiming = DEFAULT_TIMING,
  ) {}

  /** Mirror a written target into the local track (config state, never evidence). */
  private localUpdateTrack(
    resourceId: number,
    digest: string,
    reference: string,
    now: number,
  ): void {
    this.db
      .update(imageTracks)
      .set({ configuredDigest: digest, configuredReference: reference, updatedAt: now })
      .where(eq(imageTracks.resourceId, resourceId))
      .run();
  }

  // --- queue processing -------------------------------------------------------

  /**
   * Claims and processes pending jobs respecting global concurrency, per-resource
   * and per-parent exclusivity. Returns the number of jobs processed.
   */
  async processQueue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      for (;;) {
        if (this.settings.get().globalPaused) break;
        const job = this.claimNext();
        if (job == null) break;
        processed += 1;
        try {
          if (job.candidateDigest != null && job.resourceId != null) {
            await this.runJob(job);
          }
        } catch (err) {
          this.failJob(job, 'internal_error', err instanceof Error ? err.message : 'unknown error');
        }
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  /** Pick the next pending job whose resource/parent has no active job. */
  private claimNext(): UpdateJobRow | null {
    const pending = this.db
      .select()
      .from(updateJobs)
      .where(eq(updateJobs.status, 'pending'))
      .orderBy(asc(updateJobs.id))
      .limit(50)
      .all();
    const activeByResource = new Map<number, number>();
    const activeParents = new Set<number>();
    const running = this.db.select().from(updateJobs).where(eq(updateJobs.status, 'running')).all();
    // Awaiting-confirmation jobs hold their resource/parent exclusively but do
    // NOT consume global deployment concurrency (plan §5: scope is per-resource).
    const executing = running.filter((j) => j.stage !== 'awaiting_confirmation');
    for (const a of running) {
      activeByResource.set(a.resourceId, (activeByResource.get(a.resourceId) ?? 0) + 1);
      const res = this.db.select().from(resources).where(eq(resources.id, a.resourceId)).get();
      if (res?.parentId != null) activeParents.add(res.parentId);
    }
    const concurrency = this.cfg.deployConcurrency;
    if (executing.length >= concurrency) return null;
    for (const job of pending) {
      if ((activeByResource.get(job.resourceId) ?? 0) > 0) continue;
      const res = this.db.select().from(resources).where(eq(resources.id, job.resourceId)).get();
      if (res?.parentId != null && activeParents.has(res.parentId)) continue;
      const now = Date.now();
      this.db
        .update(updateJobs)
        .set({
          status: 'running',
          startedAt: job.startedAt ?? now,
          attempts: job.attempts + 1,
          updatedAt: now,
        })
        .where(eq(updateJobs.id, job.id))
        .run();
      return {
        ...job,
        status: 'running',
        startedAt: job.startedAt ?? now,
        attempts: job.attempts + 1,
      };
    }
    return null;
  }

  private logFor(job: UpdateJobRow): LogSink {
    return (stage, message) => {
      const current = this.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
      if (current == null) return;
      const log = [...current.log, { at: new Date().toISOString(), stage, message }];
      this.db
        .update(updateJobs)
        .set({ stage, log, updatedAt: Date.now() })
        .where(eq(updateJobs.id, job.id))
        .run();
    };
  }

  private setStage(job: UpdateJobRow, stage: UpdateJobRow['stage'], message?: string): void {
    const log = this.logFor(job);
    log(stage, message ?? `进入阶段 ${stage}`);
  }

  private finishJob(
    job: UpdateJobRow,
    status: UpdateJobRow['status'],
    errorCode: string | null,
    errorMessage: string | null,
  ): void {
    const current = this.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    if (current == null) return;
    const now = Date.now();
    this.db
      .update(updateJobs)
      .set({
        status,
        errorCode,
        errorMessage,
        stage: status === 'success' ? 'done' : current.stage,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(updateJobs.id, job.id))
      .run();
  }

  private failJob(job: UpdateJobRow, code: string, message: string): void {
    this.finishJob(job, 'failed', code, message);
    this.pauseWithNotification(job, code, message);
  }

  /** Failure policy: keep target config, pause auto, notify (no rollback). */
  private pauseWithNotification(job: UpdateJobRow, code: string, message: string): void {
    const now = Date.now();
    this.db
      .update(resources)
      .set({ blockedReason: 'update_failed', updatedAt: now })
      .where(eq(resources.id, job.resourceId))
      .run();
    this.outbox.enqueue({
      eventType: 'update_failed',
      resourceId: job.resourceId,
      dedupeKey: `update_failed:${job.id}`,
      payload: {
        title: '更新失败',
        body: `资源 #${job.resourceId} 更新到 ${short(job.candidateDigest)} 失败（${code}）：${message}。当前目标配置已保留，自动更新已暂停。`,
        type: 'failure',
      },
    });
  }

  // --- dispatch ---------------------------------------------------------------

  async runJob(job: UpdateJobRow): Promise<void> {
    const resource = this.db.select().from(resources).where(eq(resources.id, job.resourceId)).get();
    const track = this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, job.resourceId))
      .get();
    if (resource == null || track == null) {
      this.finishJob(job, 'blocked', 'resource_missing', 'Resource or track disappeared');
      return;
    }
    const log = this.logFor(job);
    log('revalidated', `开始执行 ${job.kind} 任务（attempt ${job.attempts}）`);
    switch (resource.kind) {
      case 'application':
        await this.runApplicationJob(job, resource, track);
        return;
      case 'service_application':
        await this.runComposeChildJob(job, resource, track);
        return;
      default:
        this.finishJob(job, 'blocked', 'unsupported_kind', 'Parent services carry no image');
    }
  }

  // --- application ------------------------------------------------------------

  private async runApplicationJob(
    job: UpdateJobRow,
    resource: ResourceRow,
    track: ImageTrackRow,
  ): Promise<void> {
    const log = this.logFor(job);
    const digestTag = coolifyDigestTag(job.candidateDigest);

    // 1. Fresh revalidation against Coolify (semantic expectation, not raw fingerprint).
    let app: Awaited<ReturnType<CoolifyClient['getApplication']>>;
    try {
      app = await this.coolify.getApplication(resource.coolifyUuid);
    } catch (err) {
      this.failJob(
        job,
        'coolify_unreachable',
        err instanceof Error ? err.message : 'GET application failed',
      );
      return;
    }
    // Tag field adapts to the app's storage form: pull-based apps use the
    // docker_registry_image_* pair, classic apps use docker_image/tag.
    const tagField = applicationTagField(app);
    const currentRef = applicationImageRef(app);
    let parsed: ReturnType<typeof normalizeReference> | null;
    try {
      parsed = currentRef == null ? null : normalizeReference(currentRef);
    } catch {
      parsed = null;
    }
    const expectTag = track.sourceTag === '' ? null : track.sourceTag;
    const alreadyCandidate = parsed?.digest === job.candidateDigest;
    const matchesPrior =
      parsed != null &&
      parsed.registry === track.sourceRegistry &&
      parsed.repository === track.sourceRepository &&
      (parsed.digest != null
        ? parsed.digest === (job.priorDigest ?? track.configuredDigest)
        : parsed.tag === expectTag);
    if (!alreadyCandidate && !matchesPrior) {
      this.db
        .update(resources)
        .set({ blockedReason: 'external_change', updatedAt: Date.now() })
        .where(eq(resources.id, resource.id))
        .run();
      this.finishJob(
        job,
        'conflict',
        'external_change',
        'Coolify image reference changed outside toolkit expectations',
      );
      return;
    }

    // 2. PATCH only the image tag field.
    if (!alreadyCandidate) {
      this.setStage(job, 'patching', `写入固定摘要 ${short(job.candidateDigest)}`);
      try {
        await this.coolify.patchApplication(resource.coolifyUuid, { [tagField]: digestTag });
      } catch (err) {
        if (err instanceof CoolifyApiError && err.statusCode == null) {
          log('patching', 'PATCH 超时；由回读判定实际状态');
        } else {
          this.failJob(job, 'patch_failed', err instanceof Error ? err.message : 'PATCH failed');
          return;
        }
      }
    }
    // 3. Readback confirmation (covers timeout recovery and crash resume).
    const readback = await this.safeGetApplication(resource.coolifyUuid);
    const readbackTag =
      readback == null
        ? null
        : tagField === 'docker_registry_image_tag'
          ? readback.docker_registry_image_tag
          : readback.docker_image_tag;
    if (readbackTag !== digestTag) {
      this.failJob(
        job,
        'readback_mismatch',
        'Readback shows a different tag than the written digest',
      );
      return;
    }
    this.setStage(job, 'patched', '目标配置已确认');
    // Target config is now B in Coolify; mirror it locally. Deployment evidence
    // advances independently (only with deployment proof).
    this.localUpdateTrack(job.resourceId, job.candidateDigest, job.candidateReference, Date.now());

    // 4. Submit deployment.
    let deploymentUuid: string | null = job.deploymentUuid;
    if (deploymentUuid == null) {
      try {
        const started = await this.coolify.startApplication(resource.coolifyUuid);
        deploymentUuid = started.deploymentUuid;
        if (deploymentUuid == null) {
          deploymentUuid = await this.associateDeploymentByTime(resource.coolifyUuid, Date.now());
          if (deploymentUuid == null) {
            this.markUnknownSubmit(job, 'start 响应未携带 deployment UUID 且历史无法唯一关联');
            return;
          }
        }
      } catch (err) {
        if (err instanceof CoolifyApiError && err.statusCode == null) {
          log('deploy_submitted', 'start 请求超时，进入对账');
          const associated = await this.associateDeploymentByTime(resource.coolifyUuid, Date.now());
          if (associated != null) {
            deploymentUuid = associated;
          } else {
            this.markUnknownSubmit(job, 'start 超时且无法唯一关联部署记录');
            return;
          }
        } else {
          this.failJob(job, 'start_failed', err instanceof Error ? err.message : 'start failed');
          return;
        }
      }
      this.db
        .update(updateJobs)
        .set({ deploymentUuid, stage: 'deploy_submitted', updatedAt: Date.now() })
        .where(eq(updateJobs.id, job.id))
        .run();
      log('deploy_submitted', `部署已提交 ${deploymentUuid}`);
    }

    // 5. Poll deployment to a terminal state.
    const confirmed = await this.pollDeployment(job, resource, deploymentUuid);
    if (!confirmed) return; // poller finalized the job

    // 6. Final readback: target config must still equal the candidate.
    const final = await this.safeGetApplication(resource.coolifyUuid);
    const finalTag =
      final == null
        ? null
        : tagField === 'docker_registry_image_tag'
          ? final.docker_registry_image_tag
          : final.docker_image_tag;
    if (finalTag !== digestTag) {
      this.failJob(job, 'post_deploy_config_drift', 'Config changed after deployment completion');
      return;
    }
    // 7. Deployment success == Coolify deployment finished + config still on
    // candidate. Container health is an ongoing runtime signal, tracked
    // separately — it never fails the deployment job; log it for visibility.
    const health = (final?.status ?? '').split(':')[1];
    if (health != null && health !== '') {
      log(
        'deploy_submitted',
        health === 'healthy'
          ? '容器健康检查已通过'
          : `容器健康状态：${health}（持续信号，不影响部署结果）`,
      );
    }

    this.jobs.advanceTrackOnSuccess(job, 'deployment', deploymentUuid);
    this.db
      .update(resources)
      .set({ currentImage: job.candidateReference, blockedReason: null, updatedAt: Date.now() })
      .where(eq(resources.id, resource.id))
      .run();
    this.finishJob(job, 'success', null, null);
    this.outbox.enqueue({
      eventType: 'update_success',
      resourceId: resource.id,
      dedupeKey: `update_success:${job.id}`,
      payload: {
        title: '更新完成',
        body: `资源 ${resource.name} 已更新并部署 ${short(job.candidateDigest)}（deployment ${deploymentUuid}）。`,
        type: 'success',
      },
    });
  }

  private async safeGetApplication(uuid: string) {
    try {
      return await this.coolify.getApplication(uuid);
    } catch {
      return null;
    }
  }

  /** Best-effort association of a deployment by recency when uuid is missing. */
  private async associateDeploymentByTime(
    appUuid: string,
    aroundMs: number,
  ): Promise<string | null> {
    try {
      const history = await this.coolify.getDeploymentsForApplication(appUuid);
      const windowMs = 3 * 60_000;
      const candidates = history.filter((d) => {
        const created = d.created_at != null ? Date.parse(d.created_at) : Number.NaN;
        return Number.isFinite(created) && Math.abs(created - aroundMs) <= windowMs;
      });
      // Unique recent deployment not already bound to another job.
      const bound = new Set(
        this.db
          .select({ du: updateJobs.deploymentUuid })
          .from(updateJobs)
          .all()
          .map((r) => r.du)
          .filter((du): du is string => du != null),
      );
      const unbound = candidates.filter((c) => !bound.has(c.deployment_uuid));
      const only = unbound[0];
      return unbound.length === 1 && only != null ? only.deployment_uuid : null;
    } catch {
      return null;
    }
  }

  private markUnknownSubmit(job: UpdateJobRow, reason: string): void {
    const log = this.logFor(job);
    log('deploy_submitted', reason);
    this.finishJob(job, 'unknown_submit', 'submit_unknown', reason);
    this.db
      .update(resources)
      .set({ blockedReason: 'update_failed', updatedAt: Date.now() })
      .where(eq(resources.id, job.resourceId))
      .run();
    this.outbox.enqueue({
      eventType: 'submit_unknown',
      resourceId: job.resourceId,
      dedupeKey: `submit_unknown:${job.id}`,
      payload: {
        title: '提交结果未知',
        body: `资源 #${job.resourceId} 的更新提交结果未知：${reason}。请先在更新历史中对账或人工确认，避免重复部署。`,
        type: 'warning',
      },
    });
  }

  /** Returns true when the job reached success; finalizes it otherwise. */
  private async pollDeployment(
    job: UpdateJobRow,
    _resource: ResourceRow,
    deploymentUuid: string,
  ): Promise<boolean> {
    const log = this.logFor(job);
    const deadline = Date.now() + this.timing.confirmWindowMs;
    while (Date.now() < deadline) {
      await sleep(this.timing.pollIntervalMs);
      if (this.settings.get().globalPaused) {
        // Pause stops new work; an in-flight deployment is still observed to a terminal state.
        log('deploy_submitted', '全局暂停生效；继续观察在途部署至终态');
      }
      let detail: Awaited<ReturnType<CoolifyClient['getDeployment']>>;
      try {
        detail = await this.coolify.getDeployment(deploymentUuid);
      } catch (err) {
        if (err instanceof CoolifyApiError && err.statusCode == null) continue; // transient
        this.failJob(
          job,
          'deployment_poll_failed',
          err instanceof Error ? err.message : 'poll failed',
        );
        return false;
      }
      const status = detail.status;
      if (status === 'finished') {
        log('deploy_submitted', '部署报告 finished');
        return true;
      }
      if (status === 'failed' || status === 'cancelled') {
        this.failJob(job, `deployment_${status}`, `Coolify deployment reported ${status}`);
        return false;
      }
    }
    this.failJob(job, 'confirmation_timeout', '部署确认窗口（10 分钟）超时');
    return false;
  }

  // --- compose child ------------------------------------------------------------

  private async runComposeChildJob(
    job: UpdateJobRow,
    resource: ResourceRow,
    track: ImageTrackRow,
  ): Promise<void> {
    const log = this.logFor(job);
    if (resource.parentId == null) {
      this.finishJob(job, 'blocked', 'orphan_child', 'Compose child lost its parent');
      return;
    }
    const parent = this.db
      .select()
      .from(resources)
      .where(eq(resources.id, resource.parentId))
      .get();
    if (parent == null) {
      this.finishJob(job, 'blocked', 'parent_missing', 'Parent service not found');
      return;
    }

    // 1. Fresh snapshot + sibling protection.
    let children: Awaited<ReturnType<CoolifyClient['listServiceApplications']>>;
    try {
      children = await this.coolify.listServiceApplications(parent.coolifyUuid);
    } catch (err) {
      this.failJob(
        job,
        'coolify_unreachable',
        err instanceof Error ? err.message : 'GET service failed',
      );
      return;
    }
    const target = children.find((c) => c.uuid === resource.coolifyUuid);
    if (target == null) {
      this.finishJob(job, 'conflict', 'child_missing', 'Target child disappeared from the service');
      return;
    }
    const expectedImage = job.candidateReference; // authored@sha256:...
    const priorImages = new Set(
      [job.priorReference, track.configuredReference].filter((v): v is string => v != null),
    );
    const alreadyCandidate = target.image === expectedImage;
    const matchesPrior = priorImages.has(target.image ?? '');
    if (!alreadyCandidate && !matchesPrior) {
      this.db
        .update(resources)
        .set({ blockedReason: 'external_change', updatedAt: Date.now() })
        .where(eq(resources.id, resource.id))
        .run();
      this.finishJob(
        job,
        'conflict',
        'external_change',
        'Child image changed outside toolkit expectations',
      );
      return;
    }
    // Sibling drift: live children must match stored rows.
    const siblings = this.db
      .select()
      .from(resources)
      .where(eq(resources.parentId, parent.id))
      .all();
    for (const sib of siblings) {
      if (sib.id === resource.id) continue;
      const live = children.find((c) => c.uuid === sib.coolifyUuid);
      if (live == null) continue;
      if (sib.currentImage != null && live.image != null && live.image !== sib.currentImage) {
        this.finishJob(
          job,
          'conflict',
          'sibling_drift',
          `Sibling ${sib.name} changed externally; refusing write`,
        );
        return;
      }
    }

    // 2. PATCH child image (raw compose is rewritten by Coolify).
    if (!alreadyCandidate) {
      this.setStage(job, 'patching', `写入 ${expectedImage}`);
      try {
        await this.coolify.patchServiceApplication(parent.coolifyUuid, resource.coolifyUuid, {
          image: expectedImage,
        });
      } catch (err) {
        this.failJob(
          job,
          'patch_failed',
          err instanceof Error ? err.message : 'child PATCH failed',
        );
        return;
      }
      // 3. Semantic readback: target image written, everything else unchanged.
      try {
        const [svcAfter, childrenAfter] = await Promise.all([
          this.coolify.getService(parent.coolifyUuid),
          this.coolify.listServiceApplications(parent.coolifyUuid),
        ]);
        const targetAfter = childrenAfter.find((c) => c.uuid === resource.coolifyUuid);
        if (targetAfter?.image !== expectedImage) {
          this.failJob(
            job,
            'readback_mismatch',
            'Child image readback differs from the written value',
          );
          return;
        }
        for (const sib of siblings) {
          if (sib.id === resource.id) continue;
          const live = childrenAfter.find((c) => c.uuid === sib.coolifyUuid);
          if (sib.currentImage != null && live?.image != null && live.image !== sib.currentImage) {
            this.failJob(
              job,
              'sibling_drift',
              `Sibling ${sib.name} image changed by the write; pausing`,
            );
            return;
          }
          if (sib.domains != null && live?.fqdn != null && live.fqdn !== sib.domains) {
            this.failJob(
              job,
              'sibling_drift',
              `Sibling ${sib.name} domain changed by the write; pausing`,
            );
            return;
          }
        }
        // Generated-variable sanity: compose raw must still contain the target image.
        const raw = svcAfter.docker_compose_raw ?? '';
        if (raw.length > 0 && !raw.includes(expectedImage)) {
          this.failJob(
            job,
            'compose_writeback_missing',
            'Raw compose no longer contains the target image',
          );
          return;
        }
      } catch (err) {
        this.failJob(
          job,
          'readback_failed',
          err instanceof Error ? err.message : 'readback failed',
        );
        return;
      }
    }
    this.setStage(job, 'patched', '子容器 image 已确认写入');
    // Target config written; mirror locally (evidence stays pending confirmation).
    this.localUpdateTrack(job.resourceId, job.candidateDigest, job.candidateReference, Date.now());

    // 4. Targeted child deploy (queued-only evidence in v4.3.23).
    if (job.stage !== 'awaiting_confirmation') {
      try {
        await this.coolify.startServiceApplication(parent.coolifyUuid, resource.coolifyUuid, true);
      } catch (err) {
        if (err instanceof CoolifyApiError && err.statusCode == null) {
          this.markUnknownSubmit(job, '子容器 start 超时，结果未知');
          return;
        }
        this.failJob(
          job,
          'start_failed',
          err instanceof Error ? err.message : 'child start failed',
        );
        return;
      }
    }
    const now = Date.now();
    this.db
      .update(updateJobs)
      .set({ stage: 'awaiting_confirmation', updatedAt: now })
      .where(eq(updateJobs.id, job.id))
      .run();
    this.db
      .update(resources)
      .set({
        currentImage: expectedImage,
        blockedReason: 'compose_confirmation_pending',
        updatedAt: now,
      })
      .where(eq(resources.id, resource.id))
      .run();
    this.outbox.enqueue({
      eventType: 'submit_unknown',
      resourceId: resource.id,
      dedupeKey: `compose_submitted:${job.id}`,
      payload: {
        title: 'Compose 更新已提交，待确认',
        body: `资源 ${resource.name} 已提交定向部署（Coolify 仅返回 queued，无完成证据）。请在验证容器运行正常后，在更新历史中人工确认。`,
        type: 'warning',
      },
    });
    log('awaiting_confirmation', '已提交；等待人工确认（无完成证据可用）');
  }

  // --- boot reconciliation ------------------------------------------------------

  /**
   * Crash/restart recovery: requeue interrupted work, resolve submit-unknown by
   * history association, keep awaiting_confirmation items for the user.
   */
  async reconcileOnBoot(): Promise<{ requeued: number; resolved: number; unknown: number }> {
    const result = { requeued: 0, resolved: 0, unknown: 0 };
    const running = this.db.select().from(updateJobs).where(eq(updateJobs.status, 'running')).all();
    for (const job of running) {
      const now = Date.now();
      if (job.stage === 'awaiting_confirmation') continue; // user decision pending
      const resource = this.db
        .select()
        .from(resources)
        .where(eq(resources.id, job.resourceId))
        .get();
      if (resource == null) {
        this.finishJob(job, 'blocked', 'resource_missing', 'Resource disappeared');
        continue;
      }
      if (job.stage === 'deploy_submitted') {
        if (job.deploymentUuid != null) {
          // Resume polling directly.
          this.db
            .update(updateJobs)
            .set({ status: 'pending', updatedAt: now })
            .where(eq(updateJobs.id, job.id))
            .run();
          result.requeued += 1;
          continue;
        }
        const associated = await this.associateDeploymentByTime(
          resource.coolifyUuid,
          job.startedAt ?? job.createdAt,
        );
        if (associated != null) {
          this.db
            .update(updateJobs)
            .set({ deploymentUuid: associated, status: 'pending', updatedAt: now })
            .where(eq(updateJobs.id, job.id))
            .run();
          result.resolved += 1;
        } else {
          this.markUnknownSubmit(job, '进程重启后无法唯一关联部署记录');
          result.unknown += 1;
        }
        continue;
      }
      // queued/revalidated/patching/patched: safe to re-run from scratch (semantic checks).
      this.db
        .update(updateJobs)
        .set({ status: 'pending', stage: 'queued', updatedAt: now })
        .where(eq(updateJobs.id, job.id))
        .run();
      result.requeued += 1;
    }
    return result;
  }
}

function short(digest: string): string {
  return digest.startsWith('sha256:') ? digest.slice(7, 19) : digest.slice(0, 12);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
