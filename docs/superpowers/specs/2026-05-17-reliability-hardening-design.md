# 可靠性补强设计

## 背景

当前服务已经具备基础容错：

- Alpha WebSocket 断开后会重新登录并重新创建连接。
- heartbeat 超时会主动关闭连接并触发重连。
- Telegram 主推送有短重试，最终失败会进入本地补偿队列。
- Grok 首次分析任务会进入本地补偿队列，失败后后台重试。
- 账号分类失败时按保守策略继续推送。
- README 推荐使用 PM2 常驻运行。

仍存在几个缺口：

- 仓库没有 PM2 配置文件，部署时容易漏掉自动重启、日志和内存限制配置。
- 进程遇到未捕获异常或未处理 Promise rejection 时没有统一退出策略。
- `requestGrokAnalysis` 没有短重试，临时网络抖动会直接进入分析补偿队列或导致分类失败放行。
- 项目星级、推送次数和首次频道消息引用只保存在内存里，服务重启后会重复把旧项目当成首次命中。

## 目标

本次补强交付四项能力：

1. 提供仓库内可复用的 PM2 配置。
2. 进程级 fatal error 统一记录并退出，让 PM2 负责拉起新进程。
3. 给 xAI/Grok HTTP 调用增加短重试，降低临时网络错误造成的失败率。
4. 持久化项目推送状态，重启后继续保留星级、推送次数和首次频道消息链接。

## 非目标

- 不补回 Alpha WebSocket 断线期间上游没有重新发送的历史事件。
- 不改变 Alpha WebSocket 协议、登录方式或频道订阅方式。
- 不把账号分类失败改成阻塞推送。
- 不引入数据库；第一版继续使用本地 JSON 文件。
- 不持久化所有内存状态，只持久化影响重复推送和首次链接的项目状态。

## 方案

### PM2 配置

新增 `ecosystem.config.cjs`：

- 应用名：`daxinjiankong`
- 启动命令：`npm start`
- 自动重启：开启
- 重启延迟：5 秒
- 内存上限：512MB
- 日志目录：`logs/`
- 环境：`NODE_ENV=production`

README 的 24 小时部署章节改为：

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

保留常用 `pm2 status/logs/restart/stop` 命令。

### 进程级 fatal error 处理

`src/main.ts` 增加统一处理：

- `process.on('uncaughtException', handler)`
- `process.on('unhandledRejection', handler)`

handler 行为：

- 使用 `console.error` 输出错误类型和消息。
- 设置短延迟后 `process.exit(1)`，让日志有机会刷出。
- 若退出前再次触发 fatal error，直接退出，避免重复定时器。

这样做的目标是避免服务在未知状态下继续运行。常驻和重启职责交给 PM2。

### xAI/Grok 短重试

复用现有 `retry` helper，在 `requestGrokAnalysis` 内包裹 HTTP 请求：

- 默认尝试 3 次。
- 默认退避 1 秒到 10 秒。
- 网络错误、429、5xx 重试。
- 4xx 非 429 不重试。
- 保留原有错误消息格式，便于分析补偿队列记录原因。

影响范围：

- 账号分类调用 Grok 时自动获得短重试。
- 首次分析调用 Grok 时自动获得短重试。
- 分析补偿队列仍保留，短重试失败后继续走现有补偿机制。

### 项目状态持久化

新增本地 JSON 状态文件，默认路径：

```text
data/project-state.json
```

新增环境变量：

```env
PROJECT_STATE_PATH=data/project-state.json
```

状态内容：

```json
{
  "version": 1,
  "projects": {
    "altdotfun": {
      "star": 3,
      "pushCount": 3,
      "firstChannelMessage": {
        "chatId": -1001234567890,
        "messageId": 321
      },
      "updatedAt": "2026-05-17T00:00:00.000Z"
    }
  }
}
```

服务启动时：

- 读取 `PROJECT_STATE_PATH`。
- 文件不存在时使用空状态。
- JSON 损坏时记录 warn 并使用空状态，避免阻塞监听服务启动。

推送成功后：

- 写入最新项目星级。
- 写入最新推送次数。
- 若首次频道消息还不存在，写入首次频道消息引用。
- 使用临时文件加 rename 的方式原子更新。

分类拦截、未达到阈值、推送失败进入补偿队列时不写入最终状态。

补偿队列主推送成功后也会触发 `afterDelivered`，需要同步更新项目状态，保证补发成功后状态不会丢。

## 数据流

Alpha WebSocket 事件进入后：

```text
parse message
-> extract common follow count
-> build star decision
-> read in-memory state loaded from project-state.json
-> decide whether to push
-> send Telegram
-> update in-memory maps
-> persist project-state.json
-> enqueue analysis task
```

主推送失败时：

```text
send Telegram fails
-> enqueue failed main push
-> rollback reserved in-memory push count where needed
-> do not persist successful project state
```

补发成功时：

```text
failed queue worker sends Telegram
-> delivered set updated
-> afterDelivered runs
-> project state persists
-> analysis task enqueued
```

## 错误处理

- PM2 负责进程退出后的重启。
- fatal handler 只记录并退出，不尝试在未知状态下恢复服务。
- Grok 短重试只重试临时错误；持续失败交给现有分析队列。
- 项目状态文件读取失败不阻塞服务；写入失败记录 warn，但不影响已成功发送的 Telegram 消息。
- 项目状态持久化不能影响 WebSocket 重连逻辑。

## 测试计划

新增或更新测试覆盖：

- `requestGrokAnalysis` 对网络错误、429、5xx 会重试。
- `requestGrokAnalysis` 对 400 不重试。
- 项目状态 store 能读取空文件、写入状态、重新加载状态。
- `processAlphaMessage` 或服务状态适配层在推送成功后持久化项目星级、推送次数和首次频道消息。
- 主推送失败不会持久化成功状态。
- README 和 PM2 配置可以通过静态检查确认关键字段存在。

## 验收标准

- `npm test` 通过。
- `npm run typecheck` 通过。
- README 中部署命令使用 `pm2 start ecosystem.config.cjs`。
- 服务重启后，同一项目不会因为内存清空而丢失已记录的星级、推送次数和首次频道消息链接。
- xAI 临时失败在短重试后成功时，不进入分析补偿失败路径。
