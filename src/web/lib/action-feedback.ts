// 操作反馈共享层：Sonner toast 生命周期常量、错误文案格式化与类型化归属。
// 原则：request 层解析数据/错误（lib/api.ts），这里只负责把错误变成人话；
// 页面局部错误用 meta.errorFeedback: 'local' 显式退出全局兜底。

import type { Mutation } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Sonner Toaster 上的默认展示时长；成功短、错误长（可关闭）。 */
export const FEEDBACK = {
  successMs: 4_000,
  errorMs: 10_000,
} as const;

/** 类型化 mutation.meta：声明错误提示归属，避免全局与局部重复弹错。 */
export type ActionFeedbackMeta = {
  /** 'local' = 页面已有内联/弹窗展示，全局兜底跳过；缺省 = 'global'。 */
  errorFeedback?: 'local' | 'global';
  /** 可选操作名（如「保存设置」）；全局错误 toast 标题带上它便于定位。 */
  actionName?: string;
};

declare module '@tanstack/react-query' {
  interface Register {
    // query-core 读取 Register.mutationMeta 缩窄 MutationMeta（非 defaultMutationMeta）。
    mutationMeta: ActionFeedbackMeta;
  }
}

export interface ActionErrorLike {
  code?: string;
  message?: string;
  status?: number;
  details?: unknown;
}

/** 把任意抛出的值转成可读的动作错误描述；纯文本渲染，避免富文本注入面。 */
export function formatActionError(
  err: unknown,
  actionName?: string,
): { title: string; description?: string } {
  const apiErr = (err ?? null) as ActionErrorLike | null;
  const prefix = actionName != null ? `${actionName}失败` : '操作失败';
  // 限流：仅凭明确错误码判定，不凭 502/503 状态码猜测。
  if (apiErr?.code === 'coolify_rate_limited') {
    const seconds = (apiErr.details as { retryAfterSeconds?: number } | null | undefined)
      ?.retryAfterSeconds;
    return {
      title: `${prefix}：Coolify 请求过于频繁`,
      description:
        seconds != null
          ? `请在 ${seconds} 秒后重试；期间重复点击只会延长等待。`
          : '请稍后重试；期间重复点击只会延长等待。',
    };
  }
  // 浏览器 fetch 网络层失败（断网/DNS/拒绝连接）以 TypeError 抛出。
  if (err instanceof TypeError) {
    return {
      title: `${prefix}：网络异常`,
      description: '无法连接到服务端，请检查网络后重试。',
    };
  }
  const status = apiErr?.status;
  const message =
    apiErr?.message ?? (err instanceof Error ? err.message : String(err ?? '请求错误'));
  // 网关/代理层错误通常是 HTML 文本（无业务 message），给中文说明与状态码。
  if (status === 502 || status === 503) {
    return {
      title: `${prefix}：服务暂时不可用（HTTP ${status}）`,
      description: message.startsWith('HTTP ') ? '网关或上游服务返回错误，请稍后重试。' : message,
    };
  }
  return {
    title: prefix,
    description: status != null ? `${message}（HTTP ${status}）` : message,
  };
}

/** MutationCache.onError：全局兜底，只在未显式声明 local 时弹错。 */
export function mutationErrorFeedback(
  error: unknown,
  _variables: unknown,
  _context: unknown,
  mutation: Mutation<unknown, unknown, unknown>,
): void {
  const scope = mutation.meta?.errorFeedback ?? 'global';
  if (scope === 'local') return;
  const { title, description } = formatActionError(error, mutation.meta?.actionName);
  toast.error(title, { description, duration: FEEDBACK.errorMs, closeButton: true });
}

/** /api/sync 响应体（api.sync.errors 已在 T2 补齐）。 */
export interface SyncFeedbackSummary {
  resourcesSeen: number;
  created: number;
  externalChanges: number;
  removed: number;
  errors?: string[];
}

/**
 * 同步成功摘要。resourcesSeen 是父服务/应用的扫描计数，沿用服务端语义，
 * 不宣称包含全部子容器。
 */
export function formatSyncSuccess(s: SyncFeedbackSummary): string {
  return `扫描 ${s.resourcesSeen} 项 · 新增 ${s.created} · 外部变更 ${s.externalChanges} · 移除 ${s.removed}`;
}

/** errors 非空时的部分完成文案：失败条数 + 简洁详情（每条一行）。 */
export function formatSyncPartial(s: SyncFeedbackSummary): {
  title: string;
  description: string;
} {
  const errors = s.errors ?? [];
  const detail = errors.slice(0, 3).join('\n');
  return {
    title: `同步部分完成（${errors.length} 处失败）`,
    description: detail === '' ? '部分资源同步失败，详情见服务端日志。' : detail,
  };
}
