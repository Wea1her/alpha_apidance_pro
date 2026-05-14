# Alpha Apidance 共同关注推送服务

这是一个后端服务，用白名单钱包登录 `alpha.apidance.pro`，监听用户 WebSocket 推送消息，并根据“你关注的 N 个用户也关注了 ta”做共同关注星级过滤。达到阈值后，服务会把消息转发到 Telegram。

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
6. 达到阈值后转发到 `TELEGRAM_CHAT_ID`
7. 达到 3 星及以上时，尝试调用 Grok 分析并回复到 `DISCUSSION_CHAT_ID` 对应的评论线程

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

后续接入真实事件时，每次 `A 新关注 B` 都会重新计算 `B` 被监控池关注的数量。只要达到 1 星以上就推送，并在消息里标明当前星级。

当前数据来源是 alpha WebSocket 消息里的文案：

```text
你关注的 N 个用户也关注了ta
```

服务不调用 `commonfollow` 接口，因此不会触发它的速率限制。

## 可靠性策略

服务模式包含：

```text
WebSocket 断线自动重连
heartbeat 超时主动重连
登录失败自动重试
重复事件去重
解析失败保留日志
```

## 3 星以上账号分析

当共同关注达到 3 星及以上时，服务会尝试调用 Grok 生成一段简短分析，并回复到频道消息对应的关联讨论群评论线程。

当前按 OpenAI 兼容接口接入：

```text
POST {XAI_BASE_URL}/v1/chat/completions
```

## 验证

```bash
npm test
npm run typecheck
```
