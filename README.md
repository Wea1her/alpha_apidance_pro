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
- 首次有效项目会在关联讨论群中使用 `grok-4.3` 生成标准分析。
- 重复项目沿用第一次标准分析并回复提醒；首次达到 5 星时可额外生成一份深度投研。
- 深度投研通过 fengshao 的 `grok-4.20-multi-agent-0309` 独立渠道生成，每个项目一份，回复在首次 5 星频道消息对应的讨论群线程下。
- Grok 分析时通过 xAI 的 web_search / x_search 联网检索账号背景和背书账号。
- 支持 WebSocket 断线重连、heartbeat 超时重连、登录失败重试。

## 运行环境

本地或服务器需要：

```text
Node.js 20 或 22
npm
可访问 Alpha、Telegram、Grok API 的网络环境
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
ALPHA_BUSINESS_SILENCE_TIMEOUT_MS=60000
ALPHA_REPLAY_LOOKBACK_MS=600000
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
ANALYSIS_ARCHIVE_PATH=data/analysis-archive.jsonl
EXPORT_ADMIN_USERNAMES=
EXPORT_ALLOWED_CHAT_IDS=
PROJECT_STATE_PATH=data/project-state.json

PROXY_URL=

XAI_API_KEY=
XAI_BASE_URL=https://api.x.ai
XAI_MODEL=grok-4.3
XAI_RETRY_ATTEMPTS=5
XAI_RETRY_MIN_DELAY_MS=1000
XAI_RETRY_MAX_DELAY_MS=20000
XAI_MAX_TOKENS=2048
XAI_SEARCH_TOOLS=web_search,x_search

XAI_DEEP_API_KEY=
XAI_DEEP_BASE_URL=https://api.fengshao1227.com
XAI_DEEP_MODEL=grok-4.20-multi-agent-0309
XAI_DEEP_MAX_TOKENS=4096
XAI_DEEP_SEARCH_TOOLS=web_search
```

不要提交 `.env`，也不要泄露钱包私钥、Telegram Bot Token、Grok Key。

## 配置说明

`ALPHA_WALLET_PRIVATE_KEY` 是 Alpha 白名单钱包私钥，用于签名登录。

`ALPHA_BASE_URL` 是 Alpha HTTP API 地址，默认是 `https://alpha.apidance.pro/api`。

`ALPHA_WS_BASE_URL` 是 Alpha WebSocket API 地址，默认是 `wss://alpha.apidance.pro/api`。

`COMMON_FOLLOW_STAR_LEVELS` 是共同关注星级阈值，默认建议 `5,8,12,15,20`。

`ALPHA_BUSINESS_SILENCE_TIMEOUT_MS` 是业务消息静默 watchdog，默认 60 秒。超过该时间没有收到非 heartbeat 业务消息会主动重连，用于缩短 WebSocket 假活窗口。

`ALPHA_REPLAY_LOOKBACK_MS` 是未来 Alpha 历史回放 provider 可用时的回看窗口，默认 10 分钟。当前未发现可用的 Alpha 历史事件 REST 接口，因此不会补回上游没有下发的共同关注事件。

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

`ANALYSIS_ARCHIVE_PATH` 是 Grok 分析归档文件，默认 `data/analysis-archive.jsonl`。

`EXPORT_ADMIN_USERNAMES` 是允许触发分析导出的 Telegram 用户名列表，逗号分隔，带不带 `@` 都可以。

`EXPORT_ALLOWED_CHAT_IDS` 是允许触发分析导出的 Telegram 聊天 ID 列表，逗号分隔。频道内导出建议使用这个配置。

`PROJECT_STATE_PATH` 是项目星级、推送次数和首次频道消息引用的本地状态文件，默认 `data/project-state.json`。服务重启后会用它恢复重复推送判断和首次推送链接。

`PROXY_URL` 是代理地址。服务器没有代理时留空；如果服务器本机跑 Clash，可以填 `http://127.0.0.1:7890`。

