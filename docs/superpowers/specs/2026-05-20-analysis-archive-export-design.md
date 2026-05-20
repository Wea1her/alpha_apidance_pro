# Grok 分析归档与 Telegram 导出设计

## 概述

新增一个由 Telegram 命令触发的 Grok 分析导出能力。从功能上线后开始，服务会把每次成功发到讨论群的 Grok 分析正文和相关项目元数据结构化归档到本地文件。后续同一项目再次命中或升星时，如果该项目已经有归档过的分析正文，也会记录一条命中记录。用户可以在授权的 Telegram 频道、群或私聊里发送命令，导出指定上海时间小时范围内的项目分析 Markdown 文档。

本设计不做历史 Telegram 消息回捞。当前服务没有结构化保存历史 Grok 分析正文，而 Telegram Bot API 也不适合稳定回捞任意久远的历史消息。因此本功能只保证从上线后开始完整记录和导出。

## 目标

- 归档每次成功发布的 Grok 分析全文和来源元数据。
- 归档已经有分析正文的项目后续命中记录，支持导出升星和重复命中轨迹。
- 支持授权用户或授权聊天通过 Telegram 命令手动导出。
- 只导出已有 Grok 分析正文的项目；没有完成 Grok 分析的推送不进入导出文档。
- 按项目合并，按时间段内最高星级分组，同星级内按最高监控池关注数排序。
- 通过 Telegram 回传 Markdown 文档。
- 提供 `查看聊天ID` 辅助命令，方便在频道里获取频道 ID。

## 非目标

- 不从 Telegram 历史消息补齐旧分析。
- 不生成 JSON 导出文件。
- 不做 Web UI。
- 不导出尚未完成 Grok 分析的推送。

## 配置

新增环境变量：

```env
ANALYSIS_ARCHIVE_PATH=data/analysis-archive.jsonl
EXPORT_ADMIN_USERNAMES=
EXPORT_ALLOWED_CHAT_IDS=
```

`EXPORT_ADMIN_USERNAMES` 是 Telegram 用户名白名单，逗号分隔。比较时不区分大小写，配置里带不带 `@` 都可以。

`EXPORT_ALLOWED_CHAT_IDS` 是 Telegram 聊天 ID 白名单，逗号分隔。频道内发命令时，Telegram 可能不会暴露具体管理员用户名，因此频道导出主要依赖这个配置。

授权规则：

- 当前 update 的 chat ID 命中 `EXPORT_ALLOWED_CHAT_IDS`，允许导出。
- 或发送者 username 命中 `EXPORT_ADMIN_USERNAMES`，允许导出。
- 两者都不命中时，机器人回复无权限，不生成文档。

## 归档数据模型

新增 JSONL 归档文件，默认路径为 `data/analysis-archive.jsonl`。

归档文件包含两类记录。

### 分析记录

分析记录保存首次成功生成并发出的 Grok 分析正文：

```ts
interface AnalysisArchiveAnalysisRecord {
  version: 1;
  recordType: 'analysis';
  sourceTaskKey: string;
  projectKey: string;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  archivedAt: string;
  analysisCreatedAt: string;
  star: number;
  count: number;
  channelMessage: {
    chatId: number;
    messageId: number;
  };
  discussionAnalysisMessage: {
    chatId: string | number;
    messageId: number;
  };
  analysisText: string;
}
```

### 命中记录

命中记录保存同一项目后续成功主推送，并且该项目已经有归档分析正文的情况：

```ts
interface AnalysisArchiveHitRecord {
  version: 1;
  recordType: 'hit';
  sourceTaskKey: string;
  projectKey: string;
  title: string;
  content: string;
  link: string;
  mainPushedAt: string;
  archivedAt: string;
  star: number;
  count: number;
  channelMessage: {
    chatId: number;
    messageId: number;
  };
  discussionAnalysisMessage: {
    chatId: string | number;
    messageId: number;
  };
  reminderMessage?: {
    chatId: number;
    messageId: number;
  };
}
```

`sourceTaskKey` 是两类记录共同使用的幂等键。同一个分析任务因为重试重复执行时，归档写入应按 `sourceTaskKey` 覆盖或去重，避免同一次成功任务在导出中重复出现。

`mainPushedAt` 是导出筛选使用的业务时间。它表示主频道推送成功时间，而不是 Grok 分析完成时间。这样导出文档会按项目实际出现在频道里的时间归类。

## 服务集成

现有流程中，主频道推送成功后会写入分析补偿队列。新逻辑需要在主频道推送成功时记录 `mainPushedAt`。如果是失败主推送补偿队列重放成功，则 `mainPushedAt` 使用补发成功时间，因为这是项目实际出现在频道里的时间。

归档写入只发生在以下条件满足后：

1. Grok 分析正文已经生成并完成清洗。
2. 讨论群回复已经成功发出。
3. Telegram 回复结果已经拿到。

`triggerAnalysisComment` 需要返回结构化结果：

- 首次分析：返回清洗后的分析正文和讨论群分析消息引用。
- 重复命中提醒：返回既有分析消息引用和本次提醒消息引用。

服务层根据返回结果写入归档：

- 首次分析成功时，写入 `analysis` 记录。
- 重复命中提醒成功时，如果该项目已有归档 `analysis` 记录，写入 `hit` 记录。

如果某个项目只存在内存里的 `AnalysisTracker` 记录，但没有归档的分析正文，那么后续命中不写入导出归档。这个规则与“从本功能上线后开始可靠导出，不补历史分析正文”的范围一致。

