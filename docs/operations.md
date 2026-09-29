# 运维手册

## 部署

1. 准备 `.env`（参考 `.env.example`）：`COOLIFY_BASE_URL`、`COOLIFY_API_KEY`、`PUBLIC_ORIGIN` 必填。
2. 强烈建议配置 `EXCLUDED_RESOURCE_UUIDS`：Coolify 自身、数据库、监控等一切非目标资源；类型识别（build_pack）之外的兜底。
3. `docker compose up -d --build`。容器以非 root 运行，仅写 `/data`。
4. Traefik 路由必须挂认证中间件（basicAuth / forwardAuth），覆盖 UI 与 `/api/*`；确认没有旁路端口（compose 未发布任何宿主端口）。
5. 调度配置（同步/检查周期、时区）存于数据库，UI 修改即生效；环境变量 `SYNC_CRON`/`CHECK_CRON`/`CRON_TIMEZONE`/`SERVER_PLATFORM` 已移除。部署并发默认 1（`DEPLOY_CONCURRENCY`）；toolkit 对单资源串行提交，调高前先确认 Coolify 队列与节点负载。鉴权由 Traefik 承担，toolkit 无内置账户，凭据仅驻留服务端。
6. 首次打开 UI → 设置 → 测试 Coolify 连接 → 资源页「重新同步」。

## 上线建议顺序

1. 全部资源保持「忽略」，观察同步结果（列表、当前镜像、外部变更标记）。
2. 逐个为要接管的资源设置追踪 tag 与目标平台，点「立即检查」核对上游摘要。
3. 先切「通知」观察 1–2 个检查周期（默认每天 0 点）。
4. 手动「预览更新 → 确认更新」完成首次固定摘要（Application 会有 deployment 证据）。
5. 稳定后个别资源再切「自动更新」。避免一上来全量自动。

## 备份与升级

- 业务数据（SQLite + WAL）在 `/data`。升级/迁移前：停止容器 → 备份整个目录（含 `toolkit.db-wal`、`toolkit.db-shm`、`toolkit.lock`）→ 再升级。
- 迁移失败（启动日志 `startup failed`）时回滚到上一镜像并恢复备份目录。
- 单实例锁：`/data/toolkit.lock`。进程被 kill -9 后重启会自动回收陈旧锁；若锁提示存在活跃实例，先确认无重复容器。

## 失败处理（无回滚设计）

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| 更新失败已暂停 | PATCH/部署/确认失败；目标配置保持写入值，上一成功证据保留 | 在 Coolify 排查（日志/健康），处理后点「同目标重试」；或在 Coolify 手工恢复后「重新同步」+「保存来源」解除阻塞 |
| 提交结果未知 | start 超时或响应无 deployment UUID 且历史无法唯一关联 | 先「更新历史」核对是否实际部署；绝不盲目重发。确认后用重试（会重新提交）或恢复同步 |
| 已提交 / 待确认（Compose） | 无完成证据可用 | 验证容器运行正常后点「人工确认」；确认前该资源阻止后续自动提交 |
| 外部修改，需重新确认 | Coolify 中的镜像被 toolkit 之外修改 | 核对当前镜像与追踪来源；修正来源后「保存来源」解除 |
| 目标平台待配置 | 无可验证平台来源 | 在详情页填写 `os/arch[/variant]` |

## 通知

- Apprise 用持久配置模式：环境变量 `APPRISE_API_URL` + `APPRISE_CONFIG_KEY`（可选 `APPRISE_TAG`）。
- **`APPRISE_TAG` 何时必填**：apprise-api v2.0.0 的「公开/已锁定」访问模式拒绝无 tag 的有状态通知（HTTP 400），此时必须设置；「用户」模式或渠道全部未打标签时可省略。未设置时启动日志会给出提示。
- **非公开模式的认证**：「已锁定/用户」模式需要 HTTP Basic 凭据，配置 `APPRISE_PASSWORD`（服务端 `APPRISE_PASSWORD` 创建，`APPRISE_USER` 可选）后 toolkit 自动携带 `Authorization` 头；「公开」模式留空即可。凭据仅存服务端，设置页只显示"已配置认证"状态。
- 去重身份：事件类型 + 资源 + 候选摘要。重复检查不会重复入队。
- 重试：至多 3 次，指数退避，429 遵循 Retry-After；404/401/403 标记 paused 并在 UI 显示原因；至少一次语义，超时重试可能重复通知。
- Apprise 未配置时队列照常入队，配置后自动补发（或在通知页手动补发）。

## 排障

- **日志**：stdout JSON 行不打印任何凭据/原始外部响应；执行器进度存于任务 log。
- **Coolify 连接**：设置页「测试 Coolify 连接」；401 检查 token 权限（read/write/deploy）。
- **检查一直 blocked**：忽略策略 / 无追踪 tag / 无平台 / 外部修改，详情页有对应徽章与说明。
- **429 / 限流**：检查器尊重 Retry-After 并保留旧观察；Docker Hub 匿名限流可在 `REGISTRY_CREDENTIALS_FILE` 配置只读凭据提升限额。
