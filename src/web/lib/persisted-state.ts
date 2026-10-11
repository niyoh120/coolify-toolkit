// Small persistence layer for UI preferences (resource-page filters, paging,
// expansion state). Design goals:
//  - pure, unit-testable JSON parse/validate helpers and guarded storage I/O;
//  - injectable storage (lightweight in-memory double in tests); the browser
//    global (window.localStorage) is only touched at actual read/write time,
//    so restricted environments degrade to in-memory state;
//  - a thin usePersistedState wrapper mirroring useState semantics (direct
//    assignment + functional updates, lazy default factory), writing back in
//    a commit-time effect. A fixed key serves exactly one mount lifecycle:
//    the hook never syncs across mounts — remounts simply re-read storage.

import { useEffect, useState } from 'react';

/** Minimal storage surface (the subset of DOM Storage we rely on). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Returns the storage to use for one read/write; null means "unavailable". */
export type StorageAccessor = () => StorageLike | null;

/**
 * Default accessor for browsers. Reading the global `localStorage` property
 * itself can throw (privacy mode, sandboxed iframe, disabled storage), hence
 * the guard. Indirection through globalThis keeps this file DOM-lib-free so
 * node-side tests (server tsconfig) can import it.
 */
export const browserLocalStorage: StorageAccessor = () => {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
};

/**
 * Short diagnostic for storage failures. Logs the operation and the key only —
 * never the stored content or user-typed filters.
 */
function diagnose(operation: '读取' | '写入', key: string): void {
  console.warn(`[偏好] 浏览器存储${operation}失败（${key}），本次会话内继续使用内存状态。`);
}

export type StoredRead = { missing: true } | { missing: false; raw: string };

/** Guarded read: any access failure or absent entry collapses to `missing`. */
export function readStoredRaw(key: string, storage: StorageAccessor): StoredRead {
  let store: StorageLike | null;
  try {
    store = storage();
  } catch {
    diagnose('读取', key);
    return { missing: true };
  }
  if (store == null) return { missing: true };
  try {
    const raw = store.getItem(key);
    return raw == null ? { missing: true } : { missing: false, raw };
  } catch {
    diagnose('读取', key);
    return { missing: true };
  }
}

/**
 * JSON.parse with failures mapped to null (JSON "null" literals land here
 * too, which is fine: both mean "fall back to the default").
 */
export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Guarded write; returns false when storage is unavailable or throws. */
export function writeStoredRaw(key: string, raw: string, storage: StorageAccessor): boolean {
  let store: StorageLike | null;
  try {
    store = storage();
  } catch {
    diagnose('写入', key);
    return false;
  }
  if (store == null) return false;
  try {
    store.setItem(key, raw);
    return true;
  } catch {
    diagnose('写入', key);
    return false;
  }
}

// --- runtime validators (unknown → value | null) ----------------------------------

/** Strings only; anything else falls back. */
export function decodeString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

/** Enum whitelist; anything outside falls back. */
export function decodeEnum<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : null;
}

/** Numeric whitelist (page-size options shared by UI and restore). */
export function decodeCount(raw: unknown, allowed: readonly number[]): number | null {
  return typeof raw === 'number' && allowed.includes(raw) ? raw : null;
}

/** Page numbers: positive safe integers. */
export function decodePositiveInt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
}

/** Arrays of strings (service-group expansion keys). */
export function decodeStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

// --- load/persist (the pure core of the hook below) --------------------------------

/**
 * Read + validate one persisted value. Missing entries, corrupted JSON and
 * invalid shapes all fall back to the default; storage failures are guarded.
 */
export function loadPersisted<T>(
  key: string,
  decode: (raw: unknown) => T | null,
  defaultValue: T | (() => T),
  storage: StorageAccessor,
): T {
  const stored = readStoredRaw(key, storage);
  if (stored.missing) {
    return typeof defaultValue === 'function' ? (defaultValue as () => T)() : defaultValue;
  }
  const decoded = decode(parseJsonSafe(stored.raw));
  if (decoded !== null) return decoded;
  return typeof defaultValue === 'function' ? (defaultValue as () => T)() : defaultValue;
}

/**
 * Serialize + write one value. Encoders may return undefined to skip writing
 * (e.g. a "not customized yet" sentinel that must stay absent from storage).
 */
export function persistValue<T>(
  key: string,
  value: T,
  encode: (value: T) => string | undefined,
  storage: StorageAccessor,
): boolean {
  const raw = encode(value);
  if (raw === undefined) return false;
  return writeStoredRaw(key, raw, storage);
}

export interface UsePersistedStateOptions<T> {
  /**
   * Storage key with its own version suffix. The same key must serve exactly
   * one mount lifecycle; there is intentionally no cross-mount/live sync.
   */
  key: string;
  /** Restore from parsed JSON; null means invalid → fall back to the default. */
  decode: (raw: unknown) => T | null;
  /** Serializes the state for storage; may return undefined to skip writing. */
  encode: (value: T) => string | undefined;
  /** Default value; lazy factory form mirrors useState. */
  defaultValue: T | (() => T);
  /** Storage accessor; defaults to the browser's localStorage. */
  storage?: StorageAccessor;
}

export type PersistedSetter<T> = (value: T | ((prev: T) => T)) => void;

/**
 * useState with transparent persistence. The initial value is restored from
 * storage (lazy init); every committed change is written back once in an
 * effect. Keep `encode`/`decode`/`storage` referentially stable (module-level
 * codecs) so the write effect only re-runs on actual value changes.
 */
export function usePersistedState<T>(
  options: UsePersistedStateOptions<T>,
): [T, PersistedSetter<T>] {
  const { key, encode, decode, defaultValue, storage = browserLocalStorage } = options;
  const [value, setValue] = useState<T>(() => loadPersisted(key, decode, defaultValue, storage));
  useEffect(() => {
    persistValue(key, value, encode, storage);
  }, [key, value, encode, storage]);
  return [value, setValue];
}