服务启动时，归档存储应能从历史 `analysis` 记录恢复 `AnalysisTracker`。这样服务重启后，重复项目仍然能回复第一次分析消息，并且导出所需的分析正文也有本地来源。

## Telegram 命令

支持中文文本命令，并保留英文斜杠命令作为兼容别名：

```text
查看聊天ID
导出分析 2026-05-01T09 2026-05-20T18

/chatid
/export_analysis 2026-05-01T09 2026-05-20T18
```

中文文本命令是主要使用方式。英文斜杠命令保留是因为 Telegram bot command 菜单和部分客户端对中文斜杠命令支持不稳定。

这些命令都必须支持 Telegram update 的两种消息来源：

- `message`
- `channel_post`

`查看聊天ID` 和 `/chatid` 回复当前 `chat_id`。如果命令来自频道，读取 `channel_post.chat.id`；如果来自私聊或群，读取 `message.chat.id`。

`导出分析` 和 `/export_analysis` 固定接收两个时间参数，格式为 `YYYY-MM-DDTHH`。时间按 `Asia/Shanghai` 解释。

时间范围规则：

- `from` 包含起始小时的整点。
- `to` 包含结束小时的完整一小时。
- 例如 `2026-05-20T18` 表示截止到 `2026-05-20 18:59:59.999 Asia/Shanghai`。

格式错误时回复用法提示。无权限时回复无权限。时间范围内没有已完成 Grok 分析的项目时，回复“该时间段没有已完成 Grok 分析的项目”，不生成空文件。

实现时必须保证同一个 bot token 只有一个活跃的 `getUpdates` 消费者。可以扩展现有讨论群映射 poller，也可以改成统一的 Telegram updates poller，在同一批 update 里同时处理讨论群映射和命令。不能新增第二个独立长轮询，否则会互相抢 update。

## 导出行为

导出器读取 `analysis-archive.jsonl`，筛选 `mainPushedAt` 落在请求范围内的 `analysis` 和 `hit` 记录，并按 `projectKey` 分组。

每个项目的处理规则：

- 项目归入时间段内最高星级分组。
- 使用时间段内最高 `count` 作为同星级排序依据。
- 使用该项目最早归档的 `analysis` 记录作为完整 Grok 分析正文来源；这条分析记录可以在时间段外。
- 列出该项目在时间段内的所有 `analysis` 和 `hit` 记录作为命中记录。
- 如果项目没有任何归档 `analysis` 记录，则忽略该项目。

星级分组按星级从高到低渲染。默认是 5 星到 1 星。如果未来自定义星级数量变化，渲染器应从归档记录中动态推导分组，而不是写死只能有 5 个分组。

同星级内，项目按时间段内最高监控池关注数从高到低排序。关注数相同，则按最早主推送时间从早到晚排序。

## Markdown 文档结构

文件名格式：

```text
alpha-analysis-2026-05-01T09-2026-05-20T18.md
```

文档结构：

```markdown
# Alpha 项目分析导出

时间范围：2026-05-01 09:00 ~ 2026-05-20 18:59（Asia/Shanghai）
导出时间：2026-05-20 13:40
项目数：12

## 5 星项目（3 个）

### 1. Project A
- 链接：https://x.com/project_a
- 最高星级：5 星
- 最高监控池关注数：42
- 首次主推送时间：2026-05-20 10:12
- 主频道消息：https://t.me/c/xxx/123
- 讨论群分析消息：https://t.me/c/yyy/456

#### Grok 分析全文

...

#### 时间段内命中记录

- 2026-05-20 10:12，5 星，监控池关注数 31
- 2026-05-20 13:40，5 星，监控池关注数 42
```

Markdown 必须保留完整的清洗后 Grok 分析正文，不截断、不摘要。

## Telegram 回传

渲染 Markdown 后，机器人把文件作为 Telegram document 附件发回触发命令的聊天。发送文件应复用现有 Telegram 重试配置。

临时生成文件可以放在 `data/exports/` 或系统临时目录。文件名需要便于排查，同时能安全重复生成。

## 错误处理

- 归档文件不存在时视为空归档。
- JSONL 中单行解析失败时跳过该行并打印 warning，不能导致整个导出失败。
- 归档写入失败时记录 warning，但不能阻塞主推送，也不能导致服务崩溃。
- 导出命令处理失败时，给 Telegram 回复简短失败提示，并在日志中记录详细错误。
- Telegram 文件发送失败时复用现有短重试机制。

## 测试范围

需要覆盖：

- 归档存储的读写，以及按 `sourceTaskKey` 幂等去重。
- 分析记录和命中记录的导出合并规则。
- 上海时间小时解析，包括结束小时包含到 `59:59.999`。
- 用户名和 chat ID 权限判断。
- `message` 和 `channel_post` 两种命令解析。
- Markdown 星级分组、项目合并、星级排序、同星级关注数排序。
- 服务集成只在 Grok 分析成功并完成 Telegram 回复后写归档。
- 已有归档分析的重复命中写入 `hit` 记录。
- 空导出结果回复提示，而不是生成空文档。

## 已确认决策

- 不做 Telegram 历史回捞。
- 触发方式：Telegram 命令。
- 授权方式：允许的 chat ID 加管理员 username。
- 输出格式：仅 Markdown。
- 时间精度：小时级 `YYYY-MM-DDTHH`。
- 时间字段：主推送成功时间。
- 项目合并：按项目合并，并归入时间段内最高星级。
- 未完成 Grok 分析：不进入导出。
