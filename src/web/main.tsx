// App shell: sidebar navigation + polling queries.
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import './styles.css';
import type { PageName } from './components/Layout.js';
import { Layout } from './components/Layout.js';
import { SyncActionProvider } from './components/SyncActionProvider.js';
import { FEEDBACK, mutationErrorFeedback } from './lib/action-feedback.js';
import { api } from './lib/api.js';
import {
  parseResourceTab,
  type ResourceTab,
  resourceDetailHash,
  resourcesHash,
} from './lib/resource-route.js';
import { HistoryPage } from './pages/History.js';
import { NotificationsPage } from './pages/Notifications.js';
import { OverviewPage } from './pages/Overview.js';
import { ResourceDetailPage } from './pages/ResourceDetail.js';
import { ResourcesPage } from './pages/Resources.js';
import { SettingsPage } from './pages/Settings.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchInterval: 10_000, retry: 1, staleTime: 5_000 },
  },
  // 全局错误兜底：未显式声明 meta.errorFeedback:'local' 的 mutation 失败时
  // 弹一次错误 toast；页面内已有内联/弹窗错误的调用点显式选 local。
  mutationCache: new MutationCache({
    onError: mutationErrorFeedback,
  }),
});

type Route =
  | { page: 'overview' }
  | { page: 'resources'; tab: ResourceTab }
  | { page: 'resource'; id: number }
  | { page: 'history' }
  | { page: 'notifications' }
  | { page: 'settings' };

interface RouterCtx {
  route: Route;
  navigate(route: Route): void;
}

const RouterContext = createContext<RouterCtx>({
  route: { page: 'overview' },
  navigate: () => undefined,
});

export function useRouter(): RouterCtx {
  return useContext(RouterContext);
}

// Hash-based routing: refresh/back/forward stay inside the SPA and survive
// reloads (works behind Traefik without server-side rewrites).
// 先分离路径与查询参数：`#/resources?tab=services` 携带资源 Tab 状态。
function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? undefined : raw.slice(queryIndex + 1);
  if (path.startsWith('/resources/')) {
    const id = Number.parseInt(path.slice('/resources/'.length), 10);
    if (Number.isInteger(id) && id > 0) return { page: 'resource', id };
  }
  switch (path) {
    case '/resources':
      // 缺省或非法 tab 回落到应用 Tab。
      return { page: 'resources', tab: parseResourceTab(query) };
    case '/history':
      return { page: 'history' };
    case '/notifications':
      return { page: 'notifications' };
    case '/settings':
      return { page: 'settings' };
    default:
      return { page: 'overview' };
  }
}

function hashFor(route: Route): string {
  if (route.page === 'resource') return resourceDetailHash(route.id);
  if (route.page === 'resources') return resourcesHash(route.tab);
  return route.page === 'overview' ? '#/' : `#/${route.page}`;
}

function Shell(): ReactNode {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((r: Route): void => {
    // Same-hash writes are no-ops (no history spam); different hashes push a
    // history entry and hashchange drives the re-render.
    if (window.location.hash !== hashFor(r)) window.location.hash = hashFor(r);
  }, []);
  const router = useMemo(() => ({ route, navigate }), [route, navigate]);
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const navigateFromLayout = useCallback(
    (target: PageName | { page: 'resource'; id: number }): void => {
      navigate(
        typeof target === 'object'
          ? target
          : target === 'resource'
            ? { page: 'resources', tab: 'applications' }
            : target === 'resources'
              ? { page: 'resources', tab: 'applications' }
              : { page: target },
      );
    },
    [navigate],
  );
  return (
    <RouterContext.Provider value={router}>
      <Layout
        page={route.page}
        navigate={navigateFromLayout}
        paused={overview.data?.globalPaused ?? false}
      >
        {route.page === 'overview' && <OverviewPage />}
        {route.page === 'resources' && <ResourcesPage tab={route.tab} />}
        {/* key 保证切换资源 id 时重置详情页内部的预览/错误/选择状态。 */}
        {route.page === 'resource' && <ResourceDetailPage key={route.id} id={route.id} />}
        {route.page === 'history' && <HistoryPage />}
        {route.page === 'notifications' && <NotificationsPage />}
        {route.page === 'settings' && <SettingsPage />}
      </Layout>
    </RouterContext.Provider>
  );
}
// Refresh invalidation helper shared by mutation flows. Resolves when the
// invalidated active queries have finished refetching, so batch flows can
// sequence their result feedback behind fresh list data. Refetch failures are
// swallowed here: callers own their action feedback; the 10s polling and the
// next invalidation keep retrying the read.
export function useRefresh(): () => Promise<void> {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries().catch(() => {
      // 刷新失败与写操作结果分离；周期轮询会继续恢复数据。
    });
}

export function main(): void {
  const root = document.getElementById('root');
  if (root == null) throw new Error('missing #root');
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      {/* 同步控制器放路由内容之外：切换页面仍完成请求与反馈。 */}
      <SyncActionProvider>
        <Shell />
      </SyncActionProvider>
      {/* 暗色、右上角、带关闭按钮；颜色变量由 styles.css 中的 Sonner 覆盖统一。 */}
      <Toaster
        theme="dark"
        position="top-right"
        closeButton
        duration={FEEDBACK.successMs}
        toastOptions={{
          classNames: {
            toast: 'sonner-toast-item',
            title: 'sonner-toast-title',
            description: 'sonner-toast-description',
          },
        }}
      />
    </QueryClientProvider>,
  );
}

const rootEl = document.getElementById('root');
if (rootEl != null) {
  main();
}
