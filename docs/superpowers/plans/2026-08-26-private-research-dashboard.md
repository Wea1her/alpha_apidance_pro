# 私人打新投研工作台实施计划

**目标：** 将现有 Alpha→Telegram 监听服务升级为部署在 VPS 上的私人投研网站。系统使用 PostgreSQL 持久化状态，以 Alpha Hook 接收信号，自动完成账号初筛与带证据的调研报告；随后增加战壕监控、台账和日历。

**架构：** 在一个 npm 工作区内继续使用全栈 TypeScript。React/Vite 网站、Fastify API 和 PostgreSQL 任务后台工作进程分别运行。业务状态变化集中在共享深模块中，状态和事务型发件箱（Outbox）在同一事务内持久化；Alpha、AI 与 Telegram 通过外部适配器接入。

**技术栈：** Node.js 22、TypeScript ESM、npm workspaces、React、Vite、Fastify、Zod、PostgreSQL、Drizzle ORM、Vitest、Testing Library、Playwright、Docker Compose、Caddy 或 Nginx。

**设计依据：** `docs/superpowers/specs/2026-08-26-private-research-dashboard-design.md`

---

## 版本边界

### 第一版：核心投研闭环

```text
Alpha Hook → PostgreSQL → AI 初筛 → 实时项目卡片
→ 带证据的调研文档 → 关键 Telegram 通知
```

第一版包含访问密钥登录、初筛审计、AI 服务商设置、系统状态、历史迁移工具，以及 Hook 与 WebSocket 的七天影子验证能力。

### 第二版：战壕执行闭环

```text
达到三星 → Alpha 专用分组 → 新推文/CA Hook → 重要性判断
→ 报告新版本 → 战壕看板 → 台账 → 日历
```

第二版包含飙升检测、休眠、报告版本对比、日历提醒和 UI 体验优化。

---

## 任务 1：建立 npm 单仓库工作区，同时保持旧服务可运行

**涉及文件：**

- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`tsconfig.json`
- 创建：`tsconfig.base.json`
- 创建：`apps/api/package.json`
- 创建：`apps/api/tsconfig.json`
- 创建：`apps/api/src/main.ts`
- 创建：`apps/worker/package.json`
- 创建：`apps/worker/tsconfig.json`
- 创建：`apps/worker/src/main.ts`
- 创建：`apps/web/package.json`
- 创建：`apps/web/tsconfig.json`
- 创建：`apps/web/vite.config.ts`
- 创建：`apps/web/src/main.tsx`
- 创建：`packages/domain/package.json`
- 创建：`packages/db/package.json`
- 创建：`packages/alpha/package.json`
- 创建：`packages/ai/package.json`
- 创建：`packages/notifications/package.json`
- 创建：`packages/config/package.json`

- [ ] 在根目录配置 `apps/*` 和 `packages/*` npm 工作区。
- [ ] 迁移期间继续保留根目录的 `npm start`、`npm test` 和 `npm run alpha:ws`。
- [ ] 增加 `dev`、`build`、`typecheck`、`test`、`db:migrate`、`api`、`worker` 和 `web` 脚本。
- [ ] 建立共享严格 TypeScript 配置，继续使用 NodeNext ESM 语义。
- [ ] 为 Web、API 和 Worker 建立只有健康检查的最小入口。
- [ ] 只有在 TypeScript 与运行时解析方式一致时才配置工作区别名。
- [ ] 工作区调整前后分别运行旧测试，确保没有回归。

**验证：**

```bash
npm install
npm test
npm run typecheck
npm run build
```

**预期结果：** 旧测试继续通过，新建的所有工作区包可以编译。

## 任务 2：建立 PostgreSQL 数据结构与迁移框架

**涉及文件：**

- 创建：`packages/db/src/schema/*.ts`
- 创建：`packages/db/src/client.ts`
- 创建：`packages/db/src/migrate.ts`
- 创建：`packages/db/drizzle.config.ts`
- 创建：`packages/db/migrations/*`
- 创建：`packages/db/tests/migrations.test.ts`
- 修改：`.env.example`

