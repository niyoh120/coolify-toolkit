// Update job lifecycle service. Jobs are the only path that mutates Coolify targets.

import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ApiRequestError, errorCodes } from '../../../shared/errors.js';
import { digestSchema } from '../../../shared/schemas.js';
import type { Db } from '../../db/client.js';
import { pruneJobHistory } from '../../db/retention.js';
import type { ImageTrackRow, ResourceRow, UpdateJobRow } from '../../db/schema.js';
import { imageTracks, resources, updateJobs } from '../../db/schema.js';
import type { SettingsRepo } from '../../db/settings-repo.js';
import { coolifyDigestTag } from '../../integrations/registry/reference.js';

const ACTIVE_STATUSES = ['pending', 'running'] as const;

export interface PreviewRecord {
  resourceId: number;
  digest: string;
  createdAt: number;
  expiresAt: number;
}

export const PREVIEW_TTL_MS = 10 * 60_000;

export class JobsService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsRepo,
  ) {}

  // --- preview tokens -------------------------------------------------------

  issuePreviewToken(resourceId: number, digest: string): string {
    const token = randomBytes(16).toString('hex');
    const now = Date.now();
    this.settings.setMeta(`preview.${token}`, {
      resourceId,
      digest,
      createdAt: now,
      expiresAt: now + PREVIEW_TTL_MS,
    } satisfies PreviewRecord);
    return token;
  }

  consumePreviewToken(token: string, resourceId: number, digest: string): void {
    const rec = this.settings.getMeta<PreviewRecord>(`preview.${token}`);
    if (
      rec == null ||
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

  // --- guards ----------------------------------------------------------------

  /** Non-terminal or evidence-blocked jobs for a resource. */
  blockingJob(resourceId: number, candidateDigest?: string): UpdateJobRow | null {
    const rows = this.db
      .select()
      .from(updateJobs)
      .where(eq(updateJobs.resourceId, resourceId))
      .orderBy(desc(updateJobs.id))
      .all();
    return (
      rows.find(
        (j) =>
          (ACTIVE_STATUSES as readonly string[]).includes(j.status) ||
          j.stage === 'awaiting_confirmation' ||
          (candidateDigest != null &&
            j.candidateDigest === candidateDigest &&
            ['failed', 'conflict', 'unknown_submit', 'blocked'].includes(j.status)),
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
    if (resource.excludedInfra) {
      throw new ApiRequestError(errorCodes.blocked, 'Resource is excluded from management', 409);
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
    this.consumePreviewToken(previewToken, resourceId, digest);
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
    const existing = this.blockingJob(resourceId, digest);
    if (existing != null) {
      if (
        ['pending', 'running'].includes(existing.status) ||
        existing.stage === 'awaiting_confirmation'
      ) {
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
    return this.insertJob(
      resourceId,
      digest,
      track,
      resource,
      'manual',
      (track?.configuredDigest ?? null) == null,
    );
  }

  createAutoJob(resourceId: number, candidateDigest: string): UpdateJobRow | null {
    const digest = digestSchema.parse(candidateDigest);
    const { resource, track } = this.loadPair(resourceId);
    this.assertUpdatable(resource, track);
    if (track == null) return null; // assertUpdatable throws first; narrows for TS
    if (resource.policy !== 'auto') return null;
    if (this.settings.get().globalPaused) return null;
    if (resource.isStopped) return null;
    if (resource.blockedReason != null) return null;
    if (this.blockingJob(resourceId, digest) != null) return null;
    const isInitialPin = (track?.configuredDigest ?? null) == null;
    return this.insertJob(resourceId, digest, track, resource, 'auto', isInitialPin);
  }

  private insertJob(
    resourceId: number,
    digest: string,
    track: ImageTrackRow,
    resource: ResourceRow,
    trigger: 'manual' | 'auto',
    initialPin: boolean,
  ): UpdateJobRow {
    const candidateReference =
      resource.kind === 'service_application'
        ? `${track.sourceRepositoryAuthored}@${digest}`
        : `${track.sourceRepository}:${coolifyDigestTag(digest)}`;
    const now = Date.now();
    const seq = this.db
      .select({ id: updateJobs.id })
      .from(updateJobs)
      .where(and(eq(updateJobs.resourceId, resourceId), eq(updateJobs.candidateDigest, digest)))
      .all().length;
    const job = this.db
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
    pruneJobHistory(this.db);
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
    const now = Date.now();
    const updated = this.db
      .update(updateJobs)
      .set({
        status: 'pending',
        stage: 'queued',
        // A retry is a fresh deployment attempt; never resume a failed one.
        deploymentUuid: null,
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
    if (job.stage !== 'awaiting_confirmation') {
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
    const updated = this.db
      .update(updateJobs)
      .set({
        status: 'success',
        stage: 'done',
        confirmedManually: true,
        finishedAt: now,
        updatedAt: now,
        log: [
          ...job.log,
          { at: new Date(now).toISOString(), stage: 'done', message: '人工确认提交结果' },
        ],
      })
      .where(eq(updateJobs.id, jobId))
      .returning()
      .get();
    if (updated != null) {
      this.advanceTrackOnSuccess(job, 'manual', null);
      this.db
        .update(resources)
        .set({ blockedReason: null, updatedAt: now })
        .where(eq(resources.id, job.resourceId))
        .run();
    }
    return updated ?? job;
  }

  /** Advance success evidence. source=manual records human attestation only. */
  advanceTrackOnSuccess(
    job: UpdateJobRow,
    source: 'deployment' | 'manual',
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
