// SQLite schema. Network calls never happen inside transactions over these tables.
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = () => Date.now();

/** Epoch-ms timestamps as integer; SQLite has no native datetime type. */

export const resources = sqliteTable(
  'resources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', {
      enum: ['application', 'compose_service', 'service_application'],
    }).notNull(),
    coolifyUuid: text('coolify_uuid').notNull(),
    parentId: integer('parent_id'),
    name: text('name').notNull(),
    composeServiceName: text('compose_service_name'),
    serverUuid: text('server_uuid'),
    serverName: text('server_name'),
    projectName: text('project_name'),
    environmentName: text('environment_name'),
    projectUuid: text('project_uuid'),
    /** 资源级检查调度覆盖；空 = 使用全局默认 cron。 */
    checkCron: text('check_cron'),
    environmentUuid: text('environment_uuid'),
    domains: text('domains'),
    /** Raw image string as last observed in Coolify (reference, not proof). */
    currentImage: text('current_image'),
    /** Hash over update-relevant config fields at last sync. */
    configFingerprint: text('config_fingerprint'),
    policy: text('policy', { enum: ['ignore', 'notify', 'manual', 'auto'] })
      .notNull()
      .default('ignore'),
    status: text('status', { enum: ['active', 'removed'] })
      .notNull()
      .default('active'),
    blockedReason: text('blocked_reason'),
    /** Infrastructure exclusion (UUID list or unsupported type). */
    excludedInfra: integer('excluded_infra', { mode: 'boolean' }).notNull().default(false),
    /** true when the underlying Coolify resource reports stopped. */
    isStopped: integer('is_stopped', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().$defaultFn(now),
    updatedAt: integer('updated_at').notNull().$defaultFn(now),
    lastSyncedAt: integer('last_synced_at'),
  },
  (t) => [
    uniqueIndex('resources_kind_uuid_uq').on(t.kind, t.coolifyUuid),
    index('resources_parent_idx').on(t.parentId),
    index('resources_policy_idx').on(t.policy),
    index('resources_status_idx').on(t.status),
  ],
);

/** One track per image-bearing resource: upstream source + digest bookkeeping. */
export const imageTracks = sqliteTable(
  'image_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    resourceId: integer('resource_id')
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    sourceRegistry: text('source_registry').notNull(),
    sourceRepository: text('source_repository').notNull(),
    /** Repository path exactly as authored in Coolify (compose minimal-diff writes). */
    sourceRepositoryAuthored: text('source_repository_authored').notNull(),
    sourceTag: text('source_tag').notNull(),
    targetPlatform: text('target_platform'),
    /** compose | coolify_node | server_default | manual */
    platformSource: text('platform_source'),
    /** Full reference as currently configured in Coolify (after last sync/patch). */
    configuredReference: text('configured_reference'),
    configuredDigest: text('configured_digest'),
    configuredReferenceKind: text('configured_reference_kind', {
      enum: ['index', 'manifest'],
    }),
    /** Latest registry observation for the tracked tag. */
    observedDigest: text('observed_digest'),
    observedAt: integer('observed_at'),
    /** Upstream tag's latest push time (Docker Hub metadata; null when unknown). */
    upstreamTagUpdatedAt: integer('upstream_tag_updated_at'),
    observedReferenceKind: text('observed_reference_kind', { enum: ['index', 'manifest'] }),
    platformManifestDigest: text('platform_manifest_digest'),
    observedError: text('observed_error'),
    /** Evidence-bound success: digest only advances with deployable proof. */
    lastSuccessfulDigest: text('last_successful_digest'),
    lastSuccessAt: integer('last_success_at'),
    lastSuccessDeploymentUuid: text('last_success_deployment_uuid'),
    /** deployment = completion evidence; manual = user-attested (compose limitation). */
    lastSuccessSource: text('last_success_source', { enum: ['deployment', 'manual'] }),
    pinnedAt: integer('pinned_at'),
    /** discovered | user */
    trackSource: text('track_source', { enum: ['discovered', 'user'] })
      .notNull()
      .default('discovered'),
    createdAt: integer('created_at').notNull().$defaultFn(now),
    updatedAt: integer('updated_at').notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex('image_tracks_resource_uq').on(t.resourceId)],
);

/** Update jobs: the only path through which Coolify targets are modified. */
export const updateJobs = sqliteTable(
  'update_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    resourceId: integer('resource_id')
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['initial_pin', 'update'] }).notNull(),
    trigger: text('trigger', { enum: ['manual', 'auto'] }).notNull(),
    candidateDigest: text('candidate_digest').notNull(),
    /** Full image reference (with digest) to be written for this job. */
    candidateReference: text('candidate_reference').notNull(),
    priorDigest: text('prior_digest'),
    priorReference: text('prior_reference'),
    /** Fingerprint expected at write time; mismatch => conflict. */
    expectedFingerprint: text('expected_fingerprint'),
    status: text('status', {
      enum: ['pending', 'running', 'success', 'failed', 'conflict', 'unknown_submit', 'blocked'],
    })
      .notNull()
      .default('pending'),
    stage: text('stage', {
      enum: [
        'queued',
        'revalidated',
        'patching',
        'patched',
        'deploy_submitted',
        'awaiting_confirmation',
        'done',
      ],
    })
      .notNull()
      .default('queued'),
    deploymentUuid: text('deployment_uuid'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    /** Progress entries; whitelist only — no raw external payloads. */
    log: text('log', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
    /** Manual confirmation for compose submissions without completion evidence. */
    confirmedManually: integer('confirmed_manually', { mode: 'boolean' }).notNull().default(false),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: integer('created_at').notNull().$defaultFn(now),
    updatedAt: integer('updated_at').notNull().$defaultFn(now),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    uniqueIndex('update_jobs_idem_uq').on(t.idempotencyKey),
    index('update_jobs_resource_idx').on(t.resourceId),
    index('update_jobs_status_idx').on(t.status),
  ],
);

/** Durable notification queue with dedupe and retry bookkeeping. */
export const notificationOutbox = sqliteTable(
  'notification_outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventType: text('event_type', {
      enum: [
        'candidate_found',
        'upstream_changed',
        'update_success',
        'update_failed',
        'submit_unknown',
      ],
    }).notNull(),
    resourceId: integer('resource_id').references(() => resources.id, { onDelete: 'cascade' }),
    /** Candidate round + resource + digest + event type identity. */
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ['pending', 'sent', 'failed', 'paused'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at').notNull().$defaultFn(now),
    lastError: text('last_error'),
    createdAt: integer('created_at').notNull().$defaultFn(now),
    sentAt: integer('sent_at'),
  },
  (t) => [
    uniqueIndex('notification_dedupe_uq').on(t.dedupeKey),
    index('notification_status_idx').on(t.status, t.nextAttemptAt),
  ],
);

/** Key/value settings: schedules, server platform, apprise test state, sync bookkeeping. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull().$defaultFn(now),
});

export type ResourceRow = typeof resources.$inferSelect;
export type ImageTrackRow = typeof imageTracks.$inferSelect;
export type UpdateJobRow = typeof updateJobs.$inferSelect;
export type NotificationRow = typeof notificationOutbox.$inferSelect;