- [ ] 添加 Drizzle 与生产 PostgreSQL 驱动。
- [ ] 定义 `raw_events`、`signals`、`projects`、`project_aliases` 和 `screening_decisions`。
- [ ] 定义 `evidence`、`report_versions`、`personal_notes` 和 AI 调用记录表。
- [ ] 定义 `jobs`、`outbox_events`、`access_sessions` 和登录尝试表。
- [ ] 为稳定外键提前定义 `trench_memberships`、`alpha_monitors`、`surges`、`ledger_entries` 和 `calendar_events`。
- [ ] 按设计文档添加唯一约束、外键和必要索引。
- [ ] 保证迁移对空数据库和已是最新版本的数据库都能安全运行。
- [ ] 使用 PGLite 或临时 PostgreSQL 建立测试数据库助手。

**验证：**

```bash
npm run db:migrate
npm test --workspace packages/db
```

**预期结果：** 空数据库能够升级到最新数据结构，测试覆盖关键约束。

## 任务 3：实现 PostgreSQL 任务队列与事务型发件箱

**涉及文件：**

- 创建：`packages/db/src/jobs/job-store.ts`
- 创建：`packages/db/src/outbox/outbox-store.ts`
- 创建：`packages/db/tests/job-store.test.ts`
- 创建：`packages/db/tests/outbox-store.test.ts`
- 创建：`apps/worker/src/runner.ts`

- [ ] 先编写 `idempotency_key` 幂等入队测试。
- [ ] 实现优先级和 `run_after`。
- [ ] 使用 `FOR UPDATE SKIP LOCKED` 领取任务。
- [ ] 实现成功、退避重试和死信状态变化。
- [ ] 超过锁定期限后恢复被中断的 `running` 任务。
- [ ] 业务状态与 Outbox 事件在同一事务中写入。
- [ ] 为 SSE 和 Telegram 分别记录消费状态，避免互相影响。
- [ ] Worker 支持优雅退出和有界并发。
- [ ] AI 全局并发默认设为 2，并提供经过校验的可调配置。

**验证：**

```bash
npm test --workspace packages/db -- job-store outbox-store
```

**预期结果：** 多个 Worker 不会领取同一任务，重复入队不会产生重复工作。

## 任务 4：实现访问密钥会话与 HTTPS API 基础

**涉及文件：**

- 创建：`packages/config/src/secrets.ts`
- 创建：`apps/api/src/app.ts`
- 创建：`apps/api/src/routes/auth.ts`
- 创建：`apps/api/src/plugins/session.ts`
- 创建：`apps/api/src/plugins/security.ts`
- 创建：`apps/api/tests/auth.test.ts`

- [ ] 从服务端环境读取 Argon2 访问密钥哈希、会话密钥和加密主密钥。
- [ ] 实现 `POST /auth/access-key` 和 `POST /auth/logout`。
- [ ] 数据库只保存随机会话 Token 的哈希。
- [ ] Cookie 设置 `HttpOnly`、`Secure` 和 `SameSite=Strict`。
- [ ] 对登录失败进行限速并写入审计记录。
- [ ] 保护全部 `/api/*` 和 SSE 路由，只豁免健康检查与 Alpha Hook。
- [ ] 所有会修改状态的认证请求都校验 `Origin`。
- [ ] 确认日志和响应中不出现任何秘密明文。

**验证：**

```bash
npm test --workspace apps/api -- auth
```

**预期结果：** 正确密钥可以创建会话，错误尝试会被限速，未登录用户无法访问 API 和 SSE。

## 任务 5：实现 Alpha Hook 入站与影子通道去重

**涉及文件：**

- 创建：`packages/alpha/src/event-decoder.ts`
- 创建：`packages/alpha/src/dedupe-key.ts`
- 创建：`packages/alpha/src/fixtures/*.json`
- 创建：`packages/alpha/tests/event-decoder.test.ts`
- 创建：`packages/alpha/tests/dedupe-key.test.ts`
- 创建：`apps/api/src/routes/alpha-hook.ts`
- 创建：`apps/api/tests/alpha-hook.test.ts`
- 修改：旧 WebSocket 路径，使其在影子模式下写入新原始事件表

- [ ] 收集并脱敏共同关注、新推文、CA、心跳和未知 Hook 样本。
- [ ] 先为样本编写解码测试，再实现字段映射。
- [ ] 生成与传输通道无关的去重键，让 Hook 与 WebSocket 副本互相去重。
- [ ] 实现 `POST /webhooks/alpha/:secret`，校验类型、大小、JSON 和路径 Secret。
- [ ] 在一个事务内写入 `raw_events` 和解码任务，然后立即返回 `2xx`。
- [ ] 未支持或无效载荷仍然保留，并记录解码状态与错误。
- [ ] 为系统状态保存 Hook 请求数和最近收到时间。
- [ ] 增加 `SHADOW_ALPHA_WS` 功能开关。

