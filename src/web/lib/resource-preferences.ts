// Resource-workspace (applications / services) browser preferences: storage
// keys, field codecs and restore-time validation. Keys share a `resources.`
// namespace and a `v1` version suffix — bumping the suffix lets stale data
// lapse naturally. Filter defaults come from resource-view.ts so the page and
// the restore path can never drift apart.

import {
  decodeCount,
  decodeEnum,
  decodePositiveInt,
  decodeString,
  decodeStringArray,
} from './persisted-state.js';
import type { ExclusionView, ServiceFilters } from './resource-view.js';
import { DEFAULT_SERVICE_FILTERS } from './resource-view.js';

/** Page-size options: shared by the page-size selects and restore validation. */
export const PAGE_SIZES = [10, 20, 50, 100] as const;

/** Run-status filter tiers (applications and services). */
export const STATUS_FILTERS = ['all', 'running', 'stopped'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

const EXCLUSION_VIEWS = ['unexcluded', 'managed', 'excluded'] as const;
const LEGACY_MANAGED = ['all', 'managed'] as const;
const POLICY_VALUES = ['', 'ignore', 'notify', 'manual', 'auto'] as const;

// --- storage keys (namespace `resources.`, unified v1 suffix) ----------------------

export const APP_PREF_KEYS = {
  search: 'resources.applications.search.v1',
  view: 'resources.applications.view.v1',
  status: 'resources.applications.status.v1',
  server: 'resources.applications.server.v1',
  pageSize: 'resources.applications.pageSize.v1',
  page: 'resources.applications.page.v1',
} as const;

export const SERVICE_PREF_KEYS = {
  filters: 'resources.services.filters.v1',
  pageSize: 'resources.services.pageSize.v1',
  page: 'resources.services.page.v1',
  /** Service-group expansion: string[] of expanded group keys in storage. */
  expanded: 'resources.services.expanded.v1',
} as const;

// --- encoders -----------------------------------------------------------------------

/** Identity codec for JSON-representable state (strings, numbers, objects). */
export function encodeJson<T>(value: T): string {
  return JSON.stringify(value);
}

/**
 * Expansion state encoder. `undefined` (the "not customized yet" sentinel:
 * every group follows the default-expanded behavior) is kept absent from
 * storage; a concrete set round-trips as a string array.
 */
export function encodeExpanded(value: ReadonlySet<string> | undefined): string | undefined {
  return value == null ? undefined : JSON.stringify([...value]);
}

// --- decoders (unknown → value | null; null = fall back to the default) -------------

export function decodeExclusionView(raw: unknown): ExclusionView | null {
  return decodeEnum(raw, EXCLUSION_VIEWS);
}

export function decodeStatusFilter(raw: unknown): StatusFilter | null {
  return decodeEnum(raw, STATUS_FILTERS);
}

export function decodePageSize(raw: unknown): number | null {
  return decodeCount(raw, PAGE_SIZES);
}

export function decodePage(raw: unknown): number | null {
  return decodePositiveInt(raw);
}

export function decodeExpanded(raw: unknown): ReadonlySet<string> | null {
  const list = decodeStringArray(raw);
  return list == null ? null : new Set(list);
}

/**
 * Restore ServiceFilters object with per-field defaults: one corrupted field
 * only resets that condition, unknown fields are ignored, and a non-object
 * payload resets the whole filter set.
 */
export function decodeServiceFilters(raw: unknown): ServiceFilters {
  if (typeof raw !== 'object' || raw == null) return { ...DEFAULT_SERVICE_FILTERS };
  const obj = raw as Record<string, unknown>;
  return {
    search: decodeString(obj.search) ?? DEFAULT_SERVICE_FILTERS.search,
    policy: decodeEnum(obj.policy, POLICY_VALUES) ?? DEFAULT_SERVICE_FILTERS.policy,
    managed: decodeEnum(obj.managed, LEGACY_MANAGED) ?? DEFAULT_SERVICE_FILTERS.managed,
    status: decodeEnum(obj.status, STATUS_FILTERS) ?? DEFAULT_SERVICE_FILTERS.status,
    server: decodeString(obj.server) ?? DEFAULT_SERVICE_FILTERS.server,
  };
}
