// Shared image baseline semantics: canonical reference construction, baseline
// comparison and observation bookkeeping. Pure functions over row shapes —
// used by sync (drift decision), executor (prior/candidate checks), tracking
// (adopt/preview/reset) and the checker's observation writes.
//
// Two independent concepts (plan §2):
//  - 追踪渠道: sourceRegistry/sourceRepository/sourceTag — where the next
//    update resolves from.
//  - 已确认配置基线: configuredReference/configuredDigest — the Coolify
//    configuration the toolkit last accepted or wrote. They may legitimately
//    differ (live `:latest`, tracking `:stable`) until an adopt/save aligns
//    them.

import type { ImageTrackRow } from '../../db/schema.js';
import type { NormalizedRef } from '../../integrations/registry/reference.js';
import { coolifyDigestTag, normalizeReference } from '../../integrations/registry/reference.js';

/** Digest form of a reference (`@sha256:...`); compose child write format. */
export function composeDigestReference(repositoryAuthored: string, digest: string): string {
  return `${repositoryAuthored}@${digest}`;
}

/**
 * Canonical application reference for a digest: `registry/repository:sha256-…`.
 * Single source for preview target, token binding and job candidate reference
 * so all three always agree (plan §2: shared constructor includes GHCR hosts).
 */
export function applicationDigestReference(
  registry: string,
  repository: string,
  digest: string,
): string {
  return `${registry}/${repository}:${coolifyDigestTag(digest)}`;
}

/** Registry/repository identity comparison (tag/digest ignored). */
export function sameRepository(
  a: { registry: string; repository: string },
  b: { registry: string; repository: string },
): boolean {
  return a.registry === b.registry && a.repository === b.repository;
}

export interface BaselineSnapshot {
  configuredReference: string | null;
  configuredDigest: string | null;
}

/** Registry/repository identity of a live reference (normalized). */
function refIdentity(parsed: NormalizedRef): { registry: string; repository: string } {
  return { registry: parsed.registry, repository: parsed.repository };
}

interface BaselineIdentity {
  registry: string;
  repository: string;
  digest: string | null;
  tag: string | null;
}

/**
 * Identity+state of the confirmed baseline, parsed once per comparison.
 * Returns null when the baseline carries no evidence at all (caller treats it
 * as empty: first observation records without drift).
 */
function baselineIdentity(
  baseline: BaselineSnapshot,
  trackChannel: { registry: string; repository: string },
): BaselineIdentity | null {
  const ref = baseline.configuredReference;
  if (ref != null && ref.trim() !== '') {
    try {
      const p = normalizeReference(ref);
      return {
        registry: p.registry,
        repository: p.repository,
        digest: p.digest ?? baseline.configuredDigest,
        tag: p.tag,
      };
    } catch {
      // Unparseable stored reference: fall through to digest-only identity.
    }
  }
  if (baseline.configuredDigest != null) {
    return {
      // Legacy digest-only rows carry the track's channel identity (R5-F3):
      // without it, a same-digest live ref in another repository would pass.
      registry: trackChannel.registry,
      repository: trackChannel.repository,
      digest: baseline.configuredDigest,
      tag: null,
    };
  }
  return null;
}

/**
 * Live-reference vs confirmed-baseline comparison (plan §2).
 *
 * - null track (or no baseline evidence) = empty baseline: first observation
 *   records the config without drift.
 * - Repository identity must always match; a digest alone never validates a
 *   different registry/repository (plan: candidate equality requires both).
 * - Digest live refs compare against the baseline digest; digest and pure-tag
 *   refs are different states (pinned baseline + live tag = drift).
 * - Pure-tag live refs match the baseline tag when the baseline was a
 *   floating-tag reference; once a digest baseline exists, a revert to the
 *   plain tag is drift.
 */
export function liveMatchesBaseline(
  track: BaselineSnapshot | null | undefined,
  parsed: NormalizedRef | null,
  /** Channel identity for legacy digest-only rows (R5-F3). */
  trackChannel?: { registry: string; repository: string },
): boolean {
  if (track == null || parsed == null) return true;
  const channel = trackChannel ?? { registry: '', repository: '' };
  const baseline = baselineIdentity(track, channel);
  if (baseline == null) return true; // empty baseline: nothing accepted yet
  // Repository identity gate — always enforced now (digest-only rows use the
  // track's channel identity).
  if (!sameRepository(baseline, refIdentity(parsed))) {
    return false;
  }
  if (parsed.digest != null) {
    return parsed.digest === baseline.digest;
  }
  // Pure-tag live reference.
  if (baseline.digest != null) return false; // pinned baseline, live tag → drift
  return baseline.tag === parsed.tag;
}