**验证：**

```bash
npm test --workspace packages/alpha
npm test --workspace apps/api -- alpha-hook
```

**预期结果：** 同一 Hook/WS 事件只产生一个待处理信号，Hook 响应不会等待 AI。

## 任务 6：实现项目工作流深模块

**涉及文件：**

- 创建：`packages/domain/src/project/types.ts`
- 创建：`packages/domain/src/project/project-workflow.ts`
- 创建：`packages/domain/src/project/star-policy.ts`
- 创建：`packages/domain/src/project/surge-policy.ts`
- 创建：`packages/domain/tests/project-workflow.test.ts`
- 创建：`packages/domain/tests/star-policy.test.ts`
- 创建：`packages/domain/tests/surge-policy.test.ts`

- [ ] 定义带品牌的 ID 类型和项目状态。
- [ ] 只有解析出 X 数字用户 ID 后才建立正式项目。
- [ ] handle、昵称和头像变化只写入别名历史，不创建新项目。
- [ ] 星级只保存历史最高值，不实现下降。
- [ ] 实现默认“60 分钟增加 5 个共同关注”的飙升规则，持续 6 小时。
- [ ] 没有窗口基线时，首次看到高计数不能判定为飙升。
- [ ] 通过任务和 Outbox 产生初筛、报告、SSE 与通知意图。
- [ ] 实现待确认、初筛拦截、人工放行、排除和恢复状态变化。
- [ ] 工作流只返回 Alpha 监控意图，不直接调用 Alpha。
- [ ] 所有测试都通过 `ProjectWorkflow` 接口观察结果。

**验证：**

```bash
npm test --workspace packages/domain -- project-workflow star-policy surge-policy
```

**预期结果：** 重放同一信号保持幂等，星级不下降，排除操作不破坏历史。

## 任务 7：实现可配置 AI 服务商与能力路由

**涉及文件：**

- 创建：`packages/ai/src/provider.ts`
- 创建：`packages/ai/src/provider-router.ts`
- 创建：`packages/ai/src/adapters/openai-chat.ts`
- 创建：`packages/ai/src/adapters/xai-responses.ts`
- 创建：`packages/ai/src/provider-secrets.ts`
- 创建：`packages/ai/tests/provider-router.test.ts`
- 创建：`apps/api/src/routes/ai-providers.ts`
- 创建：`apps/api/tests/ai-providers.test.ts`

- [ ] 定义普通对话、Web Search、X Search、引用和结构化输出能力。
- [ ] 同一服务商支持分别配置初筛模型和调研模型。
- [ ] 使用服务端主密钥和 AES-GCM 加密 API Key。
- [ ] Key 创建后不再回显完整明文，只返回尾部提示。
- [ ] 为初筛和调研分别实现主服务商与备用服务商路由。
- [ ] 完整报告只路由到健康检查已证明支持搜索和引用的服务商。
- [ ] 为每项声明能力提供连接测试。
- [ ] 增加超时、错误分类重试与熔断健康状态。
- [ ] 在行为对等测试通过前保留现有 `xai-client.ts`。

**验证：**

```bash
npm test --workspace packages/ai -- provider-router
npm test --workspace apps/api -- ai-providers
```

**预期结果：** 主服务商失败后切换备用服务商；只有普通对话能力的服务商绝不生成完整报告。

## 任务 8：将账号初筛迁入新任务管线

**涉及文件：**

- 创建：`packages/ai/src/screening/account-screening.ts`
- 创建：`packages/ai/src/screening/schema.ts`
- 创建：`packages/ai/tests/account-screening.test.ts`
- 创建：`apps/worker/src/handlers/screen-account.ts`
- 修改或包装：`src/account-classifier.ts`

- [ ] 保留 PROJECT、ALPHA、UNKNOWN、KOL、PERSONAL、DEV 和 MEDIA 语义。
- [ ] 使用 Zod 校验模型输出，并记录服务商调用信息。
- [ ] 初筛优先级高于除 CA 以外的所有 AI 工作。
- [ ] 放行后公开项目并加入首次调研任务。
- [ ] 拦截后保留 30 天审计记录，不创建报告或监控任务。
- [ ] 连续失败后进入待确认，并保留自动和人工重试入口。
- [ ] 人工放行/拦截与 AI 结果走相同工作流状态变化。

