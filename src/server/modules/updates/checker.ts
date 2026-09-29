// Update checker: resolves tracked tags upstream and derives candidate state.
// Ignores policy for observation; only notify/auto resources produce notifications,
// only auto resources produce update jobs (§2/§3).

import { eq } from 'drizzle-orm';
import type { CheckOutcome } from '../../../shared/types.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import { imageTracks, resources } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import {
  credentialsFor,
  ghcrTagUpdatedAt,
  RegistryFailure,
  resolveTagDigestCoalesced,
  type tagLastPushedAt,
} from '../../integrations/registry/adapter.js';
import { shortDigest } from '../fingerprint.js';
import type { Outbox } from '../notifications/outbox.js';
import type { JobsService } from './jobs.js';

const CHECK_CONCURRENCY = 4;
const CHECK_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2_000;

export interface CheckResult {
  resourceId: number;
  outcome: CheckOutcome;
  observedDigest: string | null;
  candidate: boolean;
  message: string | null;
}

export type ResolveFn = typeof resolveTagDigestCoalesced;
export type TagTimeFn = typeof tagLastPushedAt;

export class UpdateChecker {
  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsRepo,
    private readonly outbox: Outbox,
    private readonly jobs: JobsService,
    /** Injectable for offline tests; production uses the real SDK adapter. */
    private readonly resolve: ResolveFn = resolveTagDigestCoalesced,
    /** Injectable tag-push-time lookup (Docker Hub metadata); null disables. */
    private readonly tagTime: TagTimeFn | null = null,
  ) {}

  async checkAll(reason: 'scheduled' | 'manual'): Promise<CheckResult[]> {
    const rows = this.db
      .select({ resource: resources, track: imageTracks })
      .from(resources)
      .innerJoin(imageTracks, eq(imageTracks.resourceId, resources.id))
      .all();
    // 定时扫描只覆盖 notify/auto 且未设置资源级 cron 的资源；
    // manual（手动）/ignore 与自定义 cron 的由用户手动检查或独立调度。
    const eligible = rows.filter(
      ({ resource, track }) =>
        resource.checkCron == null &&
        (resource.policy === 'notify' || resource.policy === 'auto') &&
        this.eligible(resource, track),
    );
    const results: CheckResult[] = [];
    // Simple worker-pool over the eligible set.
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CHECK_CONCURRENCY, eligible.length) },
      async () => {
        for (;;) {
          const idx = cursor++;
          if (idx >= eligible.length) return;
          const item = eligible[idx];
          if (item == null) return;
          results.push(await this.checkResource(item.resource.id, reason));
        }
      },
    );
    await Promise.all(workers);
    this.settings.setMeta('lastCheckAt', Date.now());
    return results;
  }

  /** Targeted checks for explicitly selected resources (single/batch check). */
  async checkMany(resourceIds: number[], reason: 'scheduled' | 'manual'): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const id of resourceIds) {
      results.push(await this.checkResource(id, reason));
    }
    if (resourceIds.length > 0) this.settings.setMeta('lastCheckAt', Date.now());
    return results;
  }

  private eligible(
    resource: typeof resources.$inferSelect,
    track: typeof imageTracks.$inferSelect,
  ): boolean {
    if (resource.status !== 'active') return false;
    if (resource.excludedInfra) return false;
    // Ignored resources get no checks at all. manual 策略允许手动检查
    // （定时扫描由 checkAll 的策略过滤负责排除）。
    if (resource.policy === 'ignore') return false;
    if (resource.blockedReason === 'external_change') return false;
    if (track.sourceTag === '') return false; // tracking tag must be configured first
    if (track.targetPlatform == null || track.targetPlatform === '') return false; // platform must be verifiable
    return true;
  }

  async checkResource(resourceId: number, reason: 'scheduled' | 'manual'): Promise<CheckResult> {
    const resource = this.db.select().from(resources).where(eq(resources.id, resourceId)).get();
    const track = this.db
      .select()
      .from(imageTracks)
      .where(eq(imageTracks.resourceId, resourceId))
      .get();
    if (resource == null || track == null) {
      return {
        resourceId,
        outcome: 'error',
        observedDigest: null,
        candidate: false,
        message: 'resource/track missing',
      };
    }
    if (!this.eligible(resource, track)) {
      return {
        resourceId,
        outcome: 'blocked',
        observedDigest: null,
        candidate: false,
        message: resource.blockedReason ?? 'not eligible',
      };
    }

    // Resolve with limited retry; Retry-After respected when present.
    let resolved: Awaited<ReturnType<typeof resolveTagDigestCoalesced>> | null = null;
    let lastError: string | null = null;
    for (let attempt = 0; attempt <= CHECK_RETRIES; attempt++) {
      try {
        resolved = await this.resolve(
          {
            registry: track.sourceRegistry,
            repository: track.sourceRepository,
            tag: track.sourceTag,
            platform: track.targetPlatform,
            credentials: credentialsFor(this.cfg, track.sourceRegistry),
          },
          'v1',
        );
        break;
      } catch (err) {
        if (err instanceof RegistryFailure) {
          lastError = err.normalized.message;
          if (!err.normalized.retryable || attempt === CHECK_RETRIES) break;
          const delay =
            err.normalized.retryAfterSeconds != null
              ? err.normalized.retryAfterSeconds * 1000
              : RETRY_BASE_DELAY_MS * (attempt + 1);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        lastError = err instanceof Error ? err.message : 'registry error';
        break;
      }
    }

    const now = Date.now();
    // Best-effort upstream tag push time. Docker Hub 公开元数据；GHCR 需要可选
    // 的 GITHUB_TOKEN；其余来源或未配置时保持未知。
    if (this.tagTime != null) {
      try {
        const githubToken = this.cfg.githubToken;
        const ghcr = track.sourceRegistry === 'ghcr.io' && githubToken != null;
        const pushedAt = ghcr
          ? await ghcrTagUpdatedAt(githubToken, track.sourceRepository, track.sourceTag)
          : await this.tagTime(track.sourceRegistry, track.sourceRepository, track.sourceTag);
        if (pushedAt != null) {
          this.db
            .update(imageTracks)
            .set({ upstreamTagUpdatedAt: pushedAt, updatedAt: now })
            .where(eq(imageTracks.id, track.id))
            .run();
        }
      } catch {
        // Metadata lookup is advisory only.
      }
    }
    if (resolved == null) {
      this.db
        .update(imageTracks)
        .set({ observedError: lastError, updatedAt: now })
        .where(eq(imageTracks.id, track.id))
        .run();
      return {
        resourceId,
        outcome: 'error',
        observedDigest: null,
        candidate: false,
        message: lastError,
      };
    }

    const priorObserved = track.observedDigest;
    this.db
      .update(imageTracks)
      .set({
        observedDigest: resolved.digest,
        observedAt: resolved.observedAt,
        observedReferenceKind: resolved.referenceKind,
        platformManifestDigest: resolved.platformManifestDigest,
        observedError: null,
        updatedAt: now,
      })
      .where(eq(imageTracks.id, track.id))
      .run();

    const configured = track.configuredDigest;
    if (configured == null) {
      // Not yet taken over: observation only; drift of the remote baseline is reportable.
      if (priorObserved != null && priorObserved !== resolved.digest) {
        this.outbox.enqueue({
          eventType: 'upstream_changed',
          resourceId,
          dedupeKey: `upstream_changed:${resourceId}:${resolved.digest}`,
          payload: {
            title: '上游镜像变化',
            body: `资源 ${resource.name}（${track.sourceRegistry}/${track.sourceRepository}:${track.sourceTag}）上游摘要变化：${shortDigest(priorObserved)} → ${shortDigest(resolved.digest)}。该资源尚未初始化，运行版本未知。`,
            type: 'info',
          },
        });
      }
      return {
        resourceId,
        outcome: 'unfixed',
        observedDigest: resolved.digest,
        candidate: false,
        message: null,
      };
    }

    if (resolved.digest === configured) {
      return {
        resourceId,
        outcome: 'matching',
        observedDigest: resolved.digest,
        candidate: false,
        message: null,
      };
    }

    // Candidate found. manual 策略不发通知。
    if (resource.policy !== 'manual') {
      this.outbox.enqueue({
        eventType: 'candidate_found',
        resourceId,
        dedupeKey: `candidate:${resourceId}:${resolved.digest}`,
        payload: {
          title: '发现候选更新',
          body: `资源 ${resource.name}：追踪 tag ${track.sourceTag} 出现新摘要 ${shortDigest(resolved.digest)}（当前配置 ${shortDigest(configured)}）。`,
          type: 'info',
        },
      });
    }

    if (resource.policy === 'auto' && reason === 'scheduled') {
      this.jobs.createAutoJob(resourceId, resolved.digest);
    }
    return {
      resourceId,
      outcome: 'candidate',
      observedDigest: resolved.digest,
      candidate: true,
      message: null,
    };
  }
}
