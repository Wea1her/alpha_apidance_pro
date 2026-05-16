# Alpha Apidance 共同关注推送服务

这是一个长期运行的后端监听服务。服务会使用白名单钱包登录 `alpha.apidance.pro`，连接 Alpha 用户 WebSocket，把上游推送里的共同关注数据转化为 Telegram 频道消息，并在关联讨论群中生成 Grok 投研分析。

当前服务不调用 `commonfollow` 接口，数据来源是 Alpha WebSocket 推送内容，因此不会受到 `commonfollow` 接口速率限制影响。

## 核心能力

- 白名单钱包签名登录 Alpha。
- 监听 `alpha.apidance.pro` WebSocket 上游推送。
- 从推送文本中解析“你关注的 N 个用户也关注了 ta”。
- 按共同关注人数计算 1-5 星重要程度。
- 从 1 星开始调用 Grok 做账号分类过滤。
- 过滤 KOL、个人账号、个人开发者/dev 账号、媒体属性账号。
- 只把项目、Alpha、未知但可能有价值的账号推送到 Telegram 频道。
- 同一项目 1-4 星只在星级升高时重复推送，5 星项目后续继续推送。
- 首次有效项目会在关联讨论群中生成 Grok 分析。
- 重复项目不重复调用 Grok 分析，而是回复第一次分析消息做提醒。
- 使用 6551 查询删帖历史、近期推文、负面提及和评论区负面样本，辅助判断 Rug 风险。
- 支持 WebSocket 断线重连、heartbeat 超时重连、登录失败重试。

## 运行环境

本地或服务器需要：

```text
Node.js 20 或 22
npm
可访问 Alpha、Telegram、Grok API、6551 API 的网络环境
```

服务器 24 小时运行建议：

```text
最低配置：1 核 CPU、1GB 内存、10GB 硬盘
推荐配置：1-2 核 CPU、2GB 内存、20GB 硬盘
系统建议：Ubuntu 22.04 或 Ubuntu 24.04
```

服务本身不吃硬盘，主要占用来自运行日志。

## 安装

```bash
git clone https://github.com/Wea1her/alpha_apidance_pro.git
cd alpha_apidance_pro
npm install
```

如果是本地已有项目，直接进入项目目录：

```bash
cd daxinjiankong
npm install
```

## 配置

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
nano .env
```

完整配置示例：

```env
ALPHA_WALLET_PRIVATE_KEY=0x...
ALPHA_BASE_URL=https://alpha.apidance.pro/api
ALPHA_WS_BASE_URL=wss://alpha.apidance.pro/api

COMMON_FOLLOW_STAR_LEVELS=5,8,12,15,20
ALPHA_HEARTBEAT_TIMEOUT_MS=90000
ALPHA_RECONNECT_MIN_DELAY_MS=1000
ALPHA_RECONNECT_MAX_DELAY_MS=30000

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCUSSION_CHAT_ID=
TELEGRAM_RETRY_ATTEMPTS=5
TELEGRAM_RETRY_MIN_DELAY_MS=1000
TELEGRAM_RETRY_MAX_DELAY_MS=30000
FAILED_QUEUE_PATH=data/failed-messages.jsonl
FAILED_QUEUE_DEAD_LETTER_PATH=data/dead-letter-messages.jsonl
FAILED_QUEUE_RETRY_INTERVAL_MS=30000
FAILED_QUEUE_MAX_ATTEMPTS=20
ANALYSIS_QUEUE_PATH=data/analysis-tasks.jsonl
ANALYSIS_QUEUE_DEAD_LETTER_PATH=data/analysis-dead-letter.jsonl
ANALYSIS_QUEUE_RETRY_INTERVAL_MS=30000
ANALYSIS_QUEUE_MAX_ATTEMPTS=30

PROXY_URL=

XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai
XAI_MODEL=grok-4.20-fast

