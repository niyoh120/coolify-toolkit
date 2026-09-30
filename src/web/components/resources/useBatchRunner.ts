// Shared batch runner for check/update/policy flows: serial execution with
// per-item feedback and business-outcome statistics (blocked counts as skip).

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { Policy } from '../../../shared/types.js';
import { api } from '../../lib/api.js';
import {
  type BatchCheckStats,
  type BatchUpdateStats,
  checkOutcomeFeedback,
  classifyCheckOutcome,
  summarizeBatchChecks,
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
    setBusy(false);
    const lines = { summary: summarizeBatchChecks(stats), detail };
    setResult(lines);
    refresh();
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
    setBusy(false);
    const lines = { summary: summarizeBatchUpdates(stats), detail };
    setResult(lines);
    refresh();
    return lines;
  };

  const runPolicy = async (ids: number[], policy: Policy): Promise<void> => {
    setBusy(true);
    try {
      await api.batchPolicy(ids, policy);
      setResult({ summary: `已将 ${ids.length} 项资源策略设置完成。`, detail: [] });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    activeCheckId,
    activeUpdateId,
    progress,
    result,
    setResult,
    runChecks,
    runUpdates,
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
      refresh();
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
      refresh();
    },
    onError: (e, id) => {
      onFeedback(`${nameOf(id)}：提交失败（${e instanceof Error ? e.message : '请求错误'}）`);
    },
  });
}
