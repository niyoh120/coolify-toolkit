// Row → DTO mapping with derived status views (pure functions; API-layer only).

import type {
  CheckOutcome,
  DeployState,
  ImageIssue,
  ImageIssueCode,
  ResourceDTO,
  TrackDTO,
  TrackView,
} from '../../shared/types.js';
import type { ImageTrackRow, ResourceRow, UpdateJobRow } from '../db/schema.js';
import { shortDigest } from './fingerprint.js';
import { registryHintOf } from './inventory/management-state.js';

/** Caller-supplied context for exclusion attribution and parent explanation. */
export interface ResourceDTOContext {
  /** Config UUID exclusion list; used to attribute self vs inherited exclusion. */
  excludedUuids?: string[];
  /** Parent row's excludedInfra when the resource has a local parent row. */
  parentExcluded?: boolean | null;
}

/**
 * Why the resource is config-excluded, per plan §1:
 * unclassified rows have no confirmed source (null); classified rows use the
 * config UUID list and the local parent row to explain inheritance.
 */
function exclusionSourceOf(
  resource: ResourceRow,
  ctx: ResourceDTOContext,
): 'self' | 'parent' | null {
  if (!resource.managementClassified || !resource.excludedInfra) return null;
  if (ctx.excludedUuids?.includes(resource.coolifyUuid) === true) return 'self';
  if (ctx.parentExcluded === true) return 'parent';
  // Excluded without an identifiable source: attribute to the UUID list
  // (parent rows may be gone) — the conservative display choice.
  return 'self';
}

export function deriveTrackView(
  track: ImageTrackRow,
  latestJob: UpdateJobRow | null,
  awaitingJob: UpdateJobRow | null,
): TrackView {
  const observed = track.observedDigest;
  const configured = track.configuredDigest;
  const configuredMatchesUpstream =
    observed == null || configured == null ? null : observed === configured;
  const hasCandidate = configured != null && observed != null && observed !== configured;

  let checkOutcome: CheckOutcome;
  if (track.observedError != null) checkOutcome = 'error';
  else if (configured == null) checkOutcome = 'unfixed';
  else if (observed == null) checkOutcome = 'blocked';
  else if (hasCandidate) checkOutcome = 'candidate';
  else checkOutcome = 'matching';

  let deployState: DeployState = 'unknown';
  if (awaitingJob != null) deployState = 'pending_confirmation';
  else if (latestJob?.status === 'pending' || latestJob?.status === 'running')
    deployState = 'deploying';
  else if (track.lastSuccessfulDigest != null && track.lastSuccessfulDigest === configured) {
    deployState = 'success';
  } else if (
    latestJob != null &&
    ['failed', 'unknown_submit', 'conflict'].includes(latestJob.status) &&
    latestJob.candidateDigest === configured
  ) {
    deployState = 'failed';
  }

  return { configuredMatchesUpstream, hasCandidate, checkOutcome, deployState };
}

export function trackToDTO(track: ImageTrackRow, view: TrackView): TrackDTO {
  return {
    id: track.id,
    resourceId: track.resourceId,
    sourceRegistry: track.sourceRegistry,
    sourceRepository: track.sourceRepository,
    sourceTag: track.sourceTag,
    targetPlatform: track.targetPlatform,
    platformSource: track.platformSource,
    configuredReference: track.configuredReference,
    configuredDigest: track.configuredDigest,
    observedDigest: track.observedDigest,
    observedAt: track.observedAt != null ? new Date(track.observedAt).toISOString() : null,
    upstreamTagUpdatedAt:
      track.upstreamTagUpdatedAt != null
        ? new Date(track.upstreamTagUpdatedAt).toISOString()
        : null,
    observedReferenceKind: track.observedReferenceKind,
    platformManifestDigest: track.platformManifestDigest,
    lastSuccessfulDigest: track.lastSuccessfulDigest,
    lastSuccessAt: track.lastSuccessAt != null ? new Date(track.lastSuccessAt).toISOString() : null,
    lastSuccessDeploymentUuid: track.lastSuccessDeploymentUuid,
    lastSuccessSource: track.lastSuccessSource,
    pinnedAt: track.pinnedAt != null ? new Date(track.pinnedAt).toISOString() : null,
    view,
  };
}

export function resourceToDTO(
  resource: ResourceRow,
  track: ImageTrackRow | null,
  latestJob: UpdateJobRow | null,
  awaitingJob: UpdateJobRow | null,
  ctx: ResourceDTOContext = {},
): ResourceDTO {
  const view = track != null ? deriveTrackView(track, latestJob, awaitingJob) : null;
  const imageIssue: ImageIssue | null =
    resource.imageIssue != null
      ? {
          code: resource.imageIssue as ImageIssueCode,
          registry: registryHintOf(resource.currentImage),
        }
      : null;
  return {
    id: resource.id,
    kind: resource.kind,
    coolifyUuid: resource.coolifyUuid,
    parentResourceId: resource.parentId,
    parentName: null, // filled by caller when available
    parentCoolifyUuid: null, // filled by caller when available
    projectUuid: resource.projectUuid,
    checkCron: resource.checkCron,
    lastDeployedAt: null, // filled by caller when a Coolify lookup is wanted
    environmentUuid: resource.environmentUuid,
    name: resource.name,
    composeServiceName: resource.composeServiceName,
    serverName: resource.serverName,
    projectName: resource.projectName,
    environmentName: resource.environmentName,
    domains: resource.domains,
    currentImage: resource.currentImage,
    policy: resource.policy,
    status: resource.status,
    blockedReason: (resource.blockedReason ?? null) as ResourceDTO['blockedReason'],
    excludedInfra: resource.excludedInfra,
    isStopped: resource.isStopped,
    managementClassified: resource.managementClassified,
    imageIssue,
    exclusionSource: exclusionSourceOf(resource, ctx),
    lastSyncedAt:
      resource.lastSyncedAt != null ? new Date(resource.lastSyncedAt).toISOString() : null,
    updatedAt: resource.updatedAt != null ? new Date(resource.updatedAt).toISOString() : null,
    track: track != null && view != null ? trackToDTO(track, view) : null,
  };
}

export { shortDigest };