TWITTER_TOKEN=
TWITTER_API_BASE_URL=https://ai.6551.io
```

不要提交 `.env`，也不要泄露钱包私钥、Telegram Bot Token、Grok Key、6551 Token。

## 配置说明

`ALPHA_WALLET_PRIVATE_KEY` 是 Alpha 白名单钱包私钥，用于签名登录。

`ALPHA_BASE_URL` 是 Alpha HTTP API 地址，默认是 `https://alpha.apidance.pro/api`。

`ALPHA_WS_BASE_URL` 是 Alpha WebSocket API 地址，默认是 `wss://alpha.apidance.pro/api`。

`COMMON_FOLLOW_STAR_LEVELS` 是共同关注星级阈值，默认建议 `5,8,12,15,20`。

`TELEGRAM_BOT_TOKEN` 是 Telegram 机器人 Token。

`TELEGRAM_CHAT_ID` 是主推送频道 ID。

`DISCUSSION_CHAT_ID` 是频道关联讨论群 ID，用于写入 Grok 分析和重复命中提醒。

`TELEGRAM_RETRY_ATTEMPTS`、`TELEGRAM_RETRY_MIN_DELAY_MS`、`TELEGRAM_RETRY_MAX_DELAY_MS` 控制 Telegram 主推送、讨论群回复和 updates 轮询的短重试。默认是 5 次，1 秒起步，最高 30 秒。

`FAILED_QUEUE_PATH` 是主频道推送最终失败后的本地补偿队列文件，默认 `data/failed-messages.jsonl`。

`FAILED_QUEUE_DEAD_LETTER_PATH` 是超过最大补发次数后的死信文件，默认 `data/dead-letter-messages.jsonl`。

`FAILED_QUEUE_RETRY_INTERVAL_MS` 是后台补偿 worker 扫描间隔，默认 30 秒。

`FAILED_QUEUE_MAX_ATTEMPTS` 是单条失败消息进入死信队列前的最大补发次数，默认 20 次。

`ANALYSIS_QUEUE_PATH` 是讨论群分析补偿队列文件，默认 `data/analysis-tasks.jsonl`。

`ANALYSIS_QUEUE_DEAD_LETTER_PATH` 是讨论群分析超过最大补发次数后的死信文件，默认 `data/analysis-dead-letter.jsonl`。

`ANALYSIS_QUEUE_RETRY_INTERVAL_MS` 是分析补偿 worker 扫描间隔，默认 30 秒。

`ANALYSIS_QUEUE_MAX_ATTEMPTS` 是单条分析任务进入死信队列前的最大补发次数，默认 30 次。

`PROXY_URL` 是代理地址。服务器没有代理时留空；如果服务器本机跑 Clash，可以填 `http://127.0.0.1:7890`。

`XAI_API_KEY`、`XAI_BASE_URL`、`XAI_MODEL` 用于 Grok 账号分类和投研分析。

`TWITTER_TOKEN`、`TWITTER_API_BASE_URL` 用于 6551 Rug 历史证据查询。

## 启动服务

```bash
npm start
```

正常启动后会看到类似日志：

```text
alpha wallet: 0x...
alpha websocket 已连接
alpha 共同关注推送服务已启动
```

服务启动后会长期运行：

1. 使用钱包签名固定登录消息 `welcome to alpha3!`。
2. 调用 Alpha 登录接口获取 token。
3. 连接 Alpha WebSocket。
4. 接收 heartbeat 和关注推送事件。
5. 解析共同关注人数。
6. 按星级阈值判断是否进入推送流程。
7. 调用 Grok 分类账号。
8. 过滤 KOL、个人、个人开发者/dev、媒体属性账号。
9. 推送项目/Alpha/未知类型账号到 Telegram 频道。
10. 在关联讨论群回复 Grok 分析。

## 测试监听

```bash
npm run alpha:ws
```

这个命令只测试 Alpha 登录和 WebSocket 消息接收，不会转发 Telegram，适合确认白名单钱包和上游推送是否正常。

如果只想临时监听一段时间，可以设置：

