# 集成契约与已验证差异

版本基线：Coolify v4.3.23（实例实测）、`@snyk/docker-registry-v2-client` 4.0.6、Apprise API（swagger 持久配置模式）、Drizzle ORM/Kit `1.0.0-rc.4` + Node 24 `node:sqlite`。

## Coolify

已验证（实例只读 + 会话内 sandbox 历史结论）：

- `GET /applications`、`GET /services` 为分页信封 `{data, meta.last_page}` 或裸数组，两种都已处理；列表项可能缺 `id`，以 `uuid` 为准。
- Application 镜像字段：`docker_image` + `docker_image_tag`；digest 固定写入 tag 字段的 `sha256-<hex>` 形式；`PATCH /applications/{uuid}` 仅提交 `docker_image_tag`。
- `POST /applications/{uuid}/start` 返回 `deployment_uuid`；`GET /deployments/{deployment_uuid}` 查询 `status`（finished/failed/cancelled/queued/in_progress）。
- Compose 子容器：`GET /services/{uuid}/applications` 返回 `fqdn`/`status`（无 `id`、无 `is_stopped`）；`PATCH /services/{uuid}/applications/{child}` 接受 `image` 且经 `updateCompose()` 写回 raw Compose（源码 v4.3.23 已核对）。
- `POST /services/{uuid}/applications/{child}/start` 仅返回 queued 文本，无部署 UUID → Compose 完成证据缺口，产品上落地为“待人工确认”。
- `GET /version` 部分构建返回纯文本，客户端做了 text/json 双解析。

toolkit 侧保护：写前语义校验（当前镜像 ∈ {追踪来源, 上一摘要, 候选}）、兄弟容器/域名漂移检测、raw Compose 必须包含目标镜像、前后指纹（镜像+域名白名单字段，原始 compose/env 不落盘）。

## Registry（@snyk/docker-registry-v2-client 4.0.6）

- 仅使用公开导出：`getManifest`、`contentTypes`、`types` 命名空间；类型经 `import type { types }` 引入，无 dist 深路径运行时依赖。
- `getManifest` 对 index 计算 `indexDigest`（原始字节），并按平台二次请求取 `manifestDigest`；toolkit 固定/对比一律用 `indexDigest ?? manifestDigest`，两者都过 `sha256:<64hex>` 校验。
- Accept 固定四类：Docker v2 / list、OCI manifest / index；`parse_response: false` + `encoding: 'utf8'` 保证摘要基于原始响应文本（fixture 用保留空白/键序的 body 验证）。
- 安全：`allowedHosts`（registry identity 与 auth host 分开：registry-1.docker.io/auth.docker.io、ghcr.io、lscr.io/ghcr.io）、`disallowDangerousHosts`、HTTPS 固定；离线测试用 `hostMappings`+`extraAllowedHosts`+HTTP 的显式覆盖接缝，生产路径不传。
- 超时：`open_timeout=10s`、`response_timeout=15s`、`read_timeout=15s`（均为阶段超时；Needle `timeout` 是 `open_timeout` 别名，SDK 无总时长中止）。
- 重试：`DOCKER_REGISTRY_V2_CLIENT_MAX_RETRIES=0`（SDK 模块载入前经 `src/server/sdk-env.ts` 与构建 banner 双保险），429/网络错误由检查器统一重试并遵循 Retry-After（从异常 `headers['retry-after']` 读取）。
- 错误归一化：auth(401/403) / not_found(404) / rate_limited(429) / server(5xx) / network / platform；消息脱敏并截断，凭据与原始响应不外溢。
- 真实 smoke（`scripts/smoke-registry.ts`）：Docker Hub `library/busybox:latest`、GHCR `navidrome/navidrome:latest`、LSCR `linuxserver/jackett:latest` 均返回有效 indexDigest+manifestDigest。

## Apprise API

- `POST {API}/notify/{KEY}`，body `title/body/type/format=text`（可选 `tag`）。
- **apprise-api v2.0.0 实测（公开访问模式）**：tag 过滤必须放在 **query string**（`?tags=...`），body 里的 `tag` 字段会被忽略；无 tag 的有状态通知会被拒绝（HTTP 400 "A specific tag other than 'all' is required"）。toolkit 已改为 query 传递并有单测锁定（`tests/apprise-client.test.ts`）。
- 分类：`404` = 缺配置（不重试）；`400/401/403` = 配置/认证错误（暂停）；`429` 遵循 Retry-After；5xx/超时有限重试（3 次指数退避）。有意的实现偏离：所有 2xx（含 204）按成功处理——204 是现行 apprise-api 的标准成功码，计划文本中“旧版 204 表示缺配置”不适用。
- 至少一次语义：发送超时或部分成功后重试可能重复通知（UI 已标注）。
- 真实实例联调待用户提供地址/KEY（`scripts/smoke-coolify.ts` 之外单独验证）。

## 数据层

- `drizzle-orm@1.0.0-rc.4` + `node:sqlite`（Node 24.19.0 实测可用）；`drizzle-kit@1.0.0-rc.4` 生成版本化 SQL 迁移（`drizzle/`），启动自动应用，失败即退出。
- SQLite：WAL、busy_timeout 5000、外键开启；网络调用一律在事务外。
- 迁移测试覆盖：空库建表、重复迁移幂等、重开后策略/来源/平台/未决任务保留。
