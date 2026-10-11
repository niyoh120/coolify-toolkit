// Restore/round-trip and storage-boundary tests for the resource preference
// layer. Node environment with an in-memory storage double: no DOM, no React
// renderer — the mounted hook itself is exercised end-to-end by the browser
// regression scenarios (scripts/verify-responsive.mjs).

import { describe, expect, it } from 'vitest';
import {
  decodeString,
  loadPersisted,
  parseJsonSafe,
  persistValue,
  type StorageAccessor,
  type StorageLike,
} from '../src/web/lib/persisted-state.js';
import {
  APP_PREF_KEYS,
  decodeExclusionView,
  decodeExpanded,
  decodePage,
  decodePageSize,
  decodeServiceFilters,
  decodeStatusFilter,
  encodeExpanded,
  encodeJson,
  SERVICE_PREF_KEYS,
} from '../src/web/lib/resource-preferences.js';
import { DEFAULT_SERVICE_FILTERS } from '../src/web/lib/resource-view.js';

/** Lightweight in-memory storage double (getItem/setItem contract only). */
function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function accessor(store: StorageLike | null): StorageAccessor {
  return () => store;
}

describe('资源偏好持久化', () => {
  it('有效偏好读写往返：应用/服务独立 key、服务筛选、页码/页容量、Set 编码恢复', () => {
    const store = memoryStorage();

    // 应用字段：写入后可按各自 key 恢复。
    expect(persistValue(APP_PREF_KEYS.search, 'redis', encodeJson, accessor(store))).toBe(true);
    expect(persistValue(APP_PREF_KEYS.view, 'managed', encodeJson, accessor(store))).toBe(true);
    expect(persistValue(APP_PREF_KEYS.status, 'stopped', encodeJson, accessor(store))).toBe(true);
    expect(persistValue(APP_PREF_KEYS.server, 'homelab-01', encodeJson, accessor(store))).toBe(
      true,
    );
    expect(persistValue(APP_PREF_KEYS.pageSize, 50, encodeJson, accessor(store))).toBe(true);
    expect(persistValue(APP_PREF_KEYS.page, 2, encodeJson, accessor(store))).toBe(true);
    expect(loadPersisted(APP_PREF_KEYS.search, decodeString, '', accessor(store))).toBe('redis');
    expect(
      loadPersisted(APP_PREF_KEYS.view, decodeExclusionView, 'unexcluded', accessor(store)),
    ).toBe('managed');
    expect(loadPersisted(APP_PREF_KEYS.status, decodeStatusFilter, 'all', accessor(store))).toBe(
      'stopped',
    );
    expect(loadPersisted(APP_PREF_KEYS.server, decodeString, '', accessor(store))).toBe(
      'homelab-01',
    );
    expect(loadPersisted(APP_PREF_KEYS.pageSize, decodePageSize, 20, accessor(store))).toBe(50);
    expect(loadPersisted(APP_PREF_KEYS.page, decodePage, 1, accessor(store))).toBe(2);

    // key 隔离：应用写入不泄漏到服务 key，服务未写入字段取默认值。
    expect(loadPersisted(SERVICE_PREF_KEYS.page, decodePage, 1, accessor(store))).toBe(1);
    expect(
      loadPersisted(
        SERVICE_PREF_KEYS.filters,
        decodeServiceFilters,
        DEFAULT_SERVICE_FILTERS,
        accessor(store),
      ),
    ).toEqual(DEFAULT_SERVICE_FILTERS);

    // 服务筛选对象整体往返，输入对象保持原样（解码不改动调用方数据）。
    const filters = { ...DEFAULT_SERVICE_FILTERS, search: 'media', status: 'stopped' as const };
    const filtersSnapshot = { ...filters };
    expect(persistValue(SERVICE_PREF_KEYS.filters, filters, encodeJson, accessor(store))).toBe(
      true,
    );
    expect(
      loadPersisted(
        SERVICE_PREF_KEYS.filters,
        decodeServiceFilters,
        DEFAULT_SERVICE_FILTERS,
        accessor(store),
      ),
    ).toEqual(filters);
    expect(filters).toEqual(filtersSnapshot);

    // Set 展开集合：数组编码 → Set 恢复，且输入 Set 不被改动。
    const expanded = new Set(['svc-11', 'orphan-9999']);
    expect(
      persistValue(SERVICE_PREF_KEYS.expanded, expanded, encodeExpanded, accessor(store)),
    ).toBe(true);
    const restored = loadPersisted(
      SERVICE_PREF_KEYS.expanded,
      decodeExpanded,
      undefined,
      accessor(store),
    );
    expect(restored).toBeInstanceOf(Set);
    expect([...(restored ?? new Set<string>())].sort()).toEqual(['orphan-9999', 'svc-11']);
    expect(expanded.has('orphan-9999')).toBe(true);

    // 「尚未定制」哨兵（undefined）跳过写入，存储保持无该 key。
    expect(
      persistValue(SERVICE_PREF_KEYS.expanded, undefined, encodeExpanded, accessor(store)),
    ).toBe(false);
    expect(store.data.has(SERVICE_PREF_KEYS.expanded)).toBe(true); // 之前的写入仍在
    const emptyStore = memoryStorage();
    expect(
      persistValue(SERVICE_PREF_KEYS.expanded, undefined, encodeExpanded, accessor(emptyStore)),
    ).toBe(false);
    expect(emptyStore.data.size).toBe(0);
    // 空数组是有效状态（折叠全部），恢复为空 Set，与「未定制」区分。
    expect(
      persistValue(
        SERVICE_PREF_KEYS.expanded,
        new Set<string>(),
        encodeExpanded,
        accessor(emptyStore),
      ),
    ).toBe(true);
    const restoredEmpty = loadPersisted(
      SERVICE_PREF_KEYS.expanded,
      decodeExpanded,
      undefined,
      accessor(emptyStore),
    );
    expect(restoredEmpty).toBeInstanceOf(Set);
    expect(restoredEmpty?.size).toBe(0);
  });

  it('异常内容回退：损坏 JSON、错误形状、非法枚举、非法页码/页容量与展开集合', () => {
    const store = memoryStorage({
      [APP_PREF_KEYS.search]: '{broken json',
      [APP_PREF_KEYS.view]: JSON.stringify(null),
      [APP_PREF_KEYS.status]: '"bogus-tier"',
      [APP_PREF_KEYS.server]: '42',
      [APP_PREF_KEYS.pageSize]: '33',
      [APP_PREF_KEYS.page]: '0',
      [SERVICE_PREF_KEYS.filters]: '{"search":"media","status":7,"server":"node-2"}',
      [SERVICE_PREF_KEYS.expanded]: '["svc-1",42]',
      'resources.services.pageSize.v1': '50',
    });
    const acc = accessor(store);

    // 损坏 JSON / JSON null / 非法枚举 / 错误字段类型 → 各自回退默认值。
    expect(loadPersisted(APP_PREF_KEYS.search, decodeString, '', acc)).toBe('');
    expect(loadPersisted(APP_PREF_KEYS.view, decodeExclusionView, 'unexcluded', acc)).toBe(
      'unexcluded',
    );
    expect(loadPersisted(APP_PREF_KEYS.status, decodeStatusFilter, 'all', acc)).toBe('all');
    expect(loadPersisted(APP_PREF_KEYS.server, decodeString, '', acc)).toBe('');
    // 页容量必须在白名单内（字符串 "33" 也不接受），页码必须是正安全整数。
    expect(loadPersisted(APP_PREF_KEYS.pageSize, decodePageSize, 20, acc)).toBe(20);
    expect(loadPersisted(APP_PREF_KEYS.page, decodePage, 1, acc)).toBe(1);
    for (const bad of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
      expect(decodePage(bad)).toBeNull();
    }
    expect(decodePageSize(33)).toBeNull();
    expect(decodePageSize(100)).toBe(100);

    // 缺失 key → 默认值；惰性工厂只该在回退时使用。
    let factoryCalls = 0;
    expect(
      loadPersisted(
        'resources.applications.missing.v1',
        decodePage,
        () => {
          factoryCalls += 1;
          return 7;
        },
        acc,
      ),
    ).toBe(7);
    expect(factoryCalls).toBe(1);

    // 服务筛选：单个坏字段只重置该字段；未知字段忽略。
    expect(
      loadPersisted(SERVICE_PREF_KEYS.filters, decodeServiceFilters, DEFAULT_SERVICE_FILTERS, acc),
    ).toEqual({ ...DEFAULT_SERVICE_FILTERS, search: 'media', server: 'node-2' });
    // 非对象负载 → 整组默认值。
    for (const bad of ['"x"', '7', '[]', 'null']) {
      expect(decodeServiceFilters(parseJsonSafe(bad))).toEqual(DEFAULT_SERVICE_FILTERS);
    }
    expect(decodeServiceFilters({ ...DEFAULT_SERVICE_FILTERS, legacyField: 1 })).toEqual(
      DEFAULT_SERVICE_FILTERS,
    );

    // 展开集合：含非字符串元素 → 回退默认（undefined）；合法数组 → Set。
    expect(loadPersisted(SERVICE_PREF_KEYS.expanded, decodeExpanded, undefined, acc)).toBe(
      undefined,
    );
    expect(decodeExpanded(parseJsonSafe('{"a":1}'))).toBeNull();
    expect(decodeExpanded(parseJsonSafe('"svc-1"'))).toBeNull();
    // 写入的合法服务页容量独立恢复（与坏数据同库互不影响）。
    expect(loadPersisted('resources.services.pageSize.v1', decodePageSize, 20, acc)).toBe(50);
  });

  it('存储边界失败：访问/读取/写入异常与无浏览器全局时受控回退', () => {
    const throwingAccessor: StorageAccessor = () => {
      throw new Error('storage access blocked');
    };
    // 访问存储本身抛异常：读取回退默认值，写入返回 false，均不外抛。
    expect(loadPersisted(APP_PREF_KEYS.search, decodeString, 'fallback', throwingAccessor)).toBe(
      'fallback',
    );
    expect(persistValue(APP_PREF_KEYS.search, 'redis', encodeJson, throwingAccessor)).toBe(false);

    // 无浏览器全局（隐私模式/禁用存储）：同样受控。
    expect(loadPersisted(APP_PREF_KEYS.search, decodeString, 'fallback', accessor(null))).toBe(
      'fallback',
    );
    expect(persistValue(APP_PREF_KEYS.search, 'redis', encodeJson, accessor(null))).toBe(false);

    // getItem 抛异常 → 回退默认；setItem 抛异常 → 写入失败，但不影响其它 key。
    const brokenGet = accessor({
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => undefined,
    });
    expect(loadPersisted(APP_PREF_KEYS.page, decodePage, 3, brokenGet)).toBe(3);
    const brokenSetStore = memoryStorage({ [SERVICE_PREF_KEYS.page]: '4' });
    const brokenSet = accessor({
      getItem: (key) =>
        brokenSetStore.data.has(key) ? (brokenSetStore.data.get(key) as string) : null,
      setItem: (key, value) => {
        if (key === APP_PREF_KEYS.search) throw new Error('quota');
        brokenSetStore.data.set(key, value);
      },
    });
    expect(persistValue(APP_PREF_KEYS.search, 'redis', encodeJson, brokenSet)).toBe(false);
    expect(persistValue(SERVICE_PREF_KEYS.page, 2, encodeJson, brokenSet)).toBe(true);
    // 写入失败后已有数据仍可读，状态路径（内存值）不受影响。
    expect(loadPersisted(SERVICE_PREF_KEYS.page, decodePage, 1, brokenSet)).toBe(2);

    // parseJsonSafe：非法 JSON → null（触发默认回退），合法 JSON 正常解析。
    expect(parseJsonSafe('nope')).toBeNull();
    expect(parseJsonSafe('"x"')).toBe('x');
  });
});