**验证：**

```bash
npm test --workspace packages/ai -- account-screening
npm test --workspace apps/worker -- screen-account
```

**预期结果：** 服务商故障不会丢原始信号；被拦截账号不会进入普通实时流。

## 任务 9：实现带证据、可版本化的调研文档

**涉及文件：**

- 创建：`packages/ai/src/research/report-schema.ts`
- 创建：`packages/ai/src/research/evidence-collector.ts`
- 创建：`packages/ai/src/research/research-pipeline.ts`
- 创建：`packages/ai/src/research/render-markdown.ts`
- 创建：`packages/ai/tests/report-schema.test.ts`
- 创建：`packages/ai/tests/research-pipeline.test.ts`
- 创建：`apps/worker/src/handlers/research-project.ts`
- 修改：`analysis-skills/project-alpha.md`
- 修改：`src/analysis-service.ts`
- 修改：`src/config.ts`
- 修改：`.env.example`
- 新管线达到行为对等后删除：`src/project-backing-provider.ts`
- 新管线达到行为对等后删除：`tests/project-backing-provider.test.ts`
- 新管线达到行为对等后删除：`src/rug-history-provider.ts`
- 新管线达到行为对等后删除：`tests/rug-history-provider.test.ts`
- 新管线达到行为对等后删除：`src/twitter-6551-client.ts`
- 新管线达到行为对等后删除：`tests/twitter-6551-client.test.ts`

- [ ] 使用 Zod 定义核心信息、关注理由、标签、核心论点、参与玩法、风险和证据引用。
- [ ] 删除独立背书账号章节和全部 6551 依赖。
- [ ] 从新运行配置删除 `TWITTER_TOKEN` 与 `TWITTER_API_BASE_URL`。
- [ ] 新管线对等测试通过后删除旧背书、Rug 历史和 6551 客户端模块。
- [ ] 重要事实必须引用已经存在的 Evidence ID。
- [ ] 不存在证据时拒绝事实或明确标记为暂未确认。
- [ ] 先保存证据，再调用模型生成报告。
- [ ] 每个任务只生成一份经过校验的结构化文档，不为每个章节单独调用模型。
- [ ] 保存不可覆盖的版本号和触发信号 ID。
- [ ] 生成确定、可清洗的 Markdown 导出快照。
- [ ] 记录服务商、模型、能力、耗时等元数据。
- [ ] 没有健康调研服务商时让报告保持排队，不生成无证据文档。

**验证：**

```bash
npm test --workspace packages/ai -- report-schema research-pipeline
```

**预期结果：** 虚构 Evidence ID 会校验失败；报告按约定章节顺序渲染为易读文档。

## 任务 10：实现第一版 REST、SSE 与系统状态接口

**涉及文件：**

- 创建：`apps/api/src/routes/projects.ts`
- 创建：`apps/api/src/routes/screening-audit.ts`
- 创建：`apps/api/src/routes/reports.ts`
- 创建：`apps/api/src/routes/events.ts`
- 创建：`apps/api/src/routes/system-status.ts`
- 创建：`apps/api/tests/projects.test.ts`
- 创建：`apps/api/tests/events.test.ts`
- 创建：`apps/api/tests/system-status.test.ts`

- [ ] 实现基于游标的项目和信号分页。
- [ ] 支持全部、三星以上、飙升、CA、待确认和已排除筛选。
- [ ] 实现排除、恢复、审计放行与个人笔记写入。
- [ ] 报告接口只返回文档 DTO，不返回服务商原始响应或秘密字段。
- [ ] SSE 支持游标续传和资源版本。
- [ ] SSE 只发送小型资源变化事件，客户端再通过 REST 获取完整内容。
- [ ] 聚合最近 Hook、队列深度、AI 健康、数据库和 Telegram 状态。
- [ ] 为可重试或死信任务提供授权重试接口。

**验证：**

```bash
npm test --workspace apps/api -- projects events system-status
```

**预期结果：** SSE 断线重连可以补回资源事件，且不会重复写入项目。

## 任务 11：开发第一版网站

**涉及文件：**