export interface ObservationFields {
  observedDigest: string | null;
  observedAt: number | null;
  observedReferenceKind: 'index' | 'manifest' | null;
  platformManifestDigest: string | null;
  observedError: string | null;
  upstreamTagUpdatedAt: number | null;
}

/** Null-set object for every observation column (Drizzle `.set()` fragment). */
export function clearedObservation(): ObservationFields {
  return {
    observedDigest: null,
    observedAt: null,
    observedReferenceKind: null,
    platformManifestDigest: null,
    observedError: null,
    upstreamTagUpdatedAt: null,
  };
}

/**
 * Resolve a channel from a live reference, honoring an explicit user tag.
 * Returns the canonical registry/repository (normalized) plus the authored
 * repository path for minimal-diff compose writes.
 *
 * Rules (plan §3):
 *  - explicit tag wins over anything in the live reference;
 *  - digest-only live refs carry no tag: same-repository keeps the previous
 *    track tag for re-confirmation; otherwise the caller must ask the user;
 *  - plain references default to `latest` (normalizeReference).
 */
export function channelFromLive(
  live: NormalizedRef,
  previous: { sourceRegistry: string; sourceRepository: string; sourceTag: string } | null,
  explicitTag: string | null,
): { registry: string; repository: string; repositoryAuthored: string; tag: string | null } {
  if (explicitTag != null && explicitTag !== '') {
    return {
      registry: live.registry,
      repository: live.repository,
      repositoryAuthored: live.authoredPath,
      tag: explicitTag,
    };
  }
  if (live.tag != null) {
    return {
      registry: live.registry,
      repository: live.repository,
      repositoryAuthored: live.authoredPath,
      tag: live.tag,
    };
  }
  // Digest-only: reuse the previous tag only within the same repository.
  if (
    previous != null &&
    previous.sourceTag !== '' &&
    sameRepository(
      { registry: previous.sourceRegistry, repository: previous.sourceRepository },
      live,
    )
  ) {
    return {
      registry: live.registry,
      repository: live.repository,
      repositoryAuthored: live.authoredPath,
      tag: previous.sourceTag,
    };
  }
  return {
    registry: live.registry,
    repository: live.repository,
    repositoryAuthored: live.authoredPath,
    tag: null,
  };
}

/**
 * Candidate update relevance: the resolved upstream digest differs from what
 * the confirmed baseline holds. Digest-level only — floating-tag channels
 * always resolve to a digest, so this stays a digest comparison.
 */
export function baselineNeedsUpdate(
  track: Pick<ImageTrackRow, 'configuredDigest'>,
  upstreamDigest: string,
): boolean {
  return track.configuredDigest != null && track.configuredDigest !== upstreamDigest;
}

/**
 * Executor pre-write semantic check (F1/F7): is the live Coolify reference an
 * acceptable starting point for this job? Allowed states, in order:
 *  1. the candidate itself — requires the SAME repository AND digest;
 *  2. the job's recorded prior (job.priorDigest/priorReference);
 *  3. the track's confirmed baseline (track.configuredReference/Digest).
 * Repository identity for the candidate branch falls back to the track's
 * channel identity when neither reference exists (legacy digest-only rows,
 * R4-F7): a same-digest candidate in another repository is never accepted.
 * The tracked tag is deliberately never used as a baseline proxy: the channel
 * and the accepted config are independent (plan §2).
 */
export function liveReferenceAcceptableForJob(
  job: { priorDigest: string | null; priorReference: string | null; candidateDigest: string },
  track: BaselineSnapshot & { sourceRegistry: string; sourceRepository: string },
  parsed: NormalizedRef,
): boolean {
  if (parsed.digest === job.candidateDigest) {
    const refSource = job.priorReference ?? track.configuredReference;
    const fallbackIdentity = (): boolean =>
      sameRepository(
        { registry: track.sourceRegistry, repository: track.sourceRepository },
        refIdentity(parsed),
      );
    if (refSource == null || refSource.trim() === '') return fallbackIdentity();
    try {
      const refParsed = normalizeReference(refSource);
      return sameRepository(refIdentity(refParsed), refIdentity(parsed));
    } catch {
      return fallbackIdentity();
    }
  }
  // 2/3. Prior or baseline state via the shared comparison; channel identity
  // flows in for legacy digest-only rows (R5-F3).
  const priorSnapshot: BaselineSnapshot = {
    configuredReference: job.priorReference ?? track.configuredReference,
    configuredDigest: job.priorDigest ?? track.configuredDigest,
  };
  return liveMatchesBaseline(priorSnapshot, parsed, {
    registry: track.sourceRegistry,
    repository: track.sourceRepository,
  });
}
