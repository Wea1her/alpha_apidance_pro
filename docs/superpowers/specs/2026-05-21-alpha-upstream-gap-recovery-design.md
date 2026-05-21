# Alpha 上游漏推恢复设计

## 背景

当前服务已经能在 Alpha WebSocket 断开、heartbeat 超时、登录失败等情况下自动重连。前一版也已经把 Telegram 主推送失败写入本地补偿队列，并由后台 worker 继续补发。

这仍然不能覆盖一个关键场景：Alpha 上游 502 或连接假活期间，服务端没有把共同关注业务事件重新下发。客户端重连成功只能恢复后续消息，不能凭空知道断线窗口里漏掉了哪些事件。

本次对 Alpha 前端和登录态接口做了探测：

- 前端 bundle 暴露的 REST 接口只有关注列表、分组管理、推送开关、批量导入等用户管理接口。
- 登录态探测候选历史事件接口全部返回 404，包括 `/v1/common/follows`、`/v1/user/common/follows`、`/v1/events`、`/v1/user/events`、`/v1/user/pushes`、`/v1/user/common_following`、`/v1/common_following`。
- `/v1/user/follows` 和 `/v1/user/groups` 可用，但它们不是共同关注事件历史，不能用于补回漏推。

因此第一版不能承诺“上游 502 后补回全部漏掉事件”。能可靠完成的是缩短假活窗口、强化已收到事件的补偿闭环，并把历史回放接入点预留清楚。

## 目标

- 将 Alpha 业务消息静默默认值从 180 秒缩短到 60 秒，降低连接假活期间的漏推窗口。
- 为主推送失败补偿队列补足测试，确认失败落盘、补发成功、去重标记和分析链路触发是完整闭环。
- 新增 Alpha 历史回放适配层边界：没有可用 REST provider 时明确记录不可用，不伪造补偿。
- 在服务重连成功后预留调用历史回放的统一入口；未来发现真实接口时，只需要实现 provider。
- 更新文档，明确当前能力和不能覆盖的边界。

## 非目标

- 不实现双 WebSocket 冗余连接。它只能缓解单连接断开，不能解决 Alpha 整体 502 或服务端不回放历史。
- 不用 `/v1/user/follows` 推断共同关注历史事件。关注列表是状态快照，不包含事件推送时间、共同关注数量和原始推送内容。
- 不新增数据库或外部队列。
- 不改变项目星级、账号分类、Grok 分析或 Telegram 推送格式。
- 不把“没有历史接口”包装成已经能补回漏推。

## 方案比较

推荐方案是 `P0 失败队列闭环测试 + P1 假活窗口缩短 + 历史回放适配层预留`。

历史事件 REST 回放原本是最强方案，但目前没有可用接口，不能作为本次可交付能力。主推送失败队列只能覆盖“服务已经收到事件，但 Telegram 发送失败”的场景；它不能覆盖“Alpha 从未把事件发给我们”的场景，但这条链路必须保证没有断点。

业务静默从 180 秒改为 60 秒能减少假活窗口，代价是遇到长时间无业务事件时会更频繁重连。共同关注推送对实时性要求高，这个代价可接受。

双 WebSocket 冗余暂不做。它会增加登录和处理复杂度，也无法解决上游整体 502；在没有历史回放接口之前，收益低于假活窗口缩短和补偿队列测试。

## 组件设计

### 配置

`ALPHA_BUSINESS_SILENCE_TIMEOUT_MS` 保持可配置，默认值改为：

```env
ALPHA_BUSINESS_SILENCE_TIMEOUT_MS=60000
```

已有用户如果显式配置了该变量，继续使用显式值。

### 历史回放适配层

新增一个小型接口，表示“重连后从 Alpha 拉取最近业务事件”的能力：

```ts
export interface AlphaReplayProvider {
  available: boolean;
  replaySince(since: Date): Promise<AlphaReplayEvent[]>;
}
```

第一版提供 `createUnavailableAlphaReplayProvider(reason)`：

- `available` 为 `false`。
- 调用 `replaySince` 返回空数组。
- 服务启动或重连时记录一次原因：当前未发现 Alpha 历史事件 REST 接口。

