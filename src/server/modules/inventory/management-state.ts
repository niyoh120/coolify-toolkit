// Management classification and eligibility rules shared by sync, API routes,
// checks, jobs and the scheduler. Pure functions over row shapes; no IO.
//
// Two orthogonal dimensions drive every management decision:
//  - managementClassified: readiness. false = the row predates the current
//    sync classification and awaits its first classified sync ("待同步确认");
//    its old excludedInfra value is historical information only.
//  - classified rows: excludedInfra = pure config exclusion (own UUID or the
//    parent service's UUID), imageIssue = structured image problem.

import type { ImageIssueCode } from '../../../shared/types.js';
import {
  type NormalizedRef,
  normalizeReference,
  UnsupportedRegistryError,
} from '../../integrations/registry/reference.js';

export type { ImageIssueCode };

/** Matches `$VAR`, `${VAR}`, `${VAR:-default}` — anything compose left unexpanded. */
const UNRESOLVED_VARIABLE = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

export interface ImageClassification {
  /** null when the reference is usable as-is. */
  issue: ImageIssueCode | null;
  parsed: NormalizedRef | null;
}

/**
 * Server-side image classifier applied by every sync projection: detect
 * unexpanded compose variables first, then normalize against the supported
 * registry set (docker.io / ghcr.io / lscr.io). Expected resolution problems
 * become issue codes; genuinely unexpected program errors still throw.
 */
export function classifyImage(image: string | null | undefined): ImageClassification {
  if (image == null || image.trim() === '') return { issue: 'missing_image', parsed: null };
  const raw = image.trim();
  if (UNRESOLVED_VARIABLE.test(raw)) return { issue: 'unresolved_variable', parsed: null };
  try {
    return { issue: null, parsed: normalizeReference(raw) };
  } catch (err) {
    if (err instanceof UnsupportedRegistryError) {
      return { issue: 'unsupported_registry', parsed: null };
    }
    return { issue: 'invalid_reference', parsed: null };
  }
}

/**
 * Registry host embedded in a raw image reference (safe diagnostic only).
 * Returns null when the reference carries no explicit host segment.
 */
export function registryHintOf(image: string | null | undefined): string | null {
  if (image == null) return null;
  const raw = image.trim();
  const slash = raw.indexOf('/');
  if (slash <= 0) return null;
  const head = raw.slice(0, slash);
  if (head.includes('.') || head.includes(':') || head === 'localhost') {
    return head.toLowerCase();
  }
  return null;
}

/** Human-readable reason for an image issue (also mirrored in the UI layer). */
export function imageIssueReason(
  issue: ImageIssueCode,
  registryHint: string | null = null,
): string {
  switch (issue) {
    case 'unsupported_registry':
      return registryHint != null ? `暂不支持的镜像仓库：${registryHint}` : '暂不支持的镜像仓库';
    case 'unresolved_variable':
      return '镜像变量未解析（请核对 Coolify 实际镜像配置）';
    case 'missing_image':
      return '镜像信息缺失';
    case 'invalid_reference':
      return '镜像引用无效';
  }
}

export type ManagementGateCode = 'pending_sync' | 'excluded' | 'image_issue';

export type ManagementGate = { ok: true } | { ok: false; code: ManagementGateCode; reason: string };

/** Minimal row shape every caller already has (ResourceRow or a projection). */
export interface ManagementStateShape {
  managementClassified: boolean;
  excludedInfra: boolean;
  imageIssue: string | null;
}

/**
 * Single source of truth for "may this resource be managed right now?".
 * Order matters and is contractual: pending classification first, then config
 * exclusion, then image problems. Callers layer their own additional
 * constraints (ignored, inactive, external_change, job mutual exclusion).
 */
export function managementGate(
  resource: ManagementStateShape,
  currentImage?: string | null,
): ManagementGate {
  if (!resource.managementClassified) {
    return {
      ok: false,
      code: 'pending_sync',
      reason: '待同步确认：完成一次资源同步后才能确定管理状态',
    };
  }
  if (resource.excludedInfra) {
    return { ok: false, code: 'excluded', reason: '已排除（配置名单）' };
  }
  if (resource.imageIssue != null) {
    return {
      ok: false,
      code: 'image_issue',
      reason: imageIssueReason(resource.imageIssue as ImageIssueCode, registryHintOf(currentImage)),
    };
  }
  return { ok: true };
}

/** Convenience: eligible = gate passes (used by batch pre-checks and filters). */
export function isManagementEligible(
  resource: ManagementStateShape,
  currentImage?: string | null,
): boolean {
  return managementGate(resource, currentImage).ok;
}

/** Minimal row shape for the parent-side inheritance check. */
export interface ParentShape {
  parentId: number | null;
}

/**
 * Effective gate for a resource with a possible parent service: on top of the
 * own gate, a *classified + excluded* parent blocks the child so a partial
 * sync window cannot leave the child actionable while exclusion propagation
 * has yet to reach it. A pending parent blocks itself only; the next sync
 * resolves the child's inherited state.
 */
export function effectiveManagementGate(
  resource: ManagementStateShape & ParentShape,
  parent: (ManagementStateShape & ParentShape) | null,
  currentImage?: string | null,
): ManagementGate {
  const own = managementGate(resource, currentImage);
  if (!own.ok) return own;
  if (resource.parentId && parent?.managementClassified && parent.excludedInfra) {
    return {
      ok: false,
      code: 'excluded',
      reason: '父服务已配置排除，子容器继承受限（等待同步确认）',
    };
  }
  return { ok: true };
}
