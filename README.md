# Alpha Apidance 共同关注推送服务

这是一个后端服务，用白名单钱包登录 `alpha.apidance.pro`，监听用户 WebSocket 推送消息，并根据“你关注的 N 个用户也关注了 ta”做共同关注星级过滤。达到阈值后，服务会先用 Grok 判断账号类型，再把项目/Alpha 类账号转发到 Telegram。

## 配置

```bash
cp .env.example .env
```

填写 `.env`：

```bash
ALPHA_WALLET_PRIVATE_KEY=0x...
ALPHA_LISTEN_SECONDS=120
COMMON_FOLLOW_STAR_LEVELS=5,8,12,15,20
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCUSSION_CHAT_ID=
PROXY_URL=http://172.31.224.1:7890
XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai
XAI_MODEL=grok-4.20-fast
TWITTER_TOKEN=
TWITTER_API_BASE_URL=https://ai.6551.io
```

不要提交 `.env`，也不要泄露钱包私钥。

## 运行服务

```bash
npm start
```

服务会长期运行：

1. 签名固定登录消息 `welcome to alpha3!`
2. 调用 `POST https://alpha.apidance.pro/api/v1/login`
3. 连接 `wss://alpha.apidance.pro/api/v1/user/ws?token=...`
4. 自动处理 heartbeat、断线重连和 token 重登
5. 解析共同关注数量并按星级规则过滤
6. 从 1 星开始调用 Grok 做账号分类
7. 项目/Alpha/未知类型转发到 `TELEGRAM_CHAT_ID`
8. KOL/个人账号不推送
9. 推送后调用 6551 查询 Rug 历史证据
10. 调用 Grok 分析并回复到 `DISCUSSION_CHAT_ID` 对应的评论线程

## 测试监听

```bash
npm run alpha:ws
```

测试脚本只打印 WebSocket 消息，不会转发 Telegram，适合确认 alpha 登录和推送字段：

1. 签名固定登录消息 `welcome to alpha3!`
2. 调用 `POST https://alpha.apidance.pro/api/v1/login`
3. 连接 `wss://alpha.apidance.pro/api/v1/user/ws?token=...`
4. 打印 heartbeat 和非 heartbeat 消息

## 共同关注星级规则

`COMMON_FOLLOW_STAR_LEVELS=5,8,12,15,20` 表示：

```text
监控池关注数 < 5   不推送
监控池关注数 >= 5  1 星
监控池关注数 >= 8  2 星
监控池关注数 >= 12 3 星
监控池关注数 >= 15 4 星
监控池关注数 >= 20 5 星
```

后续接入真实事件时，每次 `A 新关注 B` 都会重新计算 `B` 被监控池关注的数量。只要达到 1 星以上就进入 Grok 分类流程，并在通过分类后推送当前星级。

当前数据来源是 alpha WebSocket 消息里的文案：

```text
你关注的 N 个用户也关注了ta
```

服务不调用 `commonfollow` 接口，因此不会触发它的速率限制。

## 账号分类过滤

服务会从 1 星开始先调用 Grok 做账号分类：

- `PROJECT` / `ALPHA` / `UNKNOWN`：发送频道主消息，并在关联讨论群写分析。
- `KOL` / `PERSONAL`：不发送频道消息，也不写分析。
- 分类失败时按保守策略继续推送并分析，避免漏掉潜在项目。

分类通过后，首次项目会生成 7 行投研分析；同一项目后续重复命中时，不再重复调用 Grok 分析，而是回复第一次分析评论做提醒。

## Rug 历史分析

首次项目分析会使用 6551 查询目标账号的删帖记录、近期推文、负面提及和评论区负面样本，并把证据加入 Grok 分析里的“Rug 历史/风险”行。

评论区深挖使用 6551 的 `twitter_quote_tweets_by_id` 拉取近期推文的引用评论，并用 `twitter_search` 的 `toUser` + 负面关键词补充回复/提及搜索。当前不是完整 replies 树，而是 quote tweets + 搜索近似。

需要配置：

```env
TWITTER_TOKEN=
TWITTER_API_BASE_URL=https://ai.6551.io
```

如果没有配置 `TWITTER_TOKEN`，或者 6551 查询失败，服务仍会正常推送和分析；Rug 历史会显示未查询、查询失败或暂无直接证据。

## 可靠性策略

服务模式包含：

```text
WebSocket 断线自动重连
heartbeat 超时主动重连
登录失败自动重试
重复事件去重
解析失败保留日志
```

## 账号分析

当账号通过分类过滤后，服务会调用 Grok 生成投研分析，并回复到频道消息对应的关联讨论群评论线程。

分析格式由 `analysis-skills/project-alpha.md` 控制。修改这个中文 Markdown 文件后，重启服务即可生效。默认模板包含项目核心信息、当前进展、优缺点、关注理由、标签、Rug 历史/风险 7 个维度。

当前按 OpenAI 兼容接口接入：

```text
POST {XAI_BASE_URL}/v1/chat/completions
```

## 验证

```bash
npm test
npm run typecheck
```
