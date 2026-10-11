// Update executor: the guarded state machine from intent to (un)confirmed result.
// Application: PATCH → readback → start(deployment uuid) → poll → health-agnostic success.
// Compose child: sibling-safe PATCH → raw-compose verification → targeted start →
// awaiting_confirmation (Coolify returns queued-only evidence in v4.3.23).
// Failure keeps the written target config, pauses auto updates and notifies.
// Rollback is explicitly out of scope (phase 1).

import { and, asc, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { ImageTrackRow, ResourceRow, UpdateJobRow } from '../../db/schema.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import type { CoolifyClient } from '../../integrations/coolify/client.js';
import { CoolifyApiError } from '../../integrations/coolify/client.js';
import { applicationImageRef, applicationTagField } from '../../integrations/coolify/mapper.js';
import { coolifyDigestTag, normalizeReference } from '../../integrations/registry/reference.js';
import { effectiveManagementGate } from '../inventory/management-state.js';
import { parentRowOf } from '../inventory/parent-row.js';
import type { Outbox } from '../notifications/outbox.js';
import type { JobsService } from './jobs.js';

const CONFIRM_WINDOW_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;
/** Delay before the single post-deploy runtime check for compose children. */
const AUTO_CONFIRM_DELAY_MS = 60_000;
/** Max due checks claimed per tick; the 5s worker loop re-runs promptly. */
const CONFIRMATION_BATCH = 50;
type LogSink = (stage: UpdateJobRow['stage'], message: string) => void;

export interface ExecutorTiming {
  pollIntervalMs: number;
  confirmWindowMs: number;
  /** Waiting window between the targeted start and the single auto-check. */
  autoConfirmDelayMs: number;
}

const DEFAULT_TIMING: ExecutorTiming = {
  pollIntervalMs: POLL_INTERVAL_MS,
  confirmWindowMs: CONFIRM_WINDOW_MS,
  autoConfirmDelayMs: AUTO_CONFIRM_DELAY_MS,
};

/** Typed check failure carrying an explicit error code for the job row. */
class ComposeCheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ComposeCheckError';
  }
}

export class UpdateExecutor {
  private running = false;
  /** Independent reentry guard for due confirmations (5s tick overlap). */
  private confirming = false;

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

