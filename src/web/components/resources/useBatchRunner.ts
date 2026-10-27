// Shared batch runner for check/update/policy flows: serial execution with
// per-item feedback and business-outcome statistics (blocked counts as skip).

import { useMutation } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import type { Policy } from '../../../shared/types.js';
import { ApiError, api } from '../../lib/api.js';
import {
  type BatchCheckStats,
  type BatchConfirmStats,
  type BatchUpdateStats,
  type ConfirmItem,
  checkOutcomeFeedback,
  classifyCheckOutcome,
  confirmItemFeedback,
  isStaleConfirmError,
  summarizeBatchChecks,
  summarizeBatchConfirmations,
  summarizeBatchUpdates,
} from '../../lib/resource-view.js';
import { useRefresh } from '../../main.js';

/**
 * 等列表重取完成；刷新失败（网络/服务端错误）吞掉 rejection：
 * 批量结果反馈基于已收集的逐项业务结果，轮询与后续 10s 定时刷新会继续重试。
 */
async function refreshQuietly(refresh: () => Promise<void>): Promise<void> {
  try {
    await refresh();
  } catch {
    // 列表刷新失败与操作结果分离；下一轮询会再试。
  }
}

export interface FeedbackLine {
  id: number;
  text: string;
}

export interface BatchLines {
  summary: string;
  detail: FeedbackLine[];
}

let FEEDBACK_SEQ = 0;
function nextFeedbackId(): number {
  FEEDBACK_SEQ += 1;
  return FEEDBACK_SEQ;
}

/** 追加一行反馈，保留最近 12 条避免无限增长。 */
export function useFeedbackLines(): [FeedbackLine[], (text: string) => void] {
  const [lines, setLines] = useState<FeedbackLine[]>([]);
  const push = (text: string): void => {
    setLines((prev) => [...prev.slice(-11), { id: nextFeedbackId(), text }]);
  };
  return [lines, push];
}

/**
 * 页面级互斥锁：批量与单项操作共用同一个同步 acquire/release 入口。
 * state 更新是异步的，防重必须依赖同步设置的 ref；busy 供按钮禁用。
 * 单项操作占用锁后，批量与另一个单项都会被拒绝，杜绝同资源重复请求。
 */
function useActionLock() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const acquire = useCallback((): (() => void) | null => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    return () => {
      running.current = false;
      setBusy(false);
    };
  }, []);
  return { busy, acquire };
}