```bash
ALPHA_LISTEN_SECONDS=180 npm run alpha:ws
```

`ALPHA_LISTEN_SECONDS` 只对测试监听脚本有效，不影响正式 `npm start` 服务。

## 共同关注星级规则

默认配置：

```env
COMMON_FOLLOW_STAR_LEVELS=5,8,12,15,20
```

对应规则：

```text
监控池关注数 < 5    不推送
监控池关注数 >= 5   1 星
监控池关注数 >= 8   2 星
监控池关注数 >= 12  3 星
监控池关注数 >= 15  4 星
监控池关注数 >= 20  5 星
```

例如 `A 新关注 B` 时，服务计算的是你的监控池里还有多少人同时关注了 `B`。只有达到最低阈值后才进入分类和推送流程。

## 重复推送规则

服务有两层去重：

1. 事件级去重：同一条 Alpha 原始推送重复到达时，只处理一次。
2. 项目级星级去重：同一项目 1-4 星只有星级升高时才再次推送；达到 5 星后继续推送后续命中。

示例：

```text
B 第一次达到 5 个共同关注：1 星，推送
B 后续达到 7 个共同关注：仍然 1 星，不推送
B 后续达到 8 个共同关注：升到 2 星，再次推送
B 后续达到 20 个共同关注：5 星，推送
B 后续仍是 5 星：继续推送
```

升星重复推送的第一行会显示：

```text
检测到项目星级变化：1星 → 2星
```

注意：项目级星级记录目前保存在服务进程内存中。服务重启后，这个内存状态会清空，重启后的首次命中会重新按首次项目处理。

## 推送格式

频道主消息格式大致如下：

```text
⭐⭐ Alpha 共同关注推送

A 关注了 B
监控池关注数：8
重要程度：⭐⭐
延迟：1.234 秒
https://x.com/xxx

原始 Alpha 内容
```

如果是升星重复推送，第一行会增加星级变化提醒：

```text
检测到项目星级变化：1星 → 2星
⭐⭐ Alpha 共同关注推送
```

## 账号分类过滤

从 1 星开始，服务会先调用 Grok 判断账号类型。

允许推送：

```text
PROJECT：项目、协议、产品、应用、平台、官方账号
ALPHA：早期机会、链上热点、打新线索
UNKNOWN：信息不足但不能确定排除
```

拦截不推送：

```text
KOL：个人影响力账号、交易员、研究员、博主、资讯号主
PERSONAL：普通个人账号、创始人个人号、团队成员个人号
DEV：个人开发者、工程师、dev、builder、独立开发者、技术贡献者、开源作者
MEDIA：媒体、新闻、资讯聚合、快讯、行情播报、内容搬运账号
```

如果 Grok 分类失败，服务会按保守策略继续推送，避免漏掉潜在项目。

## Grok 分析

账号通过分类过滤后，服务会在 Telegram 频道发送主消息，并等待频道消息同步到关联讨论群。找到映射后，服务会在讨论群对应消息下回复 Grok 分析。

分析由 `analysis-skills/project-alpha.md` 控制。修改这个文件后，重启服务即可生效。

当前分析固定包含 7 个章节：

```text
1. 项目核心信息
2. 当前进展
3. 优点
4. 缺点
5. 关注理由
6. 标签
7. Rug 历史/风险
```

每个章节标题单独一行，正文在下一行输出。分析不会输出 Markdown 加粗星号，也不会在末尾输出 Source、来源、参考来源或引用列表。

## 重复项目分析规则

同一项目首次通过分类并推送后，会调用 Grok 生成完整分析。

同一项目后续再次升星推送时，不再重复调用 Grok 分析，而是在第一次分析消息下回复提醒。

提醒格式：

```text
重复命中提醒

A 关注了 B
监控池关注数：12
当前重要程度：3 星
```

## Rug 历史分析

首次项目分析前，服务会通过 6551 查询目标 X 账号的历史风险证据。

当前会查询：