  /**
   * Pick the next pending job whose resource/parent has no active job.
   *
   * Queue safety over unclassified databases: pending jobs of not-yet-
   * classified resources without a submitted deployment stay pending (the
   * filter is in SQL so waiting items cannot starve later claimable ones);
   * pending jobs whose resource classified into an ineligible state are
   * marked blocked with the concrete reason instead of executing.
   */
  private claimNext(): UpdateJobRow | null {
    const pending = this.db
      .select({ job: updateJobs, res: resources })
      .from(updateJobs)
      .innerJoin(resources, eq(resources.id, updateJobs.resourceId))
      .where(
        and(
          eq(updateJobs.status, 'pending'),
          // 待同步确认且未提交部署的任务保持 pending，等同步后重判资格；
          // 已提交部署的任务走证据恢复路径，与分类状态无关。
          or(isNotNull(updateJobs.deploymentUuid), eq(resources.managementClassified, true)),
        ),
      )
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
    for (const { job, res } of pending) {
      if ((activeByResource.get(job.resourceId) ?? 0) > 0) continue;
      if (res.parentId != null && activeParents.has(res.parentId)) continue;
      // 已分类但确认为配置排除/镜像异常（或父级继承受限）的排队任务：
      // 记录 blocked 与原因，继续扫描后续候选。
      if (res.managementClassified) {
        const gate = effectiveManagementGate(res, parentRowOf(this.db, res), res.currentImage);
        if (!gate.ok) {
          this.blockJob(job, gate.code, gate.reason);
          continue;
        }
      }
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
        // Every terminal state leaves awaiting_confirmation: cancel any due check.
        confirmationDueAt: null,
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

  /** 执行前阻塞：记录具体资格原因，无通知（无副作用发生）。 */
  private blockJob(job: UpdateJobRow, code: string, message: string): void {
    const current = this.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    if (current == null) return;
    const now = Date.now();
    this.db
      .update(updateJobs)
      .set({
        status: 'blocked',
        errorCode: code,
        errorMessage: message,
        finishedAt: now,
        updatedAt: now,
        log: [
          ...current.log,
          { at: new Date(now).toISOString(), stage: current.stage, message: `阻塞：${message}` },
        ],
      })
      .where(eq(updateJobs.id, job.id))
      .run();
  }

  /** Failure policy: keep target config, pause auto, notify (no rollback). */
  private pauseWithNotification(job: UpdateJobRow, code: string, message: string): void {
    const now = Date.now();
    this.db
      .update(resources)
      .set({ blockedReason: 'update_failed', updatedAt: now })
      .where(eq(resources.id, job.resourceId))
      .run();
    this.notifyTerminal(
      job,
      '更新失败',
      `资源 #${job.resourceId} 更新到 ${short(job.candidateDigest)} 失败（${code}）：${message}。` +
        '当前目标配置已保留，自动更新已暂停。',
    );
  }

  /** Shared outbox write for failure/conflict terminals (dedupe per job). */
  private notifyTerminal(job: UpdateJobRow, title: string, body: string): void {
    this.outbox.enqueue({
      eventType: 'update_failed',
      resourceId: job.resourceId,
      dedupeKey: `update_failed:${job.id}`,
      payload: { title, body, type: 'failure' },
    });
  }

  /** External-change guard for runtime drift; call only after winning the job. */
  private markExternalChange(job: UpdateJobRow): void {
    this.db
      .update(resources)
      .set({ blockedReason: 'external_change', updatedAt: Date.now() })
      .where(eq(resources.id, job.resourceId))
      .run();
  }

  /**
   * Conditional terminal write for the delayed check: the whole wait window
   * (status/stage/dueAt/digest) is re-verified so a manual confirmation or
   * retry that raced ahead always wins; the loser writes nothing. Returns true
   * when this invocation won the job.
   */
  private finalizeAwaitingJob(
    job: UpdateJobRow,
    dueAt: number,
    status: 'failed' | 'conflict' | 'blocked',
    code: string,
    message: string,
    extraLogs: UpdateJobRow['log'] = [],
  ): boolean {
    const now = Date.now();
    const live = this.db.select().from(updateJobs).where(eq(updateJobs.id, job.id)).get();
    if (live == null) return false;
    const updated = this.db
      .update(updateJobs)
      .set({
        status,
        errorCode: code,
        errorMessage: message,
        confirmationDueAt: null,
        finishedAt: now,
        updatedAt: now,
        log: [...live.log, ...extraLogs],
      })
      .where(
        and(
          eq(updateJobs.id, job.id),
          eq(updateJobs.status, 'running'),
          eq(updateJobs.stage, 'awaiting_confirmation'),
          eq(updateJobs.confirmationDueAt, dueAt),
          eq(updateJobs.candidateDigest, job.candidateDigest),
        ),
      )
      .returning()
      .get();
    return updated != null;
  }

  /** Guarded failure for the delayed check: winner-only side effects. */
  private failAwaitingJob(
    job: UpdateJobRow,
    dueAt: number,
    code: string,
    message: string,
    extraLogs: UpdateJobRow['log'] = [],
  ): void {
    if (this.finalizeAwaitingJob(job, dueAt, 'failed', code, message, extraLogs)) {
      this.pauseWithNotification(job, code, message);
    }
  }

  /** Guarded conflict for the delayed check: winner-only guard + notification. */
  private conflictAwaitingJob(
    job: UpdateJobRow,
    dueAt: number,
    code: string,
    message: string,
    extraLogs: UpdateJobRow['log'] = [],
  ): void {
    if (this.finalizeAwaitingJob(job, dueAt, 'conflict', code, message, extraLogs)) {
      this.markExternalChange(job);
      this.notifyTerminal(
        job,
        '更新冲突',
        `资源 #${job.resourceId} 自动检查发现配置漂移（${code}）：${message}。目标已保留，资源已置为外部修改状态，请核对后在资源详情重新确认追踪来源。`,
      );
    }
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
    // 执行入口边界复查（plan §5）：
    //  - 未分类且未提交部署：绝不产生新副作用，保持现状等同步后重判。
    //  - 已分类但受限（排除/镜像问题/父级继承）且未提交部署：blocked + 原因。
    //  - 已提交部署（deploymentUuid 存在）：证据恢复路径继续，只 poll/readback。
    if (job.deploymentUuid == null) {
      if (!resource.managementClassified) {
        // 防御路径（当前 claim 过滤不可达）：把已领取的任务显式放回队列，
        // 避免滞留 running 等待重启 reconcile。
        this.db
          .update(updateJobs)
          .set({ status: 'pending', updatedAt: Date.now() })
          .where(eq(updateJobs.id, job.id))
          .run();
        return;
      }
      const gate = effectiveManagementGate(
        resource,
        parentRowOf(this.db, resource),
        resource.currentImage,
      );
      if (!gate.ok) {
        this.blockJob(job, gate.code, gate.reason);
        return;
      }
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
    // Persist the single delayed auto-check window; the scheduler's due-check
    // entry point owns it from here (no sleep, the queue stays free).
    const now = Date.now();
    const dueAt = now + this.timing.autoConfirmDelayMs;
    this.db
      .update(updateJobs)
      .set({ stage: 'awaiting_confirmation', confirmationDueAt: dueAt, updatedAt: now })
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
    log(
      'awaiting_confirmation',
      `已提交定向部署；${Math.round(this.timing.autoConfirmDelayMs / 1000)} 秒后自动检查一次运行状态，期间也可在服务列表「确认更新完成」`,
    );
  }

  // --- delayed single auto-check -------------------------------------------------

  /**
   * Claim-and-run one due auto-check per compose child per invocation. Global
   * pause never blocks this: an already-submitted deployment is still observed.
   * Waits are expressed in the database (confirmation_due_at), so nothing sleeps
   * on the queue. Returns the number of due jobs processed.
   */
  async processDueConfirmations(): Promise<number> {
    if (this.confirming) return 0;
    this.confirming = true;
    let processed = 0;
    try {
      const now = Date.now();
      const due = this.db
        .select()
        .from(updateJobs)
        .where(
          and(
            eq(updateJobs.status, 'running'),
            eq(updateJobs.stage, 'awaiting_confirmation'),
            lte(updateJobs.confirmationDueAt, now),
          ),
        )
        .orderBy(asc(updateJobs.confirmationDueAt), asc(updateJobs.id))
        .limit(CONFIRMATION_BATCH)
        .all();
      for (const job of due) {
        // The WHERE clause already excludes NULL due times; this guard exists
        // only to narrow the type for the window-guarded calls below.
        const dueAt = job.confirmationDueAt;
        if (dueAt == null) continue;
        const resource = this.db
          .select()
          .from(resources)
          .where(eq(resources.id, job.resourceId))
          .get();
        if (resource?.kind !== 'service_application') continue;
        processed += 1;
        try {
          await this.runScheduledConfirmation(job, dueAt);
        } catch (err) {
          // Per-item isolation: one broken check never blocks the batch.
          this.failAwaitingJob(
            job,
            dueAt,
            'internal_error',
            err instanceof Error ? err.message : 'unknown error',
          );
        }
      }
    } finally {
      this.confirming = false;
    }
    return processed;
  }

  /**
   * One read-only round against Coolify, then a conditional finalize. The wait
   * window (status/stage/dueAt/candidate) is re-verified in the final UPDATE so
   * a manual confirmation or retry that raced ahead always wins.
   */
  private async runScheduledConfirmation(job: UpdateJobRow, dueAt: number): Promise<void> {
    // 时序不变量：以下四个终态分支必须保持在首个 await 之前的同步前缀内——
    // 单线程下与人工确认无交错窗口；若未来在其前插入 await，请改走
    // finalizeAwaitingJob 窗口守卫，避免覆盖已成立的终态。
    const resource = this.db.select().from(resources).where(eq(resources.id, job.resourceId)).get();
    if (resource == null) {
      this.finishJob(job, 'blocked', 'resource_missing', 'Resource disappeared');
      return;
    }
    if (resource.kind !== 'service_application') {
      this.finishJob(job, 'blocked', 'unsupported_kind', 'Auto-check covers compose children only');
      return;
    }
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
    // Observation notes are buffered and persisted only by the window winner,
    // so a lost race can never rewrite a terminal row's stage/log.
    const notes: UpdateJobRow['log'] = [];
    const note = (message: string): void => {
      notes.push({ at: new Date().toISOString(), stage: 'awaiting_confirmation', message });
    };

    // Read-only round: service detail (raw compose) + live child list.
    let service: Awaited<ReturnType<CoolifyClient['getService']>>;
    let children: Awaited<ReturnType<CoolifyClient['listServiceApplications']>>;
    try {
      [service, children] = await Promise.all([
        this.coolify.getService(parent.coolifyUuid),
        this.coolify.listServiceApplications(parent.coolifyUuid),
      ]);
    } catch (err) {
      this.failAwaitingJob(
        job,
        dueAt,
        'coolify_unreachable',
        err instanceof Error ? err.message : 'auto-check read failed',
        notes,
      );
      return;
    }

    // Locate the live child by UUID.
    const target = children.find((c) => c.uuid === resource.coolifyUuid);
    if (target == null) {
      this.failAwaitingJob(
        job,
        dueAt,
        'child_missing',
        '目标子容器已从服务中消失，保留上一成功证据',
        notes,
      );
      return;
    }

    // Status: main segment must be running (running:unhealthy included); the
    // health suffix is logged only — healthchecks stay optional.
    const rawStatus = target.status ?? '';
    const [statusMain, healthSuffix] = rawStatus.split(':').map((s) => s.trim());
    if (statusMain !== 'running') {
      this.failAwaitingJob(
        job,
        dueAt,
        'container_not_running',
        `自动检查发现容器状态为「${rawStatus === '' ? '未知' : rawStatus}」，预期 running`,
        notes,
      );
      return;
    }
    if (healthSuffix != null && healthSuffix !== '') {
      note(
        healthSuffix === 'healthy'
          ? '容器健康检查已通过'
          : `容器健康状态：${healthSuffix}（持续信号，不影响本次确认）`,
      );
    }

    // Compose service node key: persisted composeServiceName wins; live child
    // name is the fallback. A mismatch is recorded as configuration drift.
    const liveName = target.name ?? '';
    const persistedKey = resource.composeServiceName ?? '';
    if (persistedKey === '' && liveName === '') {
      this.failAwaitingJob(
        job,
        dueAt,
        'compose_service_key_missing',
        '无法确定 compose 服务节点名（两处均为空）',
        notes,
      );
      return;
    }
    const serviceKey = persistedKey !== '' ? persistedKey : liveName;
    if (persistedKey !== '' && liveName !== '' && liveName !== persistedKey) {
      note(
        `配置漂移：持久化服务名 ${persistedKey} 与实时容器名 ${liveName} 不一致，按持久化名检查`,
      );
    }

    // Child image must equal the fixed digest reference this job wrote.
    if (target.image !== job.candidateReference) {
      this.conflictAwaitingJob(
        job,
        dueAt,
        'external_change',
        `子容器 image 已变为 ${target.image ?? '空'}，预期 ${short(job.candidateDigest)} 引用`,
        notes,
      );
      return;
    }

    // Raw compose: the target service node's image must equal the candidate.
    try {
      const nodeImage = composeTargetNodeImage(service.docker_compose_raw ?? '', serviceKey);
      if (nodeImage !== job.candidateReference) {
        this.conflictAwaitingJob(
          job,
          dueAt,
          'external_change',
          `raw compose 中 services.${serviceKey}.image 已变为 ${nodeImage ?? '空'}，预期 ${short(job.candidateDigest)} 引用`,
          notes,
        );
        return;
      }
    } catch (err) {
      if (err instanceof ComposeCheckError) {
        this.failAwaitingJob(job, dueAt, err.code, err.message, notes);
        return;
      }
      throw err;
    }

    // All green: conditional finalize over the same waiting window.
    const now = Date.now();
    const finalized = this.db
      .update(updateJobs)
      .set({
        status: 'success',
        stage: 'done',
        confirmationDueAt: null,
        finishedAt: now,
        updatedAt: now,
        log: [
          ...job.log,
          ...notes,
          {
            at: new Date(now).toISOString(),
            stage: 'done' as const,
            message: '单次运行观察自动确认：容器 running 且目标镜像配置一致',
          },
        ],
      })
      .where(
        and(
          eq(updateJobs.id, job.id),
          eq(updateJobs.status, 'running'),
          eq(updateJobs.stage, 'awaiting_confirmation'),
          eq(updateJobs.confirmationDueAt, dueAt),
          eq(updateJobs.candidateDigest, job.candidateDigest),
        ),
      )
      .returning()
      .get();
    if (finalized == null) return; // manual confirm / retry raced ahead
    this.jobs.advanceTrackOnSuccess(job, 'runtime_observation', null);
    // Clear only this task's confirmation guard; independent blocks stay.
    const fresh = this.db.select().from(resources).where(eq(resources.id, resource.id)).get();
    if (fresh != null) {
      this.db
        .update(resources)
        .set({
          currentImage: job.candidateReference,
          blockedReason:
            fresh.blockedReason === 'compose_confirmation_pending' ? null : fresh.blockedReason,
          updatedAt: now,
        })
        .where(eq(resources.id, resource.id))
        .run();
    }
    this.outbox.enqueue({
      eventType: 'update_success',
      resourceId: resource.id,
      dedupeKey: `update_success:${job.id}`,
      payload: {
        title: '更新完成',
        body: `资源 ${resource.name} 已更新到 ${short(job.candidateDigest)}（单次运行观察自动确认）。`,
        type: 'success',
      },
    });
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
      if (job.stage === 'awaiting_confirmation') {
        const resource = this.db
          .select()
          .from(resources)
          .where(eq(resources.id, job.resourceId))
          .get();
        if (resource?.kind === 'service_application') {
          // Backfill the due time for legacy/pre-upgrade rows (updatedAt+delay);
          // rows that already expired are taken over by the first worker tick.
          if (job.confirmationDueAt == null) {
            this.db
              .update(updateJobs)
              .set({ confirmationDueAt: job.updatedAt + this.timing.autoConfirmDelayMs })
              .where(eq(updateJobs.id, job.id))
              .run();
          }
          // Upgrade semantics: pause the not-yet-sent manual-confirmation warning
          // bound to this job; already-sent history stays untouched.
          this.db
            .update(notificationOutbox)
            .set({
              status: 'paused',
              lastError: '已升级为提交后延迟单次自动检查，该提醒停用',
            })
            .where(
              and(
                eq(notificationOutbox.dedupeKey, `compose_submitted:${job.id}`),
                eq(notificationOutbox.eventType, 'submit_unknown'),
                inArray(notificationOutbox.status, ['pending', 'failed']),
              ),
            )
            .run();
        }
        continue; // user decision / auto-check pending
      }
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

/**
 * Read the target service node's image from raw compose. Only the exact target
 * node counts: a sibling value or a comment can never satisfy the check.
 * Throws ComposeCheckError with a stable code for every unreadable shape.
 */
function composeTargetNodeImage(raw: string, serviceKey: string): string | null {
  if (raw.trim() === '') {
    throw new ComposeCheckError('compose_raw_missing', 'raw compose 缺失或为空，无法核对目标节点');
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ComposeCheckError(
      'compose_raw_invalid',
      `raw compose 解析失败：${err instanceof Error ? err.message : 'parse error'}`,
    );
  }
  if (doc == null || typeof doc !== 'object') {
    throw new ComposeCheckError('compose_raw_invalid', 'raw compose 解析结果不是对象');
  }
  const services = (doc as { services?: unknown }).services;
  if (services == null || typeof services !== 'object' || Array.isArray(services)) {
    throw new ComposeCheckError('compose_service_missing', 'raw compose 缺少 services 段');
  }
  const node = (services as Record<string, unknown>)[serviceKey];
  if (node == null || typeof node !== 'object' || Array.isArray(node)) {
    throw new ComposeCheckError(
      'compose_service_missing',
      `raw compose 中不存在 services.${serviceKey} 节点`,
    );
  }
  const image = (node as { image?: unknown }).image;
  if (typeof image !== 'string' || image === '') {
    throw new ComposeCheckError(
      'compose_image_missing',
      `raw compose 中 services.${serviceKey}.image 缺失或非文本`,
    );
  }
  return image;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
