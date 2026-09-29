// REST API: resources, checks, previews, updates, jobs, notifications, settings.
// Reads hit the local projection; external effects run through explicit tasks.

import { desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import { ApiRequestError, errorCodes } from '../../shared/errors.js';
import {
  batchPolicySchema,
  checkRequestSchema,
  confirmRequestSchema,
  resourcePatchSchema,
  settingsPatchSchema,
  updateRequestSchema,
} from '../../shared/schemas.js';
import type { JobDTO, ResourceKind } from '../../shared/types.js';
import type { Db } from '../db/client.js';
import type { UpdateJobRow } from '../db/schema.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { normalizeReference } from '../integrations/registry/reference.js';
import { resourceToDTO } from '../modules/dto.js';
import { assertCronValid } from '../scheduler/cron-validate.js';

const BODY_LIMIT = 256 * 1024;

/** Same-origin write protection: Origin (when present) must match the public origin or Host. */
function originOk(c: Context, publicOrigin: string | null): boolean {
  const origin = c.req.header('Origin');
  if (origin == null) return true; // non-browser client behind Traefik auth
  const host = c.req.header('Host');
  const allowed = new Set<string>();
  if (publicOrigin != null) allowed.add(publicOrigin);
  if (host != null) {
    allowed.add(`https://${host}`);
    allowed.add(`http://${host}`);
  }
  return allowed.has(origin);
}

function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ApiRequestError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details ?? null } },
      err.status as never,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: errorCodes.validation,
          message: 'Input validation failed',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
      400 as never,
    );
  }
  const message = err instanceof Error ? err.message : 'internal error';
  return c.json({ error: { code: 'internal_error', message, details: null } }, 500 as never);
}

