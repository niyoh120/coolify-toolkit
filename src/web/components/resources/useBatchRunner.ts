// Shared batch runner for check/update/policy flows: serial execution with
// per-item feedback and business-outcome statistics (blocked counts as skip).

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
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

export function useBatchRunner() {
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [activeCheckId, setActiveCheckId] = useState<number | null>(null);
  const [activeUpdateId, setActiveUpdateId] = useState<number | null>(null);
  const [activeConfirmId, setActiveConfirmId] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<BatchLines | null>(null);

  /** Serial batch check: stats by business outcome, detail lines for skips/failures. */
  const runChecks = async (ids: number[], nameOf: (id: number) => string): Promise<BatchLines> => {
    setBusy(true);
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
    // busy 保持到重取结束：重取窗口内不可叠加新批量（与 runPolicy 语义一致）。
    await refresh();
    setResult(lines);
    setBusy(false);
    return lines;
  };

  /** Serial batch update via skipPreview; 202=submitted, skipped=no-update. */
  const runUpdates = async (ids: number[], nameOf: (id: number) => string): Promise<BatchLines> => {
    setBusy(true);
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
    // busy 保持到重取结束：重取窗口内不可叠加新批量（与 runPolicy 语义一致）。
    await refresh();
    setResult(lines);
    setBusy(false);
    return lines;
  };

  const runPolicy = async (ids: number[], policy: Policy): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.batchPolicy(ids, policy);
      // 成功数来自 API（去重后的实际目标数），与提交数可能不同。
      // 先等列表重取完成再展示反馈：反馈与刷新后的表格同帧出现。
      await refresh();
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
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Serial batch confirm over a frozen {jobId, digest} snapshot. Only real 2xx
   * responses count as confirmed; a 409/404 means the task already moved on
   * (auto-check won, retried, or resource removed) and is reported as a skip.
   */
  const runConfirmations = async (items: ConfirmItem[]): Promise<BatchLines> => {
    setBusy(true);
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
    // busy 保持到重取结束：重取窗口内不可叠加新批量（与 runPolicy 语义一致）。
    await refresh();
    setResult(lines);
    setBusy(false);
    return lines;
  };

  return {
    busy,
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

/** Single-resource check mutation with named outcome feedback. */
export function useCheckOne(nameOf: (id: number) => string, onFeedback: (line: string) => void) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: number) => api.checkResource(id),
    onSuccess: (res, id) => {
      onFeedback(checkOutcomeFeedback(nameOf(id), res.check.outcome, res.check.message).text);
      void refresh();
    },
    onError: (e, id) => {
      onFeedback(`${nameOf(id)}：检查失败（${e instanceof Error ? e.message : '请求错误'}）`);
    },
  });
}

/** Single-resource skip-preview update mutation. */
export function useUpdateOne(nameOf: (id: number) => string, onFeedback: (line: string) => void) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: number) => api.executeUpdate(id),
    onSuccess: (res, id) => {
      if (res.skipped) onFeedback(`${nameOf(id)}：无更新，已跳过`);
      else onFeedback(`${nameOf(id)}：更新任务已提交`);
      void refresh();
    },
    onError: (e, id) => {
      onFeedback(`${nameOf(id)}：提交失败（${e instanceof Error ? e.message : '请求错误'}）`);
    },
  });
}
