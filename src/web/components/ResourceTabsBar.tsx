// Shared sub-tab bar for the resources workspace: 应用 | 服务 | 更新历史.
// Resources (both tabs) and history pages render the same bar so switching
// keeps the navigation visible; the refresh button lives here too.

import { api } from '../lib/api.js';
import { useRefresh, useRouter } from '../main.js';
import { Button, HeadingTab } from './ui.js';

export type ResourceWorkspaceTab = 'applications' | 'services' | 'history';

function RefreshButton() {
  const refresh = useRefresh();
  return (
    <Button
      variant="outline"
      title="从 Coolify 重新同步资源"
      onClick={() => {
        void api.sync().then(refresh);
      }}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="mr-1 h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      刷新
    </Button>
  );
}

export function ResourceTabsBar({ active }: { active: ResourceWorkspaceTab }) {
  const { navigate } = useRouter();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-base)] pb-2">
      <div className="flex items-center gap-5">
        <HeadingTab
          active={active === 'applications'}
          onClick={() => navigate({ page: 'resources', tab: 'applications' })}
        >
          应用
        </HeadingTab>
        <HeadingTab
          active={active === 'services'}
          onClick={() => navigate({ page: 'resources', tab: 'services' })}
        >
          服务
        </HeadingTab>
        <HeadingTab active={active === 'history'} onClick={() => navigate({ page: 'history' })}>
          更新历史
        </HeadingTab>
      </div>
      <RefreshButton />
    </div>
  );
}