- 创建：`apps/web/src/routes/*`
- 创建：`apps/web/src/features/auth/*`
- 创建：`apps/web/src/features/feed/*`
- 创建：`apps/web/src/features/projects/*`
- 创建：`apps/web/src/features/reports/*`
- 创建：`apps/web/src/features/screening-audit/*`
- 创建：`apps/web/src/features/settings/*`
- 创建：`apps/web/src/features/system-status/*`
- 创建：`apps/web/src/lib/api.ts`
- 创建：`apps/web/src/lib/sse.ts`
- 创建：`apps/web/tests/*`

- [ ] 开发访问密钥登录和会话失效处理。
- [ ] 将实时信号流设为默认首页。
- [ ] 增加筛选、飙升/CA 强调和响应式项目卡片。
- [ ] 显示初筛、证据收集、报告生成和完成等处理阶段。
- [ ] 把报告渲染为包含标题、段落、标签、证据卡片和来源链接的易读文档。
- [ ] 不向用户暴露或显示服务商 JSON。
- [ ] 增加报告版本切换、全文复制和 Markdown 下载。
- [ ] 增加待确认与初筛审计操作。
- [ ] 增加 AI 服务商配置、测试和 Key 掩码界面。
- [ ] 增加基础系统状态与失败任务重试界面。
- [ ] 保证桌面端阅读体验，以及手机端信号流、CA 复制和排除操作可用。

**验证：**

```bash
npm test --workspace apps/web
npm run build --workspace apps/web
```

**预期结果：** 初筛通过后立即出现项目卡片，报告在桌面与手机测试尺寸下都易于阅读。

## 任务 12：让 Telegram 只发送策略允许的关键通知

**涉及文件：**

- 创建：`packages/notifications/src/notification-policy.ts`
- 创建：`packages/notifications/src/telegram-adapter.ts`
- 创建：`packages/notifications/tests/notification-policy.test.ts`
- 创建：`apps/worker/src/handlers/send-notification.ts`
- 适配：`src/telegram.ts`

- [ ] 通过纯通知策略模块把领域事件转换为通知意图。
- [ ] 只允许三星入战壕、飙升、CA、重要变化、已确认提醒和系统故障。
- [ ] 普通信号和日常推文不进入 Telegram。
- [ ] 消息只包含简短摘要和项目链接，不发送完整报告。
- [ ] 使用通知意图键去重。
- [ ] PostgreSQL 投递达到行为对等前保留旧重试与死信逻辑。

**验证：**

```bash
npm test --workspace packages/notifications
npm test --workspace apps/worker -- send-notification
```

**预期结果：** CA 或飙升重复处理时，每个约定窗口最多发送一次 Telegram。

## 第一版验收节点

- [ ] 使用一个脱敏 Hook 样本完整经过入站、初筛、项目流和报告文档。
- [ ] 未支持 Hook 事件可以在系统状态页看到。
- [ ] 只有普通对话能力和具备调研能力的服务商能正确分流。
- [ ] 被拦截、待确认和已排除项目不会生成报告。
- [ ] 网站在没有 Telegram 的情况下仍能完整显示项目状态。
- [ ] 浏览器网络响应和日志中不出现秘密。

本节点通过前，不启用自动修改 Alpha 关注列表的功能。

## 任务 13：实现 Alpha 自动监控适配器

**涉及文件：**

- 创建：`packages/alpha/src/monitoring.ts`
- 创建：`packages/alpha/src/http-alpha-monitoring-adapter.ts`
- 创建：`packages/alpha/src/auth-session.ts`
- 创建：`packages/alpha/tests/monitoring.test.ts`
- 创建：`apps/worker/src/handlers/sync-alpha-monitor.ts`
- 创建：`apps/worker/src/schedules/reconcile-alpha-monitors.ts`

- [ ] 复用钱包签名登录，私钥只存在于 Worker 服务端配置。
- [ ] 查找或创建一个系统专属 Alpha 分组。
- [ ] 使用 `POST /v1/user/follow` 添加项目。
- [ ] 开启新推文和 CA 推送。
- [ ] 关闭不需要的其他推送类型。
- [ ] 项目排除或休眠时停止监控。
- [ ] 只校准系统专属分组，绝不删除人工管理的其他关注。
- [ ] 将从前端观察到的 Alpha 内部接口封装在唯一适配器中。
- [ ] 增加功能开关和只记录不执行模式。
- [ ] 增加需要显式环境开关、只操作测试账号的在线冒烟测试。

**验证：**

```bash
npm test --workspace packages/alpha -- monitoring
```

**预期结果：** 重复执行启用/停止保持幂等，Alpha Token 过期后能够透明刷新。

