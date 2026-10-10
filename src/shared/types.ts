// Domain types shared between server and web.
// Status enums here are the single source of truth for UI rendering.

export type ResourceKind = 'application' | 'compose_service' | 'service_application';

export type Policy = 'ignore' | 'notify' | 'manual' | 'auto';

export type ResourceStatus = 'active' | 'removed';

/** Reasons an object's automatic updates are paused. */
export type BlockReason =
  | 'external_change' // user edited the image outside toolkit expectations
  | 'platform_missing' // no verifiable target platform
  | 'excluded' // matches infra exclusion list or unsupported type
  | 'compose_confirmation_pending' // compose deployment lacks completion evidence
  | 'stopped' // resource is stopped; manual start required
  | 'update_failed' // last update failed; keep target config, require user action
  | null;

/** Kind of the top-level reference a digest was computed from. */
export type ReferenceKind = 'index' | 'manifest';

export type CheckOutcome = 'matching' | 'candidate' | 'unfixed' | 'error' | 'blocked';

export type JobStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'conflict'
  | 'unknown_submit'
  | 'blocked';

export type JobStage =
  | 'queued'
  | 'revalidated'
  | 'patching'
  | 'patched'
  | 'deploy_submitted'
  | 'awaiting_confirmation'
  | 'done';

export type JobKind = 'initial_pin' | 'update';

export type JobTrigger = 'manual' | 'auto';

export type NotificationEventType =
  | 'candidate_found'
  | 'upstream_changed'
  | 'update_success'
  | 'update_failed'
  | 'submit_unknown';

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'paused';

/** Deployment evidence state, tracked separately from config state. */
export type DeployState =
  | 'unknown' // never deployed via toolkit / runtime version unverifiable
  | 'deploying'
  | 'success'
  | 'failed'
  | 'pending_confirmation'; // compose: submitted, no completion evidence available

/** Effective combined view for one image track (derived, not stored). */
export interface TrackView {
  configuredMatchesUpstream: boolean | null; // null = unknown (not yet observed)
  hasCandidate: boolean;
  checkOutcome: CheckOutcome;
  deployState: DeployState;
}

export interface ResourceDTO {
  id: number;
  kind: ResourceKind;
  coolifyUuid: string;
  parentResourceId: number | null;
  parentName: string | null;
  name: string;
  composeServiceName: string | null;
  serverName: string | null;
  projectUuid: string | null;
  checkCron: string | null;
  lastDeployedAt: string | null;
  environmentUuid: string | null;
  parentCoolifyUuid: string | null;
  projectName: string | null;
  environmentName: string | null;
  domains: string | null;
  currentImage: string | null;
  policy: Policy;
  status: ResourceStatus;
  blockedReason: BlockReason;
  excludedInfra: boolean;
  isStopped: boolean;
  lastSyncedAt: string | null;
  updatedAt: string | null;
  /** null when the resource cannot carry a track (compose_service parent). */
  track: TrackDTO | null;
}

export interface TrackDTO {
  id: number;
  resourceId: number;
  sourceRegistry: string;
  sourceRepository: string;
  sourceTag: string;
  targetPlatform: string | null;
  platformSource: string | null;
  configuredReference: string | null;
  configuredDigest: string | null;
  observedDigest: string | null;
  observedAt: string | null;
  upstreamTagUpdatedAt: string | null;
  observedReferenceKind: ReferenceKind | null;
  platformManifestDigest: string | null;
  lastSuccessfulDigest: string | null;
  lastSuccessAt: string | null;
  lastSuccessDeploymentUuid: string | null;
  lastSuccessSource: 'deployment' | 'manual' | null;
  pinnedAt: string | null;
  view: TrackView;
}

export interface JobLogEntry {
  at: string;
  stage: JobStage | 'note';
  message: string;
}

export interface JobDTO {
  id: number;
  resourceId: number;
  resourceName: string;
  resourceKind: ResourceKind;
  kind: JobKind;
  trigger: JobTrigger;
  candidateDigest: string;
  candidateReference: string;
  priorDigest: string | null;
  priorReference: string | null;
  status: JobStatus;
  stage: JobStage;
  deploymentUuid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  log: JobLogEntry[];
  createdAt: string;
  finishedAt: string | null;
}

export interface NotificationDTO {
  id: number;
  eventType: NotificationEventType;
  resourceId: number | null;
  resourceName: string | null;
  status: NotificationStatus;
  attempts: number;
  title: string;
  body: string;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface OverviewDTO {
  resourcesTotal: number;
  resourcesManaged: number; // notify + auto
  candidates: number;
  failures: number; // failed / unknown_submit jobs in recent window
  pendingConfirmations: number;
  lastSyncAt: string | null;
  lastCheckAt: string | null;
  globalPaused: boolean;
}

export interface AppriseStatusDTO {
  configured: boolean;
  apiUrlHost: string | null;
  configKeyPresent: boolean;
  tag: string | null;
  /** Never exposes the credential itself. */
  authConfigured: boolean;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastTestError: string | null;
}

export interface SettingsDTO {
  syncCron: string;
  checkCron: string;
  cronTimezone: string;
  globalPaused: boolean;
  deployConcurrency: number;
  coolifyBaseUrlHost: string | null;
  coolifyConnected: boolean | null; // null = never probed
  coolifyVersion: string | null;
  apprise: AppriseStatusDTO;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