```text
twitter_user_info：账号基础信息
twitter_deleted_tweets：删帖历史
twitter_user_tweets：近期推文
twitter_quote_tweets_by_id：近期推文引用评论
twitter_search：负面提及、回复和评论区负面样本
```

重点关注：

```text
删帖数量
删帖频率
近期高风险关键词
负面提及数量
评论区负面样本
类似项目结局
跑路、骗局、钓鱼、无法提现等风险信号
```

如果没有配置 `TWITTER_TOKEN`，或者 6551 查询失败，服务仍会正常推送和分析。Grok 会收到“证据缺失或查询失败”的上下文，而不是直接中断服务。

## 关联讨论群要求

如果需要 Grok 分析评论到频道消息下面，需要：

1. Telegram 频道已经关联讨论群。
2. 机器人同时在频道和讨论群里。
3. 机器人有发送消息权限。
4. `.env` 中配置了 `TELEGRAM_CHAT_ID` 和 `DISCUSSION_CHAT_ID`。

服务会轮询 Telegram updates，记录频道消息和讨论群自动同步消息之间的映射，再把 Grok 分析回复到对应讨论群消息下。

如果没有配置 `DISCUSSION_CHAT_ID`，频道主推送仍然可以发送，但不会写入 Grok 分析评论。

## 24 小时部署

推荐使用 PM2 常驻运行。

安装 PM2：

```bash
sudo npm install -g pm2
```

启动服务：

```bash
pm2 start npm --name daxinjiankong -- start
```

保存进程列表：

```bash
pm2 save
```

设置开机自启：

```bash
pm2 startup
```

执行 `pm2 startup` 输出的那条 `sudo env ...` 命令。

常用命令：

```bash
pm2 status
pm2 logs daxinjiankong
pm2 restart daxinjiankong
pm2 stop daxinjiankong
```

更新代码后重启：

```bash
git pull
npm install
pm2 restart daxinjiankong
```

## 代理说明

如果服务器网络能直连 Alpha、Telegram、Grok、6551，`PROXY_URL` 留空即可。

如果服务器本机运行 Clash，通常配置：

```env
PROXY_URL=http://127.0.0.1:7890
```

如果是本地 WSL 调用 Windows Clash，并且 Windows Clash 开启了 Allow LAN，可以使用 Windows 网关 IP，例如：

```env
PROXY_URL=http://172.31.224.1:7890
```

服务器部署时不要直接沿用本地 WSL 的代理 IP，除非服务器网络环境确实能访问这个地址。

## 可靠性策略

服务包含以下容错逻辑：

```text
WebSocket 断线自动重连
heartbeat 超时主动重连
登录失败自动重试
Telegram 主推送 fetch failed 自动重试
Telegram 讨论群回复和 updates 轮询自动重试
Telegram 主推送最终失败后写入本地补偿队列
后台 worker 定时补发失败主推送，成功后继续触发分析流程
超过最大补发次数进入死信队列
讨论群分析任务异步入队，不阻塞主推送成功判定
讨论群映射缺失、Grok 失败、评论回复失败都会进入分析补偿队列
事件级重复消息去重
项目级升星重复推送
账号分类失败时保守推送
6551 查询失败不阻塞主推送
Grok 分析失败不影响后续 WebSocket 监听
```

注意：Alpha WebSocket 断线期间，如果上游没有补发历史消息，服务无法凭空补回断线窗口内的 Alpha 推送，只能尽快重连并继续接收新消息。

## 本地验证

运行测试：

```bash
npm test
```

运行类型检查：

```bash
npm run typecheck
```

## 重要提醒

- `.env` 不要提交到 GitHub。
- 钱包私钥只建议使用专门为 Alpha 白名单准备的钱包，不要使用存放资金的钱包。
- Telegram Bot Token、Grok API Key、6551 Token 泄露后需要立即吊销并更换。
- 项目级星级状态当前保存在内存中，服务重启会清空。
- 修改 `analysis-skills/project-alpha.md` 后需要重启服务才能加载新分析规则。