export function useBatchRunner() {
  const refresh = useRefresh();
  // 同步执行锁：批量与单项（useCheckOne/useUpdateOne 的 lock 参数）共用，
  // 任一方向进行中，另一个方向都被拒绝，杜绝同资源并发重复请求。
  const { busy, acquire } = useActionLock();
  const [activeCheckId, setActiveCheckId] = useState<number | null>(null);
  const [activeUpdateId, setActiveUpdateId] = useState<number | null>(null);
  const [activeConfirmId, setActiveConfirmId] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BatchLines | null>(null);

  /** Serial batch check: stats by business outcome, detail lines for skips/failures. */
  const runChecks = async (ids: number[], nameOf: (id: number) => string): Promise<BatchLines> => {
    const release = acquire();
    if (release == null) return { summary: '已有批量任务进行中，本次未执行。', detail: [] };
    setProgress({ done: 0, total: ids.length });
    const stats: BatchCheckStats = { succeeded: 0, blocked: 0, failed: 0 };
    const detail: FeedbackLine[] = [];
    let done = 0;
    for (const id of ids) {
      const name = nameOf(id);
      setActiveCheckId(id);
      try {
        const res = await api.checkResource(id);
        const cls = classifyCheckOutcome(res.check.outcome);
        stats[cls] += 1;
        if (cls !== 'succeeded') {
          detail.push({
            id: nextFeedbackId(),
            text: checkOutcomeFeedback(name, res.check.outcome, res.check.message).text,
          });
        }
      } catch {
        stats.failed += 1;
        detail.push({ id: nextFeedbackId(), text: `${name}：检查失败（请求错误）` });
      } finally {
        done += 1;
        setProgress({ done, total: ids.length });
      }
    }
    setActiveCheckId(null);
    setProgress(null);
    const lines = { summary: summarizeBatchChecks(stats), detail };
    // 先等列表重取完成再展示反馈：反馈与刷新后的表格同帧出现。
    // 锁保持到重取结束：重取窗口内不可叠加新批量（与 runPolicy 语义一致）。
    await refreshQuietly(refresh);
    setResult(lines);
    release();
    return lines;
  };

  /** Serial batch update via skipPreview; 202=submitted, skipped=no-update. */
  const runUpdates = async (ids: number[], nameOf: (id: number) => string): Promise<BatchLines> => {
    const release = acquire();
    if (release == null) return { summary: '已有批量任务进行中，本次未执行。', detail: [] };
    setProgress({ done: 0, total: ids.length });
    const stats: BatchUpdateStats = { submitted: 0, skipped: 0, failed: 0 };
    const detail: FeedbackLine[] = [];
    let done = 0;
    for (const id of ids) {
      const name = nameOf(id);
      setActiveUpdateId(id);
      try {
        const res = await api.executeUpdate(id);
        if (res.skipped) {
          stats.skipped += 1;
          detail.push({ id: nextFeedbackId(), text: `${name}：无更新，已跳过` });
        } else {
          stats.submitted += 1;
        }
      } catch (e) {
        stats.failed += 1;
        detail.push({
          id: nextFeedbackId(),
          text: `${name}：提交失败（${e instanceof Error ? e.message : '请求错误'}）`,
        });
      } finally {
        done += 1;
        setProgress({ done, total: ids.length });
      }
    }
    setActiveUpdateId(null);
    setProgress(null);
    const lines = { summary: summarizeBatchUpdates(stats), detail };
    // 先等列表重取完成再展示反馈：反馈与刷新后的表格同帧出现。
    // 锁保持到重取结束：重取窗口内不可叠加新批量（与 runPolicy 语义一致）。
    await refreshQuietly(refresh);
    setResult(lines);
    release();
    return lines;
  };

  const runPolicy = async (ids: number[], policy: Policy): Promise<void> => {
    const release = acquire();
    if (release == null) {
      setResult({ summary: '已有批量任务进行中，本次未执行。', detail: [] });
      return;
    }
    try {
      const res = await api.batchPolicy(ids, policy);
      // 成功数来自 API（去重后的实际目标数），与提交数可能不同。
      // 先等列表重取完成再展示反馈：反馈与刷新后的表格同帧出现。
      await refreshQuietly(refresh);
      setResult({ summary: `已将 ${res.updated} 项资源策略设置完成。`, detail: [] });
    } catch (err) {
      // 整批原子失败：展示「整批未保存」与逐项原因，策略保持原值。
      const detail: FeedbackLine[] = [];
      if (err instanceof ApiError && err.status === 409) {
        const rejected =
          (
            err.details as
              | { rejected?: Array<{ resourceId: number; name: string; reason: string }> }
              | undefined
          )?.rejected ?? [];
        for (const r of rejected) {
          detail.push({
            id: nextFeedbackId(),
            text: `${r.name || `#${r.resourceId}`}：${r.reason}`,
          });
        }
      }
      setResult({
        summary: `策略整批未保存：${err instanceof Error ? err.message : '请求错误'}`,
        detail,
      });
      await refreshQuietly(refresh);
    } finally {
      release();
    }
  };

  /**
   * Serial batch confirm over a frozen {jobId, digest} snapshot. Only real 2xx
   * responses count as confirmed; a 409/404 means the task already moved on
   * (auto-check won, retried, or resource removed) and is reported as a skip.
   */
  const runConfirmations = async (items: ConfirmItem[]): Promise<BatchLines> => {
    const release = acquire();
    if (release == null) return { summary: '已有批量任务进行中，本次未执行。', detail: [] };
    setProgress({ done: 0, total: items.length });
    const stats: BatchConfirmStats = { confirmed: 0, skipped: 0, failed: 0 };
    const detail: FeedbackLine[] = [];
    let done = 0;
    for (const item of items) {
      setActiveConfirmId(item.resourceId);
      try {
        await api.confirmJob(item.jobId, item.candidateDigest);
        stats.confirmed += 1;
        detail.push({ id: nextFeedbackId(), text: confirmItemFeedback(item) });
      } catch (e) {
        if (e instanceof ApiError && isStaleConfirmError(e.status)) {
          stats.skipped += 1;
          detail.push({
            id: nextFeedbackId(),
            text: `${item.resourceName}：状态已变化，已跳过（${e.message}）`,
          });
        } else {
          stats.failed += 1;
          detail.push({
            id: nextFeedbackId(),
            text: `${item.resourceName}：确认失败（${e instanceof Error ? e.message : '请求错误'}），请刷新后核对`,
          });
        }
      } finally {
        done += 1;
        setProgress({ done, total: items.length });
      }
    }
    setActiveConfirmId(null);
    setProgress(null);
    const lines = { summary: summarizeBatchConfirmations(stats), detail };
    // 先等列表重取完成再展示反馈：反馈与刷新后的表格同帧出现。
    // 锁保持到重取结束：重取窗口内不可叠加新批量（与 runPolicy 语义一致）。
    await refreshQuietly(refresh);
    setResult(lines);
    release();
    return lines;
  };

  return {
    busy,
    /** 页面把同一把锁传给 useCheckOne/useUpdateOne，实现单项/批量互斥。 */
    acquire,
    activeCheckId,
    activeUpdateId,
    activeConfirmId,
    progress,
    result,
    setResult,
    runChecks,
    runUpdates,
    runConfirmations,
    runPolicy,
  };
}

