# 操作反馈回归验证

覆盖异步操作的可见反馈闭环：进行中、成功、部分完成、失败（协议/业务/网络）、共享同步防重、复制反馈。
技术栈：Sonner toast（全局唯一 Toaster）+ TanStack Query `MutationCache.onError` 兜底 + `useSyncAction` 共享同步控制器。

## 运行方式

前置条件与响应式回归相同（agent-browser CLI + Chromium，仅绑定 127.0.0.1）：

```bash
npm run test:feedback              # = npm run build:web + node scripts/verify-feedback.mjs
node scripts/verify-feedback.mjs --shots /some/dir   # 自定义产物目录
```

退出码：`0` 全部断言通过；`1` 存在断言失败；`2` 环境阻塞。
产物（失败截图 + `results.json`）默认写入 `os.tmpdir()/coolify-feedback-<时间戳>`。

fixture：复用 `tests/fixtures/responsive-ui.mjs`，新增控制端点（页面自身永不触碰）：

- `POST /api/__fixture/sync-control`：`delayMs` 延迟、`mode`（`ok` / `partial` / `json502` / `html503` / `rate-limit` / `rate-limit-no-retry` / `network`）、`resetHits` 清零 `/api/sync` 请求计数。
- `POST /api/__fixture/action-control`：`probeOk`（连接探测业务结果）、`redeliverOk`（通知补发业务结果）。

## 回归场景（scripts/verify-feedback.mjs）

**A. 共享同步生命周期**
- 桌面侧栏触发同步：按钮进入「同步中…」+ disabled + `aria-busy`，出现 loading toast；完成后原地更新为成功摘要（扫描/新增/外部变更/移除）。
- 概览「同步资源」、侧栏、顶栏同时连点：共享同一 Promise，`/api/sync` 仅 1 个请求、仅 1 个 loading toast。
- 同步中途切换路由（概览 → 设置）：请求与 toast 生命周期照常完成，成功反馈仍出现（Provider 位于路由内容之外）。

**B. 失败路径（协议分层）**
- JSON 502 / HTML 503：显示「服务暂时不可用（HTTP 50x）」，按钮 finally 恢复可点。
- 限流（`coolify_rate_limited`）：带 Retry-After 显示「请在 45 秒后重试」；缺失时显示「请稍后重试」；凭状态码推断被禁止。
- 网络拒绝（fixture 直接 destroy 连接）：显示「网络异常，请求未完成」。

**C. 业务结果区分**
- `errors` 非空：显示「同步部分完成（N 处失败）」+ 详情，同时断言成功 toast 未出现（200 ≠ 全部成功）。
- 设置探测 `ok:false`：显示「Coolify 连接失败」；`ok:true` 显示「连接正常（版本）」。
- 通知补发 `ok:false`：显示「补发失败」，队列仍刷新。
- 概览立即检查：显示「检查请求已完成，处理 N 项」并注明以列表徽标为准，宣称全部检查成功的表述被禁止。

**D. 复制与移动端**
- 复制成功：可控 Promise 门控验证 busy 期间按钮禁用、内容与展示字符串一致、提示「已复制」。
- 复制拒绝（Promise rejection）：显示「复制失败」，`unhandledrejection` 捕获为空。
- Clipboard API 缺失：显示「无法复制：当前环境不可用 Clipboard API」。
- 延迟复制期间重复点击：仅写入一次剪贴板。
- 375px 宽度：顶栏同步入口可用，错误 toast 出现且页面无横向溢出。

## 全局/局部错误归属约定

页面已有内联错误展示的 mutation 必须声明 `meta: { errorFeedback: 'local' }`（TanStack Register 已将 `defaultMutationMeta` 类型化），
避免 MutationCache 兜底与内联提示重复弹错；未声明的 mutation 失败由 `main.tsx` 的 `MutationCache.onError` 全局弹一次。
新增操作按钮时按此约定选择归属，并在对应脚本补一条可见反馈断言。