`XAI_API_KEY`、`XAI_BASE_URL`、`XAI_MODEL` 用于账号分类和标准投研分析。当前配置为 `XAI_MODEL=grok-4.3`，深度渠道的配置不会覆盖它。

`XAI_RETRY_ATTEMPTS`、`XAI_RETRY_MIN_DELAY_MS`、`XAI_RETRY_MAX_DELAY_MS` 控制 Grok 账号分类和分析的短重试。空回复、网络错误、429 和 5xx 会重试；默认 5 次，1 秒起步，最高 20 秒。

`XAI_MAX_TOKENS` 控制 Grok 单次回复 token 预算，默认 2048。若分析经常被截断可适当调高；若只是偶发 `completion_tokens=0`，优先调高重试次数。

`XAI_SEARCH_TOOLS` 控制 Grok 投研分析时启用的 xAI 服务端联网检索工具，逗号分隔，只接受 `web_search` 和 `x_search`。未设置或留空时默认 `web_search,x_search`；填 `none` 关闭联网检索。启用后分析请求走 xAI Responses API，检索按 xAI 的来源计费；账号分类不使用检索。如果 `XAI_BASE_URL` 指向的中转站不支持 Responses API，服务会记录警告并自动退回普通 Grok 请求；如果中转站接受了请求但上游没有真正执行检索（响应里 `num_server_side_tools_used=0`），服务也会记录警告，此时第 2 节的背书信息并未经过检索。

`XAI_DEEP_API_KEY` 是 fengshao 渠道的独立 API Key。留空时关闭深度投研，不影响标准分析；已入队的深度任务会保留，重新配置并启动服务后继续处理。

`XAI_DEEP_BASE_URL` 默认 `https://api.fengshao1227.com`，`XAI_DEEP_MODEL` 默认使用该渠道的具体模型 ID `grok-4.20-multi-agent-0309`。`XAI_DEEP_MAX_TOKENS` 默认 4096，控制深度报告输出预算。

`XAI_DEEP_SEARCH_TOOLS` 默认 `web_search`，留空也采用此默认值；填 `none` 关闭检索。按实际渠道能力配置工具，深度请求使用独立的模型、Key 和地址。其网络代理及短重试参数沿用 `PROXY_URL` 和 `XAI_RETRY_*`。

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
11. 首次达到 5 星时，通过独立处理循环追加深度投研；长时间的深度请求不会阻塞标准分析队列。

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
3. 频道主消息会显示同项目第几次推送：1 星是第 1 次，2 星是第 2 次，依次类推；首次 5 星是第 5 次，5 星后续每成功推送一次继续加 1。
4. 后续重复推送会显示首次频道推送链接，便于跳回第一次推送查看 AI 分析。

示例：

```text
B 第一次达到 5 个共同关注：1 星，推送
B 后续达到 7 个共同关注：仍然 1 星，不推送
B 后续达到 8 个共同关注：升到 2 星，再次推送
B 后续达到 20 个共同关注：5 星，推送
B 后续仍是 5 星：继续推送，显示第 6 次推送，并带首次推送链接
```

频道主消息第一行会显示推送次数。重复推送会在后面显示首次推送链接，升星重复推送还会显示星级变化：

```text
第2次推送
首次推送：https://t.me/c/1234567890/321
检测到项目星级变化：1星 → 2星
```

项目星级、推送次数和首次频道消息记录通过 `PROJECT_STATE_PATH` 持久化。标准分析从 `ANALYSIS_ARCHIVE_PATH` 恢复；深度任务与发送进度从 `ANALYSIS_QUEUE_PATH` 恢复，已完成的深度报告从归档恢复去重。

## 推送格式

频道主消息格式大致如下：