export function createApi(deps: Deps): Hono {
  const api = new Hono();
  const { db, settings, jobs, checker, sync, outbox, coolify } = deps;

  api.use(
    '/api/*',
    bodyLimit({
      maxSize: BODY_LIMIT,
      onError: (c) =>
        c.json(
          { error: { code: errorCodes.validation, message: 'Request body too large' } },
          413 as never,
        ),
    }),
  );

  // --- health / overview -------------------------------------------------------

  api.get('/api/health', (c) => {
    return c.json({ ok: true, time: new Date().toISOString() });
  });

  api.get('/api/overview', async (c) => {
    try {
      const active = db.select().from(resources).where(eq(resources.status, 'active')).all();
      const tracks = db.select().from(imageTracks).all();
      const jobs = db.select().from(updateJobs).orderBy(desc(updateJobs.id)).all();
      let candidates = 0;
      for (const t of tracks) {
        if (
          t.configuredDigest != null &&
          t.observedDigest != null &&
          t.observedDigest !== t.configuredDigest
        ) {
          candidates += 1;
        }
      }
      const failures = jobs.filter((j) =>
        ['failed', 'unknown_submit', 'conflict'].includes(j.status),
      ).length;
      const pendingConfirmations = jobs.filter((j) => j.stage === 'awaiting_confirmation').length;
      const managed = active.filter(
        (r) => r.policy !== 'ignore' && !r.excludedInfra && r.kind !== 'compose_service',
      ).length;
      return c.json({
        resourcesTotal: active.length,
        resourcesManaged: managed,
        candidates,
        failures,
        pendingConfirmations,
        lastSyncAt: iso(settings.getMeta<number>('lastSyncAt')),
        lastCheckAt: iso(settings.getMeta<number>('lastCheckAt')),
        globalPaused: settings.get().globalPaused,
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // --- resources -----------------------------------------------------------------

  api.get('/api/resources', (c) => {
    try {
      const kind = c.req.query('kind');
      const policy = c.req.query('policy');
      const status = c.req.query('status') ?? 'active';
      const rows = db.select().from(resources).orderBy(resources.kind, resources.name).all();
      const tracks = db.select().from(imageTracks).all();
      const trackByResource = new Map(tracks.map((t) => [t.resourceId, t]));
      const jobs = db.select().from(updateJobs).orderBy(desc(updateJobs.id)).all();
      const latestJobByResource = new Map<number, (typeof jobs)[number]>();
      const awaitingByResource = new Map<number, (typeof jobs)[number]>();
      for (const j of jobs) {
        if (!latestJobByResource.has(j.resourceId)) latestJobByResource.set(j.resourceId, j);
        if (j.stage === 'awaiting_confirmation' && !awaitingByResource.has(j.resourceId)) {
          awaitingByResource.set(j.resourceId, j);
        }
      }
      const parentNames = new Map(rows.map((r) => [r.id, r.name]));
      const parentUuids = new Map(rows.map((r) => [r.id, r.coolifyUuid]));
      const dtos = rows
        .filter((r) => (status === 'all' ? true : r.status === status))
        .filter((r) => (kind == null ? true : r.kind === kind))
        .filter((r) => (policy == null ? true : r.policy === policy))
        .map((r) => {
          const dto = resourceToDTO(
            r,
            trackByResource.get(r.id) ?? null,
            latestJobByResource.get(r.id) ?? null,
            awaitingByResource.get(r.id) ?? null,
          );
          dto.parentName = r.parentId != null ? (parentNames.get(r.parentId) ?? null) : null;
          dto.parentCoolifyUuid = r.parentId != null ? (parentUuids.get(r.parentId) ?? null) : null;
          return dto;
        });
      return c.json({ resources: dtos });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.get('/api/resources/:id', (c) => {
    try {
      const id = Number.parseInt(c.req.param('id'), 10);
      const resource = db.select().from(resources).where(eq(resources.id, id)).get();
      if (resource == null)
        throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
      const track =
        db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get() ?? null;
      const jobRows = db
        .select()
        .from(updateJobs)
        .where(eq(updateJobs.resourceId, id))
        .orderBy(desc(updateJobs.id))
        .all();
      const awaiting = jobRows.find((j) => j.stage === 'awaiting_confirmation') ?? null;
      const dto = resourceToDTO(resource, track, jobRows[0] ?? null, awaiting);
      if (resource.parentId != null) {
        const parent = db.select().from(resources).where(eq(resources.id, resource.parentId)).get();
        dto.parentName = parent?.name ?? null;
        dto.parentCoolifyUuid = parent?.coolifyUuid ?? null;
      }
      const jobDTOs = jobRows.slice(0, 50).map((j) => jobToDTO(j, resource.name, resource.kind));
      return c.json({ resource: dto, jobs: jobDTOs });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.patch('/api/resources/:id', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const input = resourcePatchSchema.parse(await c.req.json());
      const resource = db.select().from(resources).where(eq(resources.id, id)).get();
      if (resource == null)
        throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
      const track = db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
      const now = Date.now();

      if (input.policy != null) {
        db.update(resources)
          .set({ policy: input.policy, updatedAt: now })
          .where(eq(resources.id, id))
          .run();
      }
      if (input.checkCron !== undefined) {
        // 空串 = 恢复全局默认；非法表达式用当前时区校验后拒绝。
        const cronExpr = input.checkCron === '' ? null : input.checkCron;
        if (cronExpr != null) {
          try {
            assertCronValid(cronExpr, settings.get().cronTimezone);
          } catch {
            throw new ApiRequestError(errorCodes.validation, 'Invalid cron expression', 400);
          }
        }
        db.update(resources)
          .set({ checkCron: cronExpr, updatedAt: now })
          .where(eq(resources.id, id))
          .run();
        deps.applyResourceSchedules?.();
      }
      if (
        track != null &&
        (input.sourceTag != null || input.sourceRegistry != null || input.sourceRepository != null)
      ) {
        // Source edits re-point the upstream channel; require full tag + validate parse.
        const registry = input.sourceRegistry ?? track.sourceRegistry;
        const repository = input.sourceRepository ?? track.sourceRepository;
        const tag = input.sourceTag ?? (track.sourceTag === '' ? null : track.sourceTag);
        if (tag == null)
          throw new ApiRequestError(errorCodes.validation, 'Tracking tag must not be empty', 400);
        const probe = normalizeReference(`${registry}/${repository}:${tag}`);
        db.update(imageTracks)
          .set({
            sourceRegistry: probe.registry,
            sourceRepository: probe.repository,
            sourceTag: tag,
            trackSource: 'user',
            // New channel: prior observations belong to the old stream.
            observedDigest: null,
            observedAt: null,
            observedError: null,
            platformManifestDigest: null,
            updatedAt: now,
          })
          .where(eq(imageTracks.id, track.id))
          .run();
      }
      if (input.targetPlatform !== undefined && track != null) {
        db.update(imageTracks)
          .set({
            targetPlatform: input.targetPlatform,
            platformSource: input.targetPlatform == null ? null : 'manual',
            updatedAt: now,
          })
          .where(eq(imageTracks.id, track.id))
          .run();
      }
      // Unblocking is explicit: user re-acknowledges the current state.
      if (
        resource.blockedReason === 'external_change' &&
        (input.sourceTag != null || input.sourceRepository != null || input.sourceRegistry != null)
      ) {
        db.update(resources)
          .set({ blockedReason: null, updatedAt: now })
          .where(eq(resources.id, id))
          .run();
      }
      const updated = db.select().from(resources).where(eq(resources.id, id)).get();
      const updatedTrack =
        db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get() ?? null;
      if (updated == null)
        throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
      return c.json({ resource: resourceToDTO(updated, updatedTrack, null, null) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/resources/batch-policy', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const input = batchPolicySchema.parse(await c.req.json());
      const now = Date.now();
      for (const id of input.resourceIds) {
        db.update(resources)
          .set({ policy: input.policy, updatedAt: now })
          .where(eq(resources.id, id))
          .run();
      }
      return c.json({ updated: input.resourceIds.length });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/resources/:id/resync', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const result = await sync.run();
      deps.applyResourceSchedules?.();
      return c.json({ ok: true, sync: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // --- checks / preview / update ------------------------------------------------

  api.post('/api/resources/:id/check', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const result = await checker.checkResource(id, 'manual');
      return c.json({ check: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // Latest Coolify deployment completion time (applications only; services
  // lack a per-resource deployment endpoint in v4.3.23).
  api.get('/api/resources/:id/deploy-time', async (c) => {
    try {
      const id = Number.parseInt(c.req.param('id'), 10);
      const resource = db.select().from(resources).where(eq(resources.id, id)).get();
      if (resource == null || resource.kind !== 'application') {
        return c.json({ lastDeployedAt: null });
      }
      const deployments = await coolify.getDeploymentsForApplication(resource.coolifyUuid);
      const finished = deployments
        .map((d) => d.finished_at)
        .filter((t): t is string => t != null)
        .sort();
      const last = finished.at(-1) ?? null;
      return c.json({ lastDeployedAt: last });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/resources/:id/preview', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const resource = db.select().from(resources).where(eq(resources.id, id)).get();
      if (resource == null)
        throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
      const track = db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
      if (track == null) throw new ApiRequestError(errorCodes.blocked, 'No image track', 409);
      if (track.observedDigest == null) {
        throw new ApiRequestError(
          errorCodes.candidateUnknown,
          'No fresh observation; run a check first',
          409,
        );
      }
      if (track.configuredDigest != null && track.observedDigest === track.configuredDigest) {
        return c.json({ preview: null, message: '配置已匹配上游，没有候选更新' });
      }
      const token = jobs.issuePreviewToken(id, track.observedDigest);
      const impact =
        resource.kind === 'service_application'
          ? {
              kind: 'compose_child' as const,
              parentName: parentName(db, resource.parentId),
              note: '定向部署；Coolify 仅返回 queued，提交后需人工确认',
            }
          : {
              kind: 'application' as const,
              parentName: null,
              note: 'PATCH 仅修改镜像字段；部署结果按 deployment UUID 确认',
            };
      return c.json({
        preview: {
          candidateDigest: track.observedDigest,
          candidateReference: track.sourceRepositoryAuthored
            ? `${track.sourceRepositoryAuthored}@${track.observedDigest}`
            : `${track.sourceRepository}:${track.observedDigest}`,
          observedAt: iso(track.observedAt),
          referenceKind: track.observedReferenceKind,
          previewToken: token,
          impact,
        },
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/resources/:id/update', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const input = updateRequestSchema.parse(await c.req.json());
      let candidateDigest = input.candidateDigest;
      let previewToken = input.previewToken;
      if (input.skipPreview === true) {
        // Server-side preview: the latest fresh observation becomes the candidate.
        const track = db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
        if (track == null) throw new ApiRequestError(errorCodes.blocked, 'No image track', 409);
        if (track.observedDigest == null) {
          throw new ApiRequestError(
            errorCodes.candidateUnknown,
            'No fresh observation; run a check first',
            409,
          );
        }
        if (track.configuredDigest != null && track.observedDigest === track.configuredDigest) {
          return c.json({ skipped: true, message: '无更新' });
        }
        candidateDigest = track.observedDigest;
        previewToken = jobs.issuePreviewToken(id, track.observedDigest);
      }
      if (candidateDigest == null || previewToken == null) {
        throw new ApiRequestError(errorCodes.validation, 'Invalid update request', 400);
      }
      const job = jobs.createManualJob(id, candidateDigest, previewToken);
      return c.json(
        { job: jobToDTO(job, resourceLabel(db, id), resourceKind(db, id)) },
        202 as never,
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // --- jobs -----------------------------------------------------------------------

  api.get('/api/jobs', (c) => {
    try {
      const statusParam = c.req.query('status');
      const statuses = statusParam == null || statusParam === 'all' ? [] : statusParam.split(',');
      const rows = jobs.listByStatus(statuses);
      const resRows = db.select().from(resources).all();
      const nameById = new Map(resRows.map((r) => [r.id, r.name]));
      const kindById = new Map(resRows.map((r) => [r.id, r.kind]));
      return c.json({
        jobs: rows.map((j) =>
          jobToDTO(
            j,
            nameById.get(j.resourceId) ?? `#${j.resourceId}`,
            kindById.get(j.resourceId) ?? 'application',
          ),
        ),
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/jobs/:id/retry', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const job = jobs.retryJob(id);
      return c.json({
        job: jobToDTO(job, resourceLabel(db, job.resourceId), resourceKind(db, job.resourceId)),
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/jobs/:id/confirm', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const input = confirmRequestSchema.parse(await c.req.json());
      const job = jobs.confirmSubmission(id, input.digest);
      return c.json({
        job: jobToDTO(job, resourceLabel(db, job.resourceId), resourceKind(db, job.resourceId)),
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // --- notifications -----------------------------------------------------------

  api.get('/api/notifications', (c) => {
    try {
      const rows = db
        .select()
        .from(notificationOutbox)
        .orderBy(desc(notificationOutbox.id))
        .limit(100)
        .all();
      const resRows = db.select().from(resources).all();
      const nameById = new Map(resRows.map((r) => [r.id, r.name]));
      return c.json({
        notifications: rows.map((n) => ({
          id: n.id,
          eventType: n.eventType,
          resourceId: n.resourceId,
          resourceName: n.resourceId != null ? (nameById.get(n.resourceId) ?? null) : null,
          status: n.status,
          attempts: n.attempts,
          title: n.title,
          body: n.body,
          lastError: n.lastError,
          createdAt: iso(n.createdAt) ?? '',
          sentAt: iso(n.sentAt),
        })),
        appriseConfigured: deps.apprise != null,
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/notifications/:id/redeliver', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = Number.parseInt(c.req.param('id'), 10);
      const ok = await outbox.redeliver(id);
      return c.json({ ok });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/notifications/test', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      if (deps.apprise == null) {
        throw new ApiRequestError(errorCodes.appriseError, 'Apprise API is not configured', 409);
      }
      const result = await deps.apprise.test();
      settings.patch({
        appriseLastTest: {
          ok: result.ok,
          at: Date.now(),
          error: result.ok ? null : result.message,
        },
      });
      if (!result.ok) {
        throw new ApiRequestError(errorCodes.appriseError, result.message, 502);
      }
      return c.json({ ok: true });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // --- settings / system ----------------------------------------------------------

  api.get('/api/settings', (c) => {
    try {
      const s = settings.get();
      const probe = settings.getMeta<{ ok: boolean; version: string | null; at: number }>(
        'coolifyProbe',
      );
      return c.json({
        syncCron: s.syncCron,
        checkCron: s.checkCron,
        cronTimezone: s.cronTimezone,
        globalPaused: s.globalPaused,
        deployConcurrency: deps.cfg.deployConcurrency,
        coolifyBaseUrlHost: hostOf(deps.cfg.coolifyBaseUrl),
        coolifyConnected: probe?.ok ?? null,
        coolifyVersion: probe?.version ?? null,
        apprise: {
          configured: deps.apprise != null,
          apiUrlHost: deps.cfg.apprise.apiUrl != null ? hostOf(deps.cfg.apprise.apiUrl) : null,
          configKeyPresent: deps.cfg.apprise.configKey != null,
          tag: deps.cfg.apprise.tag,
          authConfigured: deps.cfg.apprise.password != null || deps.cfg.apprise.user != null,
          lastTestOk: s.appriseLastTest?.ok ?? null,
          lastTestAt: s.appriseLastTest != null ? iso(s.appriseLastTest.at) : null,
          lastTestError: s.appriseLastTest?.error ?? null,
        },
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.patch('/api/settings', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const input = settingsPatchSchema.parse(await c.req.json());
      // 持久化前用 Croner 校验全部生效表达式（含时区变更后的旧值），
      // 避免坏值落库后 scheduler.start() 抛错造成重启崩溃循环。
      if (input.syncCron != null || input.checkCron != null || input.cronTimezone != null) {
        const cur = settings.get();
        const tz = input.cronTimezone ?? cur.cronTimezone;
        const syncCron = input.syncCron ?? cur.syncCron;
        const checkCron = input.checkCron ?? cur.checkCron;
        try {
          assertCronValid(syncCron, tz);
          assertCronValid(checkCron, tz);
        } catch {
          throw new ApiRequestError(
            errorCodes.validation,
            'Invalid cron expression or timezone',
            400,
          );
        }
      }
      const next = settings.patch(input);
      if (input.syncCron != null || input.checkCron != null || input.cronTimezone != null) {
        deps.applySchedule?.();
        deps.applyResourceSchedules?.();
      }
      return c.json({ settings: { ...next, appriseLastTest: undefined } });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/sync', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const result = await sync.run();
      deps.applyResourceSchedules?.();
      return c.json({ ok: true, sync: result });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/check', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const parsed = checkRequestSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success)
        throw new ApiRequestError(errorCodes.validation, 'Invalid check request', 400);
      const results =
        parsed.data.resourceIds == null
          ? await checker.checkAll('manual')
          : await checker.checkMany(parsed.data.resourceIds, 'manual');
      return c.json({ ok: true, checked: results.length });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/coolify/probe', async (c) => {
    try {
      const result = await coolify.probe();
      settings.setMeta('coolifyProbe', { ...result, at: Date.now() });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return api;
}

// --- helpers -----------------------------------------------------------------

function iso(ms: number | null | undefined): string | null {
  return ms != null ? new Date(ms).toISOString() : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function parentName(db: Db, parentId: number | null): string | null {
  if (parentId == null) return null;
  const row = db.select().from(resources).where(eq(resources.id, parentId)).get();
  return row?.name ?? null;
}

function resourceLabel(db: Db, id: number): string {
  const row = db.select().from(resources).where(eq(resources.id, id)).get();
  return row?.name ?? `#${id}`;
}

function resourceKind(db: Db, id: number): ResourceKind {
  const row = db.select().from(resources).where(eq(resources.id, id)).get();
  return row?.kind ?? 'application';
}

function jobToDTO(job: UpdateJobRow, resourceName: string, resourceKind_: ResourceKind): JobDTO {
  return {
    id: job.id,
    resourceId: job.resourceId,
    resourceName,
    resourceKind: resourceKind_,
    kind: job.kind,
    trigger: job.trigger,
    candidateDigest: job.candidateDigest,
    candidateReference: job.candidateReference,
    priorDigest: job.priorDigest,
    priorReference: job.priorReference,
    status: job.status,
    stage: job.stage,
    deploymentUuid: job.deploymentUuid,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    attempts: job.attempts,
    log: job.log as JobDTO['log'],
    createdAt: iso(job.createdAt) ?? '',
    finishedAt: iso(job.finishedAt),
  };
}
