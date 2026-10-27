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
  | 'compose_confirmation_pending' // compose: submitted, waiting for the delayed auto-check
  | 'stopped' // resource is stopped; manual start required
  | 'update_failed' // last update failed; keep target config, require user action
  | null;

/** Kind of the top-level reference a digest was computed from. */
export type ReferenceKind = 'index' | 'manifest';

/**
 * Structured image classification problems, written exclusively by the normal
 * inventory sync. null = the reference parsed cleanly (or none was expected).
 */
export type ImageIssueCode =
  | 'missing_image' // resource carries no image reference at all
  | 'unsupported_registry' // registry host outside the supported set
  | 'unresolved_variable' // compose variable ($VAR / ${VAR...}) never expanded
  | 'invalid_reference'; // present but structurally invalid

/** Safe diagnostic info for an image problem; never carries credentials. */
export interface ImageIssue {
  code: ImageIssueCode;
  /** Registry host embedded in the raw reference (e.g. "gcr.io"); else null. */
  registry: string | null;
}

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
  | 'pending_confirmation'; // compose: submitted, waiting for the delayed auto-check

/** How a successful job's evidence was established. */
export type SuccessSource = 'deployment' | 'manual' | 'runtime_observation';

/** Pending compose confirmation summary projected onto the owning child row. */
export interface PendingConfirmationDTO {
  jobId: number;
  candidateDigest: string;
  /** Epoch ISO time of the single delayed auto-check; null for legacy rows. */
  confirmationDueAt: string | null;
}

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
  /**
   * true = the row has been classified by the normal sync rules; excludedInfra
   * then means pure config exclusion (self UUID or parent service UUID).
   * false = legacy row awaiting its first classified sync ("待同步确认");
   * excludedInfra keeps historical information only.
   */
  managementClassified: boolean;
  /** Structured image problem; null = parseable (or pending classification). */
  imageIssue: ImageIssue | null;
  /**
   * Why the resource is excluded: own UUID hit, inherited from the parent
   * service, or null when excluded is false / classification is pending.
   */
  exclusionSource: 'self' | 'parent' | null;
  lastSyncedAt: string | null;
  updatedAt: string | null;
  /** null when the resource cannot carry a track (compose_service parent). */
  track: TrackDTO | null;
  /** Active running/awaiting_confirmation compose task summary; null otherwise. */
  pendingConfirmation: PendingConfirmationDTO | null;
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
  lastSuccessSource: SuccessSource | null;
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
  /** Due time of the pending single auto-check; null unless awaiting it. */
  confirmationDueAt: string | null;
  /** Derived evidence source once the job succeeded; null while in flight. */
  successSource: SuccessSource | null;
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

// --- tracking recovery (adopt / save-recovery / reset) -----------------------------

/** Where the adopt preview found the channel for the new tracking source. */
export type AdoptChannelSource = 'live' | 'user_tag';

/** Impact scope of an adopt-confirm, mirroring the update preview shape. */
export interface AdoptImpact {
  kind: 'application' | 'compose_child';
  parentName: string | null;
  note: string;
}

/** Adopt preview response: read-only plan plus a short-lived token. */
export interface AdoptPreviewDTO {
  /** Live full reference currently configured in Coolify (as of the preview). */
  liveReference: string;
  /** Current confirmed baseline before adoption. */
  configuredReference: string | null;
  configuredDigest: string | null;
  /** Channel the new tracking will use. */
  channel: {
    source: AdoptChannelSource;
    registry: string;
    repository: string;
    repositoryAuthored: string;
    tag: string;
  };
  /** Complete target reference the next update will write. */
  targetReference: string;
  targetDigest: string;
  referenceKind: ReferenceKind;
  /** Upstream resolution time of the preview (ISO). */
  resolvedAt: string;
  /** Platform the preview resolved against. */
  platform: string | null;
  impact: AdoptImpact;
  previewToken: string;
}

/** Adopt confirm result: adopted with a task, or a no-op with explanation. */
export interface AdoptResultDTO {
  status: 'adopted' | 'skipped';
  message: string;
  /** Created task (server row shape); null on skip. The API layer maps JobDTO. */
  job: Record<string, unknown> | null;
  resource: unknown;
}

/** Reset-tracking result: always ignores; ledger cleared, config untouched. */
export interface ResetTrackingDTO {
  resource: ResourceDTO;
  message: string;
}