```text
第2次推送
⭐⭐ Alpha 共同关注推送

A 关注了 B
监控池关注数：8
重要程度：⭐⭐
延迟：1.234 秒
https://x.com/xxx

原始 Alpha 内容
```

如果是升星重复推送，推送次数后会增加星级变化提醒：

```text
第2次推送
首次推送：https://t.me/c/1234567890/321
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

补充规则：

```text
meme 叙事本身不是拦截理由；meme 项目官方账号仍可归为 PROJECT 或 ALPHA
Meme Degen、memer、speculator、trader 这类明显是个人投机/喊单身份的账号按 KOL 拦截
```

如果 Grok 分类失败，服务会按保守策略继续推送，避免漏掉潜在项目。

## Grok 分析

账号通过分类过滤后，服务会在 Telegram 频道发送主消息，并等待频道消息同步到关联讨论群。找到映射后，服务会在讨论群对应消息下回复 Grok 分析。

分析由 `analysis-skills/project-alpha.md` 控制。修改这个文件后，重启服务即可生效。

分析默认输出 7 个章节：

```text
1. 项目核心信息
2. 项目背景/背书账号
3. 当前进展
4. 优点
5. 缺点
6. 关注理由
7. 标签
```

每个章节标题单独一行，正文在下一行输出。分析不会输出 Markdown 加粗星号，也不会在末尾输出 Source、来源、参考来源或引用列表；检索产生的 `[1]`、`【1】` 之类引用标记会在发送前清理。

## 首次 5 星深度投研

配置 `XAI_DEEP_API_KEY` 和频道关联讨论群后，项目首次以 5 星或以上成功推送时，会追加一条独立的深度任务。首次发现就达到 5 星，以及从 1–4 星升到 5 星，都会触发。同项目后续 5 星命中只沿用已有任务或报告，不会改换回复目标，也不会重新生成已保存的深度报告。

标准分析继续使用 `grok-4.3`，账号分类、首次七章分析和重复提醒逻辑保持原样。深度报告使用 fengshao 的 `grok-4.20-multi-agent-0309`；如果该项目已有标准分析归档，会将其作为深化和校正的上下文，没有标准归档时也可以独立执行。

深度报告固定回复在**触发该任务的首次 5 星频道消息**所对应的讨论群根消息下，消息标题为“Grok 深度分析”。长报告分成多条，每条均回复同一根消息，并显示分片序号。若标准分析早于 5 星生成，原来的标准分析和重复提醒仍留在原线程。

默认深度模板输出六个章节：

```text
1. 项目定位与玩法
2. 当前热度
3. 背书与合作关系
4. 风险
5. 机遇
6. 结论
```

可以新建 `analysis-skills/project-deep.md` 自定义深度模板；缺少该文件时使用内置模板，不影响 `project-alpha.md` 的标准模板。深度报告保留来源裸链接，只清理加粗、斜体和数字引用标记。默认通过 `web_search` 检索官网、文档及公开推文证据，不能直接证明 X 内部关注关系；没有证据时必须明确说明。若渠道不支持检索，请求会记录警告并降级，同时明确告知模型本次未启用联网检索。

深度任务使用 `kind: "deep"` 与标准任务区分，并保存首次 5 星频道消息引用。模型返回后先保存报告和分片，再发送 Telegram；每片成功后保存发送进度。任务重试和服务重启会复用已保存的报告，仅补发未记录成功的分片。全部发送完成后，以 `recordType: "deep"` 写入分析归档，标准分析的归档与重复提醒目标保持独立。现有导出仍使用标准分析与命中记录，深度归档不会被重复计为新的命中。

深度任务沿用 `ANALYSIS_QUEUE_*` 补偿与死信配置。进入死信队列的项目不会因后续 5 星命中自动创建新任务；排查后应恢复原任务及发送进度。保留队列、死信、归档和讨论群映射文件，才能在重启后继续去重和补发。

## 项目背景/背书账号

首次 Grok 分析会启用 `XAI_SEARCH_TOOLS` 配置的 xAI 服务端检索工具：用 `x_search` 检索目标 X 账号被哪些知名项目方、交易所、VC/基金、生态官方关注、互动、转发或联合公告，用 `web_search` 检索官网、融资、合作和媒体报道。Grok 会在 `2. 项目背景/背书账号` 中只列出确实检索到的账号，最多 10 个，并说明检索依据；优先展示项目方、协议官方、产品官方、交易所、VC、基金、生态官方、公链、Foundation、Labs，这些不足时再补充知名 Crypto KOL、媒体或社区号。

如果 `XAI_SEARCH_TOOLS=none`，或者中转站不支持 Responses API 导致退回普通请求，第 2 节会说明“无法确认知名 Crypto 背书账号”，不能据此推断存在背书。

## 重复项目分析规则

同一项目首次通过分类并推送后，会调用 Grok 生成完整分析。

同一项目后续再次升星推送时，不再重复调用标准 Grok 分析，而是在第一次分析消息下回复提醒。首次 5 星深度投研按上文规则独立追加。

提醒格式：

```text
重复命中提醒

