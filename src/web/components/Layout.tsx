// Coolify-style sidebar: section labels, inline icons, elevated active state.
import type { ReactNode } from 'react';
import { api } from '../lib/api.js';
import { useRefresh } from '../main.js';
import { Badge, Button } from './ui.js';

export type PageName =
  | 'overview'
  | 'resources'
  | 'resource'
  | 'history'
  | 'notifications'
  | 'settings';

function Icon({ name }: { name: NavIcon }): ReactNode {
  const paths: Record<NavIcon, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </>
    ),
    resources: (
      <>
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </>
    ),
    notifications: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

type NavIcon = 'overview' | 'resources' | 'notifications' | 'settings';

const NAV_SECTIONS: Array<{
  label: string;
  items: Array<{ key: PageName; label: string; icon: NavIcon }>;
}> = [
  {
    label: '工作区',
    items: [
      { key: 'overview', label: '概览', icon: 'overview' },
      { key: 'resources', label: '资源', icon: 'resources' },
      // 更新历史从资源页顶部子 Tab 进入，不再重复出现在侧边栏。
    ],
  },
  {
    label: '管理',
    items: [
      { key: 'notifications', label: '通知', icon: 'notifications' },
      { key: 'settings', label: '设置', icon: 'settings' },
    ],
  },
];

export function Layout({
  page,
  navigate,
  paused,
  children,
}: {
  page: PageName;
  navigate: (page: PageName | { page: 'resource'; id: number }) => void;
  paused: boolean;
  children: ReactNode;
}) {
  const refresh = useRefresh();
  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="flex shrink-0 flex-row items-center gap-2 border-b border-[var(--color-border-base)] bg-[var(--color-bg-raised)] px-3 py-2 md:h-full md:w-52 md:flex-col md:items-stretch md:gap-1 md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-4">
        <div className="mr-2 flex items-center gap-2 md:mb-4 md:mr-0">
          <svg aria-hidden="true" viewBox="0 0 32 32" className="h-5 w-5">
            <rect x="1" y="1" width="30" height="30" rx="7" fill="#805ad5" />
            <path
              d="M22.5 11.2a8 8 0 1 0 .1 9.5"
              fill="none"
              stroke="#fff"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </svg>
          <span className="text-[14px] font-semibold tracking-tight">Coolify Toolkit</span>
        </div>
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="md:mb-1">
            <div className="hidden px-2.5 pt-2 pb-1 text-[11px] tracking-wide text-[var(--color-text-muted)] md:block">
              {section.label}
            </div>
            <div className="flex flex-row gap-1 md:flex-col">
              {section.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => navigate(item.key)}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                    page === item.key
                      ? 'bg-[var(--color-bg-overlay)] text-[var(--color-text-primary)]'
                      : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-overlay)]/60 hover:text-[var(--color-text-primary)]'
                  }`}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="mt-auto hidden items-center gap-2 md:flex">
          {paused && <Badge tone="warning">全局已暂停</Badge>}
          <Button
            variant="ghost"
            title="从 Coolify 重新同步资源"
            onClick={() => {
              void api.sync().then(refresh);
            }}
          >
            重新同步
          </Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
    </div>
  );
}
