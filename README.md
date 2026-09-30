# Coolify Toolkit

Homelab 伴侣服务：集中管理 Coolify 中第三方容器镜像的更新。从 Coolify 自动发现资源，追踪指定 tag 的上游内容变化，按资源策略（忽略 / 通知 / 自动更新）执行，并以 **digest 固定** 保证部署目标的确定性对比。

## 核心模型

- **追踪来源（source）**：`registry/repository:tag`，例如 `docker.io/jellyfin/jellyfin:latest`。固定摘要后继续保留，作为持续观察通道。
- **配置摘要（configured digest）**：最近写入 Coolify 的部署目标。首次“更新并固定摘要”会把 tag 固定为当时的顶层 index/manifest 摘要。
- **候选更新**：追踪 tag 的远端摘要 ≠ 配置摘要（含上游回退）。发现策略为“同 tag 内容变化”；跨 tag 升级（如 1.x→2.x）不在首期范围。
- **成功证据**：仅当可关联 Coolify deployment 完成记录时推进（Application）。Compose 子容器首期只有 queued 证据，默认“已提交 / 待确认”，人工确认单独记录来源。

## 快速开始（开发）

```bash
mise install                # Node 24.19.0
npm ci
cp .env.example .env        # 填入 COOLIFY_BASE_URL / COOLIFY_API_KEY
npm run dev                 # Vite :5173 (代理 /api) + API :8080
npm run check               # typecheck + lint + test + build
```

## 生产部署

见 `compose.yaml` 与 `.env.example`。要点：

1. **鉴权由 Traefik 承担**：UI 与 `/api/*` 共用同一路由，必须挂认证中间件；容器不发布宿主端口。
2. **数据卷**：`/data`（SQLite WAL + 单实例锁）。升级前建议停止容器并备份数据目录（含 `-wal`/`-shm`）。
3. **凭据只在服务端**：`COOLIFY_API_KEY`、`REGISTRY_CREDENTIALS_FILE`、Apprise 配置全部不进前端构建。
4. 首次启动自动执行迁移；迁移失败会拒绝启动。

## 策略与安全默认值

- 新发现资源默认 **忽略**：不检查、不通知、不建任务（追踪 tag 与历史保留）。
- **通知**：检查上游并去重通知；更新始终需要人工预览确认。
- **自动更新**：显式启用后，候选出现即建任务（含首次固定摘要）；全局暂停、资源停止、被阻塞（外部修改 / 平台缺失 / 上次失败 / 待确认）时自动跳过。

## 资源页与服务分组

- 资源页分「应用」「服务」两个 Tab：`#/resources` 默认应用 Tab，`#/resources?tab=services` 为服务 Tab（非法值回落应用；刷新与前进/后退保持状态）。
- 服务 Tab 按 Compose 服务分组展示：组头显示服务名链接、父级运行状态、服务器/项目与子容器摘要（总数、有更新、待配置/受阻），默认折叠，按组分页；同名服务保持独立。
- 子容器归属其父服务；父服务已从当前列表消失的子容器进入独立异常组，展示已存父名并提供父详情入口。
- 服务详情聚合该服务的全部 active 子容器，提供 **整组检查**、**整组提交更新**、**批量策略**：范围固定为当前 active 快照，确认弹窗列出实际受影响资源与跳过原因。
- 整组更新按子容器逐项建任务（沿用单资源路径）：HTTP 202 表示任务已提交；结果汇总为「已提交 / 跳过 / 失败」。同服务前一个任务处于待人工确认时，后续任务排队，详情页提供进入子容器确认的入口。
- 列表批量操作的范围是当前页筛选后的选择集；与服务详情的整组范围相互独立，文案明确区分。
- 子容器平台继承父服务节点；节点派生/历史为空的平台在每次完整同步时自动回填自愈（compose 与手动设置的平台保持原值）。

## 已知边界（首期）

- **回滚功能整体排除**：更新失败时保留当前目标配置、暂停自动更新并通知；处理在 Coolify 完成，toolkit 提供同目标重试与重新同步。
- **Compose 完成证据**：Coolify 4.3.23 子容器 start 仅返回 queued，无 deployment UUID 可关联；提交后进入“待确认”，需要人工确认后才推进成功证据。
- **Compose 作用范围**：仅自动修改可唯一定位的字面量 `image:`；变量插值、共享 alias、Swarm 等显示受限并拒绝。
- **Registry 范围**：Docker Hub / GHCR / LSCR（匿名或 `REGISTRY_CREDENTIALS_FILE` 提供的只读凭据）；其他 registry 明确报“不支持”。
- **平台**：优先 compose `platform:`，否则节点架构（Coolify sentinel 上报，经 `/resources` 获取）；未上报时待配置，可在资源详情页手动设置。镜像检查默认每天 0 点，可在资源详情页覆盖 cron。
- SDK 无响应体硬上限 / 总时长中止，依赖受信 host 白名单 + 容器内存限制；SDK 内部重试固定为 0，重试由任务层统一调度（尊重 Retry-After）。

## 命令

| 命令 | 说明 |
| --- | --- |
| `npm run check` | typecheck + lint + test + build（CI 基线） |
| `npm run dev` | 并行启动前端 dev server 与 API watch |
| `npm run db:generate` | 修改 `src/server/db/schema.ts` 后生成迁移 |
| `npx tsx scripts/smoke-registry.ts` | 真实 registry 只读 smoke（Docker Hub/GHCR/LSCR） |
| `npx tsx scripts/smoke-coolify.ts` | 真实 Coolify 实例只读 smoke |
| `node scripts/stub-coolify.mjs` | 离线 UI 走查用 Coolify stub（:9901） |

## 测试

`npm test` 全部离线可复现：本地 registry fixture（原始字节摘要、多架构、显式平台、鉴权流、错误分类）、Coolify 客户端契约、库存同步（外部修改/移除保护、子容器平台回填与自愈）、检查器（策略/去重/阻塞/明确原因）、执行器（A→B 固定、失败保留证据、冲突、unknown submit、崩溃恢复、Compose 兄弟保护）、通知 outbox（去重/退避/暂停/恢复）、API 公共行为（校验/同源/预览令牌/parent 过滤）、资源页视图模型（分组/过滤/分页/选择/outcome 汇总）。回滚无专用测试（功能已排除）。

## 文档

- `docs/operations.md` — 运维手册：部署、备份、失败处理、排障
- `docs/integrations.md` — Coolify / Registry / Apprise 集成契约与已验证差异