如果未来找到可用接口，再新增真实 provider，返回原始 Alpha 消息和接收时间，统一交给 `processAlphaMessage` 处理。

### 重连后的回放入口

`startAlphaService` 在 WebSocket `open` 时执行：

```text
if replay provider available:
  replay from now - ALPHA_REPLAY_LOOKBACK_MS
  for each event:
    processAlphaMessage(raw event)
else:
  log replay unavailable once
```

第一版 provider 不可用，所以不会产生业务行为变化，只会把边界写清楚。未来 provider 可用时，回放事件仍走现有 dedupeKey、项目星级、主推送失败队列和分析队列。

预留默认回放窗口为 10 分钟：

```env
ALPHA_REPLAY_LOOKBACK_MS=600000
```

第一版即使配置该值，也只有 provider 可用时才会生效。

### 主推送失败队列闭环

现有闭环保持：

```text
processAlphaMessage
-> send Telegram main push
-> send fails after Telegram retry
-> enqueue FailedMessageQueue
-> retry worker sends again
-> success adds delivered dedupeKey
-> remove queue record
-> afterDelivered enqueues analysis task
```

本次补强测试重点：

- 失败记录不会被提前加入 delivered 去重集合。
- 补发成功后才加入 delivered。
- 补发成功后会触发 `afterDelivered`，保证 Grok 分析补偿链路继续执行。
- 补发失败会更新 retryCount 和 nextRetryAt。

## 数据流

正常实时推送：

```text
Alpha WS message
-> processAlphaMessage
-> dedupe/project star check/classification
-> Telegram main push
-> analysis task queue
```

Telegram 主推送失败：

```text
Alpha WS message received
-> Telegram retry exhausted
-> failed-messages.jsonl
-> retry worker
-> successful resend
-> delivered dedupe
-> analysis task queue
```

Alpha 上游未下发历史事件：

```text
Alpha 502 or upstream no replay
-> local reconnect succeeds
-> no historical event REST available
-> cannot reconstruct missing common-following event
-> warn/log explicit limitation
```

未来真实回放接口可用：

```text
WebSocket open after reconnect
-> replay provider fetches recent events
-> each raw event enters processAlphaMessage
-> dedupeKey prevents duplicate push
```

## 错误处理

- 回放 provider 不可用时只记录 warning，不影响 WebSocket 监听。
- 回放 provider 请求失败时记录 warning，不关闭当前 WebSocket；实时消息继续处理。
- 单条回放事件处理失败时记录 warning，继续处理下一条。
- 主推送失败队列扫描失败时沿用现有 warning 和下一轮重试。
- 所有补发成功仍以 Telegram 实际发送成功为准，成功后才进入 delivered 去重。

## 测试计划

- 更新 `tests/config.test.ts`，确认默认 `businessSilenceTimeoutMs` 为 60000，显式配置仍可覆盖。
- 新增或更新 `tests/failed-message-queue.test.ts`，确认补发失败会增加 retryCount，并设置未来的 nextRetryAt。
- 新增 `tests/alpha-replay-provider.test.ts`，确认 unavailable provider 返回空列表且带有原因。
- 新增或更新 `tests/service.test.ts` 的可注入 replay provider 测试，确认 provider 可用时回放事件会进入 `processAlphaMessage` 同一条去重推送链路；provider 不可用时不推送、不抛错。
- 运行 `npm test -- tests/config.test.ts tests/failed-message-queue.test.ts tests/alpha-replay-provider.test.ts tests/service.test.ts`。
- 运行 `npm run typecheck`。
- 运行全量 `npm test`。

## 验收标准

- 默认业务静默窗口为 60 秒。
- 主推送失败补偿队列测试覆盖成功和失败路径。
- 代码中存在清晰的 Alpha replay provider 边界，当前默认不可用，不会误报已经能补历史。
- 重连后如果未来接入 provider，回放事件复用现有 `processAlphaMessage` 和 dedupeKey。
- README 明确写出：当前没有 Alpha 历史事件 REST 接口时，无法补回上游未下发的漏推，只能缩短假活窗口并保障已收到事件。