## 任务 14：实现战壕、新推文/CA 判断和报告更新

**涉及文件：**

- 扩展：`packages/domain/src/project/project-workflow.ts`
- 创建：`packages/domain/src/trench/dormancy-policy.ts`
- 创建：`packages/ai/src/research/update-classifier.ts`
- 创建：`apps/worker/src/handlers/classify-update.ts`
- 创建：`apps/worker/src/schedules/dormancy.ts`
- 在对应模块旁创建测试

- [ ] 初筛通过的项目达到三星后自动进入战壕。
- [ ] 所有新推文和 CA 信号都进入项目动态。
- [ ] CA 只作为未验证的高优先级信号处理。
- [ ] 普通推文先执行重要性判断。
- [ ] 只有重要变化才生成新报告版本。
- [ ] 计算并保存版本之间的变化摘要。
- [ ] 只有在没有未完成玩法和未来事件时，30 天无重要变化才进入休眠。
- [ ] 休眠项目收到新重要信号后重新激活。
- [ ] 每次状态变化后同步 Alpha 期望监控状态。

**验证：**

```bash
npm test --workspace packages/domain -- trench dormancy
npm test --workspace packages/ai -- update-classifier
```

**预期结果：** 日常宣传推文不重跑报告；重要推文生成新版本；CA 始终高亮且只提醒一次。

## 任务 15：开发战壕看板与报告对比

**涉及文件：**

- 创建：`apps/web/src/features/trench/*`
- 创建：`apps/web/src/features/reports/ReportDiff.tsx`
- 增加战壕与报告对比 API 路由和测试

- [ ] 展示活跃、等待、可执行和休眠视图，但不改变领域状态名称。
- [ ] 显示 Alpha 监控同步状态和错误。
- [ ] 显示最新重要信号、下一步行动和最近日历事件。
- [ ] 增加报告版本切换和结构化变化高亮。
- [ ] 保持 AI 报告不可编辑，个人笔记单独显示。
- [ ] 为失败的 Alpha 同步提供人工重试。

**验证：**

```bash
npm test --workspace apps/web -- trench report-diff
```

**预期结果：** UI 操作只能触发允许的工作流状态变化，报告正文不能原地修改。

## 任务 16：实现台账、日历与提醒

**涉及文件：**

- 创建：`packages/domain/src/ledger/*`
- 创建：`packages/domain/src/calendar/*`
- 创建：`apps/api/src/routes/ledger.ts`
- 创建：`apps/api/src/routes/calendar.ts`
- 创建：`apps/worker/src/schedules/calendar-reminders.ts`
- 创建：`apps/web/src/features/ledger/*`
- 创建：`apps/web/src/features/calendar/*`
- 在对应模块旁创建测试

- [ ] 支持任务、参与、手动成本、结果和笔记记录。
- [ ] 不增加钱包连接和自动收益计算。
- [ ] 日历建议必须包含证据、置信度和待确认/已确认状态。
- [ ] 只有已确认事件才发送提前 24 小时和 1 小时提醒。
- [ ] 每个提醒窗口都要幂等去重。
- [ ] 允许单独修改或关闭某个事件的提醒。
- [ ] 休眠判断需要考虑未完成任务和未来事件。

**验证：**

```bash
npm test --workspace packages/domain -- ledger calendar
npm test --workspace apps/worker -- calendar-reminders
```

**预期结果：** 待确认事件不通知，已确认事件在每个提醒窗口最多通知一次。

## 任务 17：迁移旧 JSON 与 JSONL 数据

**涉及文件：**

- 创建：`scripts/migrate-legacy/package.json`
- 创建：`scripts/migrate-legacy/src/main.ts`
- 创建：`scripts/migrate-legacy/src/project-state.ts`
- 创建：`scripts/migrate-legacy/src/analysis-archive.ts`
- 创建：`scripts/migrate-legacy/tests/*`

- [ ] 使用来源文件和内容哈希实现项目状态幂等导入。
- [ ] 在可行时通过 Alpha 适配器把 handle 解析为 X 数字用户 ID。
- [ ] 无法解析的身份进入迁移审查，不伪造 ID。
- [ ] 旧分析文本作为不可修改的历史报告导入。
- [ ] 旧任务与死信文件只导入为审计记录。
- [ ] 不重新发送旧 Telegram 消息。
- [ ] 提供只预览、汇总和按批次回滚能力。
- [ ] 只有受控的活跃三星项目或未来再次命中的项目才生成结构化 V2 报告。