A 关注了 B
监控池关注数：12
当前重要程度：3 星
```

## 分析归档导出

功能上线后，服务会把成功写入讨论群的 Grok 分析归档到 `ANALYSIS_ARCHIVE_PATH`。重复命中项目如果已经有历史分析，也会记录为同项目命中，用于导出时按项目维度合并。

在授权频道、群或私聊中发送：

```text
查看聊天ID
```

机器人会回复当前聊天 ID，可用于配置 `EXPORT_ALLOWED_CHAT_IDS`。频道内命令通常没有发送者用户名，建议用聊天 ID 授权。

导出指定小时范围内的 Markdown 文档：

```text
导出分析 2026-05-01T09 2026-05-20T18
```

时间按 `Asia/Shanghai` 解释，结束小时包含完整一小时。导出只包含已经完成 Grok 分析的项目；没有分析正文的推送不会出现在文档里。

导出文档会按时间段内项目最高星级分组，同一星级下按最高监控池关注数从高到低排序。多个 5 星项目会并列显示在同一个 `5 星项目` 分组下。

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
pm2 start ecosystem.config.cjs
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

如果服务器网络能直连 Alpha、Telegram、Grok，`PROXY_URL` 留空即可。

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
业务消息静默 60 秒主动重连
登录失败自动重试
Telegram 主推送 fetch failed 自动重试
Telegram 讨论群回复和 updates 轮询自动重试
Telegram 主推送最终失败后写入本地补偿队列
后台 worker 定时补发失败主推送，成功后继续触发分析流程
超过最大补发次数进入死信队列
Alpha 历史回放 provider 边界已预留；当前上游没有历史事件 REST 接口时不伪造补漏
讨论群分析任务异步入队，不阻塞主推送成功判定
讨论群映射缺失、Grok 失败、评论回复失败都会进入分析补偿队列
Grok 空回复会按可重试错误处理，并在日志里记录 completion_tokens 和 finish_reason
事件级重复消息去重
项目级升星重复推送
账号分类失败时保守推送
xAI 联网检索工具不可用时退回普通 Grok 请求，不阻塞分析
Grok 分析失败不影响后续 WebSocket 监听
```

注意：Alpha WebSocket 断线或上游 502 期间，如果 Alpha 没有下发历史事件，且没有可用历史事件 REST 接口，服务无法重建断线窗口内的共同关注推送。当前优化能缩短假活窗口，并保障“已经收到但 Telegram 发送失败”的事件被本地队列补发。

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
- Telegram Bot Token、Grok API Key 泄露后需要立即吊销并更换。
- 项目级星级状态保存在 `PROJECT_STATE_PATH`，服务重启后会恢复。
- 修改 `analysis-skills/project-alpha.md` 后需要重启服务才能加载新分析规则。
