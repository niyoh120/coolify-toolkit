// REST API: resources, checks, previews, updates, jobs, notifications, settings.
// Reads hit the local projection; external effects run through explicit tasks.

import { desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import { ApiRequestError, errorCodes } from '../../shared/errors.js';
import {
  adoptConfirmRequestSchema,
  adoptPreviewRequestSchema,
  batchPolicySchema,
  checkRequestSchema,
  confirmRequestSchema,
  resourcePatchSchema,
  settingsPatchSchema,
  updateRequestSchema,
} from '../../shared/schemas.js';
import type { JobDTO, ResourceKind, SuccessSource } from '../../shared/types.js';
import type { Db } from '../db/client.js';
import type { UpdateJobRow } from '../db/schema.js';
import { imageTracks, notificationOutbox, resources, updateJobs } from '../db/schema.js';
import type { Deps } from '../deps.js';
import { normalizeReference } from '../integrations/registry/reference.js';
import { isAwaitingConfirmation, resourceToDTO } from '../modules/dto.js';
import {
  effectiveManagementGate,
  type ManagementGateCode,
} from '../modules/inventory/management-state.js';
import { parentRowOf } from '../modules/inventory/parent-row.js';
import {
  applicationDigestReference,
  clearedObservation,
  composeDigestReference,
} from '../modules/updates/image-state.js';
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

/**
 * 严格解析十进制正安全整数查询参数：缺省返回 null；空值、零、负数、小数、
 * 非数字、混合字符、超出安全整数范围均抛 400 验证错误。
 */
function parseIdQuery(value: string | undefined, name: string): number | null {
  if (value == null || value === '') {
    if (value === '') {
      throw new ApiRequestError(
        errorCodes.validation,
        `Query param ${name} must not be empty`,
        400,
      );
    }
    return null;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new ApiRequestError(
      errorCodes.validation,
      `Query param ${name} must be a positive integer`,
      400,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiRequestError(
      errorCodes.validation,
      `Query param ${name} must be a positive safe integer`,
      400,
    );
  }
  return parsed;
}

/** Strict decimal positive-integer path param; '1junk'/NaN → 400 (F12). */
function resourceIdParam(c: Context): number {
  const raw = c.req.param('id') ?? '';
  if (!/^[0-9]+$/.test(raw)) {
    throw new ApiRequestError(errorCodes.validation, 'Invalid resource id', 400);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiRequestError(errorCodes.validation, 'Invalid resource id', 400);
  }
  return parsed;
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
      // 候选只统计 active、已分类、未配置排除、无镜像问题的镜像资源；
      // ignore 的已观察候选保留既有语义（同样计入）。
      const candidateEligible = new Set(
        active
          .filter((r) => r.managementClassified && !r.excludedInfra && r.imageIssue == null)
          .map((r) => r.id),
      );
      let candidates = 0;
      for (const t of tracks) {
        if (!candidateEligible.has(t.resourceId)) continue;
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
      // 待自动检查：仅 active 等待中的 Compose 任务；终态残留 stage 的行排除。
      const pendingConfirmations = jobs.filter((j) => isAwaitingConfirmation(j)).length;
      // 受管 = 已分类、未配置排除、无镜像问题、非 compose_service 且非 ignore。
      const managed = active.filter(
        (r) =>
          r.managementClassified &&
          !r.excludedInfra &&
          r.imageIssue == null &&
          r.kind !== 'compose_service' &&
          r.policy !== 'ignore',
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
      // 重复 parent 参数按无效参数处理；缺省保持原有列表行为。
      // Hono 的 queries() 在参数完全缺失时返回 undefined，需兜底为空数组。
      const parentValues = c.req.queries('parent') ?? [];
      if (parentValues.length > 1) {
        throw new ApiRequestError(
          errorCodes.validation,
          'Query param parent must not be repeated',
          400,
        );
      }
      const parentId = parseIdQuery(parentValues[0], 'parent');
      const rows = db.select().from(resources).orderBy(resources.kind, resources.name).all();
      const tracks = db.select().from(imageTracks).all();
      const trackByResource = new Map(tracks.map((t) => [t.resourceId, t]));
      const jobs = db.select().from(updateJobs).orderBy(desc(updateJobs.id)).all();
      const latestJobByResource = new Map<number, (typeof jobs)[number]>();
      const awaitingByResource = new Map<number, (typeof jobs)[number]>();
      for (const j of jobs) {
        if (!latestJobByResource.has(j.resourceId)) latestJobByResource.set(j.resourceId, j);
        if (isAwaitingConfirmation(j) && !awaitingByResource.has(j.resourceId)) {
          awaitingByResource.set(j.resourceId, j);
        }
      }
      const parentNames = new Map(rows.map((r) => [r.id, r.name]));
      const parentUuids = new Map(rows.map((r) => [r.id, r.coolifyUuid]));
      const parentExcluded = new Map(rows.map((r) => [r.id, r.excludedInfra]));
      const dtos = rows
        .filter((r) => (status === 'all' ? true : r.status === status))
        .filter((r) => (kind == null ? true : r.kind === kind))
        .filter((r) => (policy == null ? true : r.policy === policy))
        .filter((r) => (parentId == null ? true : r.parentId === parentId))
        .map((r) => {
          const dto = resourceToDTO(
            r,
            trackByResource.get(r.id) ?? null,
            latestJobByResource.get(r.id) ?? null,
            awaitingByResource.get(r.id) ?? null,
            {
              excludedUuids: deps.cfg.excludedUuids,
              parentExcluded: r.parentId != null ? (parentExcluded.get(r.parentId) ?? null) : null,
            },
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
      const awaiting = jobRows.find((j) => isAwaitingConfirmation(j)) ?? null;
      const parentRow =
        resource.parentId != null
          ? (db.select().from(resources).where(eq(resources.id, resource.parentId)).get() ?? null)
          : null;
      const dto = resourceToDTO(resource, track, jobRows[0] ?? null, awaiting, {
        excludedUuids: deps.cfg.excludedUuids,
        parentExcluded: parentRow?.excludedInfra ?? null,
      });
      if (parentRow != null) {
        dto.parentName = parentRow.name;
        dto.parentCoolifyUuid = parentRow.coolifyUuid;
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
      // 统一资格守卫：待确认/配置排除/镜像问题（含父级继承）时，在任何写入
      // 之前拒绝 —— 覆盖策略、来源、平台、cron 全部字段。
      const parentRow = parentRowOf(db, resource);
      const gate = effectiveManagementGate(resource, parentRow, resource.currentImage);
      if (!gate.ok) {
        throw new ApiRequestError(errorCodes.blocked, gate.reason, 409, {
          code: gate.code,
        });
      }
      const track = db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get();
      const now = Date.now();
      const sourceChanged =
        input.sourceTag != null || input.sourceRegistry != null || input.sourceRepository != null;
      const platformChanged = input.targetPlatform !== undefined;
      // R5-F1: request-start revision snapshot for the in-transaction recheck.
      const expectedRevision = track?.trackingRevision ?? null;

      // F5: 校验全部先行（含 cron/来源解析/在途任务），恢复写入推迟到
      // 最终事务内 —— 任何校验失败都保持持久状态原值。
      if (input.checkCron !== undefined) {
        const cronExpr = input.checkCron === '' ? null : input.checkCron;
        if (cronExpr != null) {
          try {
            assertCronValid(cronExpr, settings.get().cronTimezone);
          } catch {
            throw new ApiRequestError(errorCodes.validation, 'Invalid cron expression', 400);
          }
        }
      }
      // 恢复读取（F5/F12）：网络 GET 在全部本地校验前执行（只读）；落库仍
      // 推迟到最终事务。live 引用同时用于「跟随新仓库」的跨仓例外判断。
      let recovery: Awaited<ReturnType<typeof deps.tracking.fetchExternalChangeLive>> = null;
      if (resource.blockedReason === 'external_change' && sourceChanged && track != null) {
        recovery = await deps.tracking.fetchExternalChangeLive(id);
        if (recovery == null) {
          throw new ApiRequestError(
            errorCodes.conflict,
            'Coolify 实时配置读取失败；保存未生效，稍后重试或使用「采纳当前镜像并更新」',
            409,
          );
        }
      }
      const recoveryLiveRef = recovery?.configuredReference ?? null;
      let recoveryLiveParsed: ReturnType<typeof normalizeReference> | null = null;
      if (recoveryLiveRef != null && recoveryLiveRef !== '') {
        try {
          recoveryLiveParsed = normalizeReference(recoveryLiveRef);
        } catch {
          recoveryLiveParsed = null;
        }
      }

      let plannedTag: string | null = null;
      let probe: ReturnType<typeof normalizeReference> | null = null;
      if (sourceChanged && track != null) {
        const registry = input.sourceRegistry ?? track.sourceRegistry;
        const repository = input.sourceRepository ?? track.sourceRepository;
        const tag = input.sourceTag ?? (track.sourceTag === '' ? null : track.sourceTag);
        if (tag == null)
          throw new ApiRequestError(errorCodes.validation, 'Tracking tag must not be empty', 400);
        probe = normalizeReference(`${registry}/${repository}:${tag}`);
        plannedTag = tag;
        // F12/F4: actively re-pointing the channel to a DIFFERENT repository
        // is image migration — rejected. Exception: external_change recovery
        // where the LIVE config already moved; then (a) an explicitly typed
        // repository must MATCH the live repository, (b) a tag-only save
        // follows the live repository. Typed mismatches are still 400.
        const recovering =
          resource.blockedReason === 'external_change' &&
          recoveryLiveRef != null &&
          recoveryLiveRef.trim() !== '';
        if (recovering && recoveryLiveParsed != null) {
          const typedRepo = input.sourceRegistry != null || input.sourceRepository != null;
          if (typedRepo) {
            const matchesLive =
              probe.registry === recoveryLiveParsed.registry &&
              probe.repository === recoveryLiveParsed.repository;
            if (!matchesLive) {
              throw new ApiRequestError(
                errorCodes.validation,
                '填写的仓库与 Coolify 当前配置的仓库不一致；请清空仓库字段跟随现场，或先在 Coolify 核对镜像',
                400,
              );
            }
          }
        } else {
          const sameRepo =
            probe.registry === track.sourceRegistry && probe.repository === track.sourceRepository;
          if (!sameRepo) {
            throw new ApiRequestError(
              errorCodes.validation,
              '更新来源指向与当前配置不同的仓库属于镜像迁移；请先在 Coolify 修改镜像，同步后用「采纳当前镜像并更新」',
              400,
            );
          }
        }
      }

      // 在途/未知提交任务在来源/平台变更时阻止（版本与基线被重写）。
      // R5-F7: 统一走 JobsService.assertExclusiveScope（含父级范围与归属）。
      if ((sourceChanged || platformChanged) && track != null) {
        deps.jobs.assertExclusiveScope(resource);
      }

      db.transaction((tx) => {
        // R5-F1/R6-F1: 事务内重读 resource+track，复核资格/恢复状态/任务范围。
        // 按字段区分前置条件：policy/cron 只要求资源资格；来源、平台、恢复
        // 涉及追踪账本时才要求 track 存在并做版本比较（Compose 父服务无
        // track，独立 policy/cron 保存必须继续可用）。
        const liveResource = tx.select().from(resources).where(eq(resources.id, id)).get();
        if (liveResource == null) {
          throw new ApiRequestError(errorCodes.blocked, 'Resource disappeared', 409);
        }
        // R6-F3: active 状态在事务内重验 —— recovery GET 等待期间资源可能
        // 已被移除。
        if (liveResource.status !== 'active') {
          throw new ApiRequestError(errorCodes.blocked, 'Resource is not active', 409);
        }
        const trackScoped = sourceChanged || platformChanged || recovery != null;
        // policy/cron saves never touch the ledger; track writes below are
        // gated on their own conditions, and trackScoped requires the row.
        // The guard binds the narrowed row for the three track writes below.
        const liveTrackOrNull =
          tx.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get() ?? null;
        if (trackScoped && liveTrackOrNull == null) {
          throw new ApiRequestError(errorCodes.blocked, 'No image track for this resource', 409);
        }
        // Track-scoped write helper: the guard above guarantees the row for
        // every branch that reaches here (recovery/source/platform all imply
        // trackScoped).
        const trackIdForWrite = (): number => {
          if (liveTrackOrNull == null) {
            throw new ApiRequestError(errorCodes.blocked, 'No image track', 409);
          }
          return liveTrackOrNull.id;
        };
        if (
          liveTrackOrNull != null &&
          expectedRevision != null &&
          liveTrackOrNull.trackingRevision !== expectedRevision
        ) {
          throw new ApiRequestError(
            errorCodes.conflict,
            '追踪配置在保存期间已变化（并发采纳/保存/重置）；请刷新后重试',
            409,
          );
        }
        const gateNow = effectiveManagementGate(
          liveResource,
          parentRowOf(tx, liveResource),
          liveResource.currentImage,
        );
        if (!gateNow.ok) {
          throw new ApiRequestError(errorCodes.blocked, gateNow.reason, 409, {
            code: gateNow.code,
          });
        }
        // 恢复状态必须仍然成立：等待期间阻塞被解除（如另一请求已完成采纳）
        // 时，恢复分支不再适用，拒绝以避免覆盖新基线。
        if (recovery != null && liveResource.blockedReason !== 'external_change') {
          throw new ApiRequestError(
            errorCodes.conflict,
            '外部修改状态在保存期间已解除；请刷新后核对，再做来源修改',
            409,
          );
        }

        let nextRevision = liveTrackOrNull?.trackingRevision ?? 0;
        if (input.policy != null) {
          tx.update(resources)
            .set({ policy: input.policy, updatedAt: now })
            .where(eq(resources.id, id))
            .run();
        }
        if (input.checkCron !== undefined) {
          tx.update(resources)
            .set({ checkCron: input.checkCron === '' ? null : input.checkCron, updatedAt: now })
            .where(eq(resources.id, id))
            .run();
        }
        if (recovery != null) {
          // 恢复：采纳现场为已确认基线并解除阻塞（事务内，原子）。
          nextRevision += 1;
          tx.update(imageTracks)
            .set({
              configuredReference: recovery.configuredReference,
              configuredDigest: recovery.configuredDigest,
              configuredReferenceKind: null,
              pinnedAt: null,
              trackingRevision: nextRevision,
              lastSuccessfulDigest: null,
              lastSuccessAt: null,
              lastSuccessDeploymentUuid: null,
              lastSuccessSource: null,
              updatedAt: now,
            })
            .where(eq(imageTracks.id, trackIdForWrite()))
            .run();
          tx.update(resources)
            .set({ blockedReason: null, updatedAt: now })
            .where(eq(resources.id, id))
            .run();
        }
        if (sourceChanged && probe != null && plannedTag != null) {
          // 渠道变更：保留已确认配置与真实成功证据，清旧渠道观察。
          // F12: 恢复路径且现场已换仓时，渠道跟随现场仓库（authored 同步维护）。
          let channelRef = probe;
          if (recovery != null) {
            try {
              const liveParsed = normalizeReference(recovery.configuredReference);
              channelRef = normalizeReference(
                `${liveParsed.registry}/${liveParsed.repository}:${plannedTag}`,
              );
            } catch {
              channelRef = probe;
            }
          }
          nextRevision += 1;
          tx.update(imageTracks)
            .set({
              sourceRegistry: channelRef.registry,
              sourceRepository: channelRef.repository,
              sourceRepositoryAuthored: channelRef.authoredPath,
              sourceTag: plannedTag,
              trackSource: 'user',
              trackingRevision: nextRevision,
              ...clearedObservation(),
              updatedAt: now,
            })
            .where(eq(imageTracks.id, trackIdForWrite()))
            .run();
        }
        if (platformChanged) {
          // 平台变更（F13）：平台相关观察全部失效并递增版本。
          nextRevision += 1;
          tx.update(imageTracks)
            .set({
              targetPlatform: input.targetPlatform,
              platformSource: input.targetPlatform == null ? null : 'manual',
              trackingRevision: nextRevision,
              ...clearedObservation(),
              updatedAt: now,
            })
            .where(eq(imageTracks.id, trackIdForWrite()))
            .run();
        }
        // 非来源修改的外部修改解除入口已移除：保存 cron/策略不再解除阻塞。
      });

      if (input.checkCron !== undefined) deps.applyResourceSchedules?.();
      const updated = db.select().from(resources).where(eq(resources.id, id)).get();
      const updatedTrack =
        db.select().from(imageTracks).where(eq(imageTracks.resourceId, id)).get() ?? null;
      if (updated == null)
        throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
      return c.json({
        resource: resourceToDTO(updated, updatedTrack, null, null, {
          excludedUuids: deps.cfg.excludedUuids,
          parentExcluded: parentRow?.excludedInfra ?? null,
        }),
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  api.post('/api/resources/batch-policy', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const input = batchPolicySchema.parse(await c.req.json());
      // ID 去重：重复提交同一资源只更新一次。
      const ids = [...new Set(input.resourceIds)];
      const now = Date.now();
      // 事务内统一读取与预检：任何目标不存在或资格不满足时整批拒绝，
      // 策略与更新时间全保持原值；成功时 updated 为实际唯一目标数。
      const updated = db.transaction((tx) => {
        const targets: (typeof resources.$inferSelect)[] = [];
        for (const id of ids) {
          const row = tx.select().from(resources).where(eq(resources.id, id)).get();
          if (row == null) {
            throw new ApiRequestError(errorCodes.notFound, `Resource #${id} not found`, 404, {
              resourceId: id,
            });
          }
          targets.push(row);
        }
        type RejectedEntry = {
          resourceId: number;
          name: string;
          code: 'removed' | ManagementGateCode;
          reason: string;
        };
        const rejected = targets.flatMap<RejectedEntry>((row) => {
          const gate = effectiveManagementGate(row, parentRowOf(tx, row), row.currentImage);
          if (row.status !== 'active') {
            return [
              {
                resourceId: row.id,
                name: row.name,
                code: 'removed' as const,
                reason: '资源已移除',
              },
            ];
          }
          if (!gate.ok) {
            return [{ resourceId: row.id, name: row.name, code: gate.code, reason: gate.reason }];
          }
          return [];
        });
        if (rejected.length > 0) {
          throw new ApiRequestError(
            errorCodes.blocked,
            '整批未保存：部分资源不满足策略修改条件',
            409,
            {
              rejected,
            },
          );
        }
        for (const row of targets) {
          tx.update(resources)
            .set({ policy: input.policy, updatedAt: now })
            .where(eq(resources.id, row.id))
            .run();
        }
        return targets.length;
      });
      return c.json({ updated });
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
      // 资格校验在发 token 之前：待确认/排除/镜像问题时拒绝预览。
      const gate = effectiveManagementGate(
        resource,
        parentRowOf(db, resource),
        resource.currentImage,
      );
      if (!gate.ok) throw new ApiRequestError(errorCodes.blocked, gate.reason, 409);
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
      const candidateReference =
        resource.kind === 'service_application'
          ? composeDigestReference(track.sourceRepositoryAuthored, track.observedDigest)
          : applicationDigestReference(
              track.sourceRegistry,
              track.sourceRepository,
              track.observedDigest,
            );
      const token = jobs.issuePreviewToken(
        id,
        track.observedDigest,
        track.trackingRevision,
        candidateReference,
      );
      const impact =
        resource.kind === 'service_application'
          ? {
              kind: 'compose_child' as const,
              parentName: parentName(db, resource.parentId),
              note: '定向部署；提交约 60 秒后自动检查一次运行状态并确认，也可在服务列表提前「确认更新完成」',
            }
          : {
              kind: 'application' as const,
              parentName: null,
              note: 'PATCH 仅修改镜像字段；部署结果按 deployment UUID 确认',
            };
      return c.json({
        preview: {
          candidateDigest: track.observedDigest,
          candidateReference:
            resource.kind === 'service_application'
              ? composeDigestReference(track.sourceRepositoryAuthored, track.observedDigest)
              : applicationDigestReference(
                  track.sourceRegistry,
                  track.sourceRepository,
                  track.observedDigest,
                ),
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

  // --- tracking recovery: adopt preview / confirm / reset -------------------------

  /**
   * Adopt preview: read-only live snapshot + channel resolution + upstream
   * digest for the new channel; issues a short-lived adopt token.
   */
  api.post('/api/resources/:id/adopt-preview', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = resourceIdParam(c);
      const body = await c.req.json().catch(() => ({}));
      const input = adoptPreviewRequestSchema.parse(body ?? {});
      const preview = await deps.tracking.adoptPreview(id, input.sourceTag ?? null);
      return c.json({ preview });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Adopt confirm: consume the token, flip tracking state, create one task. */
  api.post('/api/resources/:id/adopt', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = resourceIdParam(c);
      const input = adoptConfirmRequestSchema.parse(await c.req.json());
      const result = await deps.tracking.adoptConfirm(id, input.previewToken);
      deps.applyResourceSchedules?.();
      const label = resourceLabel(db, id);
      const kind = resourceKind(db, id);
      return c.json({
        status: result.status,
        message: result.message,
        job: result.job != null ? jobToDTO(result.job as UpdateJobRow, label, kind) : null,
        resource: result.resource, // tracking service owns the DTO mapping
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /** Reset tracking and ignore: local-only ledger clear + policy flip. */
  api.post('/api/resources/:id/reset-tracking', async (c) => {
    try {
      if (!originOk(c, deps.cfg.publicOrigin))
        throw new ApiRequestError(errorCodes.validation, 'Cross-origin write rejected', 403);
      const id = resourceIdParam(c);
      const result = deps.tracking.resetTracking(id);
      deps.applyResourceSchedules?.();
      return c.json(result);
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
        // 资格校验在发 token 或返回无候选之前：避免误报「无更新」。
        const resource = db.select().from(resources).where(eq(resources.id, id)).get();
        if (resource == null)
          throw new ApiRequestError(errorCodes.notFound, 'Resource not found', 404);
        const gate = effectiveManagementGate(
          resource,
          parentRowOf(db, resource),
          resource.currentImage,
        );
        if (!gate.ok) throw new ApiRequestError(errorCodes.blocked, gate.reason, 409);
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
        const skipRef =
          resource.kind === 'service_application'
            ? composeDigestReference(track.sourceRepositoryAuthored, track.observedDigest)
            : applicationDigestReference(
                track.sourceRegistry,
                track.sourceRepository,
                track.observedDigest,
              );
        previewToken = jobs.issuePreviewToken(
          id,
          track.observedDigest,
          track.trackingRevision,
          skipRef,
        );
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
    confirmationDueAt: iso(job.confirmationDueAt),
    successSource: deriveSuccessSource(job, resourceKind_),
  };
}

/**
 * Evidence source derived from the success state: historical compose successes
 * stay manual, application successes stay deployment; only the new delayed
 * runtime check yields runtime_observation (confirmedManually stays false).
 */
function deriveSuccessSource(job: UpdateJobRow, kind: ResourceKind): SuccessSource | null {
  if (job.status !== 'success') return null;
  if (job.confirmedManually) return 'manual';
  if (kind === 'service_application') return 'runtime_observation';
  return 'deployment';
}