/**
 * Single-resource check mutation with named outcome feedback.
 * lock.acquire 与批量共用一把页面级同步锁：单项执行期间批量被拒，
 * 批量进行中单项同样被拒（任一方向都不产生并发重复请求）。
 */
export function useCheckOne(
  nameOf: (id: number) => string,
  onFeedback: (line: string) => void,
  lock: { acquire(): (() => void) | null },
) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (id: number) => {
      const release = lock.acquire();
      if (release == null) throw new Error('已有批量任务进行中，请稍后再试');
      try {
        return await api.checkResource(id);
      } finally {
        // 等列表重取完成再释放，与批量 busy-to-refresh 窗口语义一致。
        await refresh();
        release();
      }
    },
    // 结果走行内反馈区；错误同样由 onError 落到反馈区，全局兑底跳过。
    meta: { errorFeedback: 'local' },
    onSuccess: (res, id) => {
      onFeedback(checkOutcomeFeedback(nameOf(id), res.check.outcome, res.check.message).text);
    },
    onError: (e, id) => {
      onFeedback(`${nameOf(id)}：检查失败（${e instanceof Error ? e.message : '请求错误'}）`);
    },
  });
}

/** Single-resource skip-preview update mutation; shares the page action lock. */
export function useUpdateOne(
  nameOf: (id: number) => string,
  onFeedback: (line: string) => void,
  lock: { acquire(): (() => void) | null },
) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (id: number) => {
      const release = lock.acquire();
      if (release == null) throw new Error('已有批量任务进行中，请稍后再试');
      try {
        return await api.executeUpdate(id);
      } finally {
        await refresh();
        release();
      }
    },
    meta: { errorFeedback: 'local' },
    onSuccess: (res, id) => {
      if (res.skipped) onFeedback(`${nameOf(id)}：无更新，已跳过`);
      else onFeedback(`${nameOf(id)}：更新任务已提交`);
    },
    onError: (e, id) => {
      onFeedback(`${nameOf(id)}：提交失败（${e instanceof Error ? e.message : '请求错误'}）`);
    },
  });
}
