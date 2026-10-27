// 全局同步控制器：Layout 桌面/移动入口、ResourceTabsBar、Overview 共用。
// 放在路由与 QueryClientProvider 之内、页面组件之外：切换页面时请求与
// toast 生命周期照常完成；Provider 卸载（整页离开 SPA）才整体销毁。

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  FEEDBACK,
  formatActionError,
  formatSyncPartial,
  formatSyncSuccess,
  type SyncFeedbackSummary,
} from '../lib/action-feedback.js';
import { api } from '../lib/api.js';

const SYNC_TOAST_ID = 'inventory-sync';

interface SyncActionCtx {
  /** 当前 SPA 实例内是否有一个同步请求进行中（所有入口共享忙碌态）。 */
  syncing: boolean;
  /** 触发一次同步；重复调用复用同一个在途 Promise，不产生第二个请求。 */
  runSync(): Promise<void>;
}

const SyncContext = createContext<SyncActionCtx>({
  syncing: false,
  runSync: async () => undefined,
});

export function useSyncAction(): SyncActionCtx {
  return useContext(SyncContext);
}

function syncFeedback(result: SyncFeedbackSummary): void {
  // 结果复用 loading 的 toast ID：原地替换而非叠加，结束后 loading 数为零。
  if ((result.errors?.length ?? 0) > 0) {
    const partial = formatSyncPartial(result);
    toast.error(partial.title, {
      id: SYNC_TOAST_ID,
      description: partial.description,
      duration: FEEDBACK.errorMs,
      closeButton: true,
    });
    return;
  }
  toast.success('资源同步完成', {
    id: SYNC_TOAST_ID,
    description: formatSyncSuccess(result),
    duration: FEEDBACK.successMs,
  });
}

export function SyncActionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const inFlight = useRef<Promise<void> | null>(null);
  const [syncing, setSyncing] = useState(false);

  const runSync = useCallback(async (): Promise<void> => {
    // 防重复：请求发起前同步设置 in-flight 引用，并发点击复用同一 Promise。
    if (inFlight.current != null) return inFlight.current;
    const promise = (async (): Promise<void> => {
      setSyncing(true);
      // 一次请求对应一个 loading 提示，成功/失败原地更新。
      toast.loading('正在同步资源…', { id: SYNC_TOAST_ID, duration: Infinity });
      try {
        const res = await api.sync();
        // 先等查询刷新完成，再用真实响应更新结果，避免刷新失败混入写结果。
        await qc.invalidateQueries();
        syncFeedback(res.sync);
      } catch (err) {
        // 刷新失败与请求失败都要可见；两者都在这里展示为同步失败。
        const { title, description } = formatActionError(err);
        toast.error(title, {
          description,
          id: SYNC_TOAST_ID,
          duration: FEEDBACK.errorMs,
          closeButton: true,
        });
      } finally {
        // loading toast 在成功/失败分支已被同 ID 替换；正常结束无需额外处理。
        inFlight.current = null;
        setSyncing(false);
      }
    })();
    inFlight.current = promise;
    return promise;
  }, [qc]);

  const value = useMemo<SyncActionCtx>(() => ({ syncing, runSync }), [syncing, runSync]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
