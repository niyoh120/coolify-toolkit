// shadcn-style primitives tuned to the Coolify graphite theme.

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'default' | 'accent' | 'danger' | 'ghost' | 'outline';

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const styles: Record<ButtonVariant, string> = {
    default:
      'border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)] hover:bg-[var(--color-border-base)]',
    accent:
      'border-transparent bg-[var(--color-accent)] text-[#0b0b0d] hover:bg-[var(--color-accent-strong)]',
    danger:
      'border-[var(--color-danger)]/40 bg-transparent text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
    ghost:
      'border-transparent bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)] hover:text-[var(--color-text-primary)]',
    outline:
      'border-[var(--color-border-strong)] bg-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-bg-overlay)]',
  };
  return <button className={cn(base, styles[variant], className)} {...props} />;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'rounded border border-[var(--color-border-base)] bg-[var(--color-bg-raised)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-base)] px-4 py-2.5">
      <h2 className="min-w-0 text-[13px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
        {title}
      </h2>
      {actions != null && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('p-4', className)}>{children}</div>;
}

const badgeTones = {
  neutral: 'text-[var(--color-text-secondary)]',
  success: 'text-[var(--color-success)] border-[var(--color-success)]/40',
  warning: 'text-[var(--color-warning)] border-[var(--color-warning)]/40',
  danger: 'text-[var(--color-danger)] border-[var(--color-danger)]/40',
  info: 'text-[var(--color-info)] border-[var(--color-info)]/40',
  accent: 'text-[var(--color-accent)] border-[var(--color-accent)]/40',
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({
  tone = 'neutral',
  children,
  title,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
  /** 受控换行等场景追加的类；默认保持单行紧凑。 */
  className?: string;
}) {
  return (
    <span className={cn('badge', badgeTones[tone], className)} title={title}>
      {children}
    </span>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full min-w-0 rounded border border-[var(--color-border-base)] bg-[var(--color-bg-input)] px-2.5 py-1.5 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'max-w-full min-w-0 rounded border border-[var(--color-border-base)] bg-[var(--color-bg-input)] px-2 py-1.5 text-[13px] text-[var(--color-text-primary)]',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Table({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState({ overflow: false, atStart: true, atEnd: true });

  // 溢出/边界状态：数据、窗口与内容尺寸变化后重算；状态不变时不触发重渲染。
  const syncEdge = useCallback(() => {
    const el = scrollRef.current;
    if (el == null) return;
    const overflow = el.scrollWidth - el.clientWidth > 1;
    const atStart = el.scrollLeft <= 1;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setEdge((prev) =>
      prev.overflow === overflow && prev.atStart === atStart && prev.atEnd === atEnd
        ? prev
        : { overflow, atStart, atEnd },
    );
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el == null) return;
    syncEdge();
    const observer = new ResizeObserver(syncEdge);
    observer.observe(el);
    const table = el.querySelector('table');
    if (table != null) observer.observe(table);
    el.addEventListener('scroll', syncEdge, { passive: true });
    window.addEventListener('resize', syncEdge);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', syncEdge);
      window.removeEventListener('resize', syncEdge);
    };
  }, [syncEdge]);

  const nudge = (direction: -1 | 1): void => {
    const el = scrollRef.current;
    if (el == null) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.9), behavior: 'smooth' });
  };

  const arrowClass =
    'inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border-base)] bg-[var(--color-bg-overlay)] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div>
      {edge.overflow && (
        <div className="flex items-center justify-between gap-2 px-3 pt-2 text-[12px] text-[var(--color-text-muted)]">
          <span data-table-hint>内容较宽，可左右滚动查看全部列</span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-table-scroll="left"
              aria-label="向左滚动表格"
              title="向左滚动表格"
              disabled={edge.atStart}
              className={arrowClass}
              onClick={() => nudge(-1)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              data-table-scroll="right"
              aria-label="向右滚动表格"
              title="向右滚动表格"
              disabled={edge.atEnd}
              className={arrowClass}
              onClick={() => nudge(1)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </span>
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: 滚动容器无对应语义元素，region+名称是可访问滚动区的标准模式 */}
      <div
        ref={scrollRef}
        role="region"
        aria-label={ariaLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 键盘用户需要焦点入口才能滚动表格区域（WCAG 2.1）
        tabIndex={0}
        data-allowed-scroll="true"
        className="table-scroll"
      >
        <table className="w-full border-separate border-spacing-0 text-[13px]">{children}</table>
      </div>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 border-b border-[var(--color-border-base)] bg-[var(--color-bg-raised)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  title,
}: {
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn(
        'border-b border-[var(--color-border-base)]/60 px-3 py-2 align-middle',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function Mono({ children, copyable }: { children: ReactNode; copyable?: boolean }) {
  const text = typeof children === 'string' ? children : undefined;
  return (
    <span className="mono text-[var(--color-text-secondary)]" title={text}>
      {copyable && text != null ? (
        <button
          type="button"
          className="mono cursor-pointer text-[var(--color-text-secondary)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
          onClick={() => void navigator.clipboard.writeText(text)}
          title="点击复制完整值"
        >
          {children}
        </button>
      ) : (
        children
      )}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

export function Loading() {
  return (
    <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">加载中…</div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="m-4 rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 px-4 py-3 text-[13px] text-[var(--color-danger)]">
      出错：{message}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  unit = '项',
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  /** 计数单位：资源页为“项”，服务 Tab 按组计数为“组”。 */
  unit?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= 0) return null;
  // 数据收缩（保留裁剪、过滤、刷新）后页码可能越界：收敛到有效范围。
  const current = Math.min(page, pages);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-[var(--color-border-base)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
      <span>
        共 {total} {unit} · 第 {current} / {pages} 页
      </span>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" disabled={current <= 1} onClick={() => onChange(current - 1)}>
          上一页
        </Button>
        <Button variant="ghost" disabled={current >= pages} onClick={() => onChange(current + 1)}>
          下一页
        </Button>
      </div>
    </div>
  );
}

/** Coolify-style underlined page tab (e.g. the "Resources" heading tab). */
export function HeadingTab({
  active,
  children,
  onClick,
}: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 pb-1.5 text-[15px] font-medium whitespace-nowrap transition-colors ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
          : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}

/** Coolify-style segmented control (e.g. "Managed | Unmanaged"). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <fieldset
      aria-label={ariaLabel}
      className="inline-flex rounded-lg border border-[var(--color-border-base)] bg-[var(--color-bg-raised)] p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-3 py-1 text-[12.5px] transition-colors ${
            value === opt.value
              ? 'bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </fieldset>
  );
}

/** Search input with a leading magnifier icon, Coolify style. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="relative w-full max-w-[340px]">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-[var(--color-border-base)] bg-[var(--color-bg-input)] py-1.5 pr-3 pl-8 text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-border-strong)] focus:outline-none"
      />
    </div>
  );
}

/** Coolify-style status pill: colored dot + label on a dark rounded background. */
export function StatusPill({
  tone,
  children,
}: {
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  children: ReactNode;
}) {
  const dotColor = {
    success: 'bg-[var(--color-success)]',
    danger: 'bg-[var(--color-danger)]',
    warning: 'bg-[var(--color-warning)]',
    neutral: 'bg-[var(--color-text-muted)]',
  }[tone];
  return (
    <span className="inline-flex max-w-[190px] items-center gap-1.5 rounded-full bg-[var(--color-bg-overlay)] px-2.5 py-1 text-[12px] whitespace-nowrap text-[var(--color-text-secondary)]">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Minimal modal dialog for destructive-action confirmations. */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // onClose 通常是内联箭头，身份随父渲染变化；用 ref 保存最新回调，
  // 避免父组件在弹窗打开期间重渲染时反复重置焦点。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    // 打开时把焦点移入弹窗：Tab 循环从这里开始，标题/操作可达。
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-md flex-col rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-raised)] p-4 shadow-xl outline-none focus-visible:outline-none"
      >
        <div
          data-modal-title
          className="shrink-0 pb-2 text-[14px] font-semibold text-[var(--color-text-primary)]"
        >
          {title}
        </div>
        <div
          data-modal-body
          className="flex min-h-0 flex-col gap-2 overflow-y-auto py-2 text-[13px] text-[var(--color-text-secondary)]"
        >
          {children}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-3">{footer}</div>
      </div>
    </div>
  );
}

let TIMEZONE_CACHE: string[] | null = null;

function allTimezones(): string[] {
  if (TIMEZONE_CACHE != null) return TIMEZONE_CACHE;
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    TIMEZONE_CACHE = supported != null ? supported('timeZone') : ['UTC'];
  } catch {
    TIMEZONE_CACHE = ['UTC'];
  }
  return TIMEZONE_CACHE;
}

/** IANA 时区可检索下拉（Coolify 同款交互：输入过滤 + 点击选择）。 */
export function TimezoneSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const zones = allTimezones().filter((z) => z.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="relative w-full max-w-full sm:max-w-[280px]">
      <Input
        id={id}
        value={open ? query : value}
        placeholder="搜索时区（如 Asia/Shanghai）"
        className="mono"
        autoComplete="off"
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded border border-[var(--color-border-strong)] bg-[var(--color-bg-raised)] shadow-xl">
          {zones.length === 0 && (
            <div className="px-2.5 py-1.5 text-[12px] text-[var(--color-text-muted)]">
              无匹配时区
            </div>
          )}
          {zones.map((z) => (
            <button
              key={z}
              type="button"
              className={`block w-full px-2.5 py-1.5 text-left text-[12px] mono hover:bg-[var(--color-bg-overlay)] ${
                z === value ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-primary)]'
              }`}
              onClick={() => {
                onChange(z);
                setOpen(false);
              }}
            >
              {z}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