**验证：**

```bash
npm test --workspace scripts/migrate-legacy
npm run migrate:legacy -- --dry-run
```

**预期结果：** 重复执行相同导入不会改变数据，并明确列出无法解析的身份。

## 任务 18：容器化、备份和运维状态

**涉及文件：**

- 创建：`Dockerfile`
- 创建：`compose.yaml`
- 创建：`deploy/Caddyfile` 或 `deploy/nginx.conf`
- 创建：`scripts/backup/backup-postgres.ps1` 或 VPS 对应 Shell 脚本
- 创建：`scripts/backup/rotate-backups.*`
- 修改：`.env.example`
- 修改：`README.md`

- [ ] 从同一代码库构建可分别启动的 Web、API 和 Worker。
- [ ] PostgreSQL 只运行在 Docker 内部网络。
- [ ] 由 Caddy/Nginx 终止 HTTPS。
- [ ] 公网只暴露认证后的应用路由和带 Secret 的 Hook 路由。
- [ ] 增加容器健康检查和自动重启策略。
- [ ] 每天执行本地 `pg_dump`，只保留最近 7 天。
- [ ] 备份成功/失败进入系统状态并触发 Telegram 故障提醒。
- [ ] 文档说明 Secret 创建、轮换和恢复方法。
- [ ] 部署时先执行数据库迁移，再滚动启动应用。

**验证：**

```bash
docker compose build
docker compose up -d
docker compose ps
```

**预期结果：** API 和 Worker 可以独立重启，PostgreSQL 不可从公网访问，备份可恢复到临时数据库。

## 任务 19：执行七天影子验证并切换主链路

**涉及文档：**

- 创建：`docs/operations/shadow-run-checklist.md`
- 创建：`docs/operations/cutover-runbook.md`
- 创建：`docs/operations/rollback-runbook.md`

- [ ] Hook 与 WebSocket 同时接收至少 7 天。
- [ ] 按事件类型比较每小时数量，并调查持续差异。
- [ ] 确认跨通道重复不会产生重复信号、报告和通知。
- [ ] 确认 Hook 载荷包含设计所需的共同关注、新推文和 CA 数据。
- [ ] 使用测试记录验证 Alpha 分组添加、开关、移除和校准。
- [ ] 验证 AI 主备切换、死信任务、SSE 重连和会话过期。
- [ ] 比较网站与旧 Telegram 的端到端延迟。
- [ ] 在检查表记录是否允许切换。
- [ ] 通过后关闭旧 WebSocket 主处理和 Telegram 全量推送。
- [ ] 再经过一个稳定观察窗口后才移除回滚开关。

**最终验证：**

```bash
npm test
npm run typecheck
npm run build
npm run db:migrate
docker compose config
```

**预期结果：** 自动检查全部通过，影子检查表不存在无法解释的关键缺口，回滚可以恢复 WebSocket 入站而不回滚 PostgreSQL 和网站。

---

## 最终验收清单

- [ ] 网站为私人使用，启用 HTTPS，并使用服务端访问密钥会话。
- [ ] Hook 入站不依赖 Telegram 或 AI 可用性。
- [ ] PostgreSQL 是项目与工作流的唯一事实源。
- [ ] 项目以 X 数字用户 ID 为身份，handle 变化不会创建新项目。
- [ ] 初筛失败可恢复，被拦截对象保留 30 天审计记录。
- [ ] 报告是易读文档，具有来源、不可覆盖版本和独立个人笔记。
- [ ] 新管线不保留背书账号调研。
- [ ] 新管线不保留 6551、删帖或旧 Rug 历史依赖。
- [ ] 三星项目自动进入 Alpha 专属战壕分组。
- [ ] 飙升规则为 60 分钟增加 5 个共同关注，持续 6 小时。
- [ ] CA 只标记为检测到，不标记为已验证。
- [ ] Telegram 只发送约定的关键通知和日历提醒。
- [ ] AI 服务商 URL、Key、初筛模型和调研模型无需重启即可更换。
- [ ] 主备能力路由不会生成没有证据的完整报告。
- [ ] 历史数据迁移幂等，不重放旧 Telegram 消息。
- [ ] 每日本地数据库备份保留 7 天。
- [ ] 切换前通过七天 Hook/WebSocket 影子验证。
