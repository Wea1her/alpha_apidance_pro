# 6551 Rug 历史分析设计

## 背景

当前服务已经实现：

- 从 alpha WebSocket 接收关注事件。
- 按共同关注数映射 1-5 星。
- 从 1 星开始先用 Grok 做账号分类。
- `PROJECT` / `ALPHA` / `UNKNOWN` 进入频道并写分析评论。
- `KOL` / `PERSONAL` 被拦截，不推送。
- 同一项目首次命中时写 Grok 分析，后续重复命中只回复第一次分析评论。

新需求是在 Grok 分析里增加“Rug 历史/风险”视角。这个视角需要基于 6551 API 查询目标账号的历史删帖记录、近期推文和用户评论/提及，辅助判断该项目是否有跑路、割韭菜、骗局或严重负面历史。

## 目标

在项目通过分类过滤并准备写首次 Grok 分析时，额外调用 6551 作为数据源，生成 Rug 风险证据摘要，并把摘要放入 Grok 分析 prompt。

第一版目标：

- 查询目标账号基础信息。
- 查询目标账号历史删帖记录。
- 查询目标账号近期推文。
- 查询 X 用户对目标账号的负面评论、提及和讨论。
- 在 Grok 分析输出里新增 `Rug 历史/风险` 视角。
- 6551 查询失败不阻塞主推送，也不阻塞基础分析。

## 非目标

- 不直接使用官方 X API。
- 不改变 alpha WebSocket 数据源。
- 不对 `KOL` / `PERSONAL` 拦截账号查询 6551。
- 不对重复项目重新做 Grok 分析或重新拉取 Rug 历史。
- 不在第一版做数据库持久化缓存。
- 不把 Rug 风险判断作为自动拦截条件；它只进入分析评论，供人工判断。

## 数据源

使用 6551 API，基础地址：

```text
https://ai.6551.io
```

认证方式：

```text
Authorization: Bearer $TWITTER_TOKEN
```

需要新增环境变量：

```env
TWITTER_TOKEN=
TWITTER_API_BASE_URL=https://ai.6551.io
```

`TWITTER_API_BASE_URL` 可选，默认 `https://ai.6551.io`。

## 使用的 6551 接口

### 账号基础信息

```text
POST /open/twitter_user_info
```

请求：

```json
{
  "username": "target_handle"
}
```

用途：

- 读取账号简介、创建时间、粉丝数、认证状态等基础画像。
- 给 Grok 判断这是官方项目账号、团队账号还是伪装账号提供背景。

### 历史删帖

```text
POST /open/twitter_deleted_tweets
```

请求：

```json
{
  "username": "target_handle",
  "maxResults": 20
}
```

用途：

- 检查是否存在大量删帖。
- 提取删帖内容里是否出现过融资、mint、空投、代币、关闭项目、退款、失败项目等敏感信息。
- 如果没有返回数据，只能说明 6551 当前没有证据，不能证明账号没有删帖。

### 近期推文

```text
POST /open/twitter_user_tweets
```

请求：

```json
{
  "username": "target_handle",
  "maxResults": 30,
  "product": "Latest",
  "includeReplies": true,
  "includeRetweets": false
}
```

用途：

- 查看近期项目叙事是否稳定。
- 检查是否有异常转向、频繁换项目、过度营销、删帖前后的矛盾信息。
- 提取用户自己回复里的澄清、争议、退款、迁移等信息。

### 负面评论与提及

```text
POST /open/twitter_search
```

第一组：搜索提及账号的负面关键词。

```json
{
  "keywords": "@target_handle rug OR scam OR drain OR phishing OR hacked OR fraud",
  "maxResults": 20,
  "product": "Latest"
}
```

第二组：中文负面关键词。

```json
{
  "keywords": "@target_handle 跑路 OR 割 OR 骗局 OR 诈骗 OR 钓鱼 OR 黑客 OR 归零",
  "maxResults": 20,
  "product": "Latest"
}
```

第三组：按 mention 查询。

```json
{
  "mentionUser": "target_handle",
  "maxResults": 20,
  "product": "Latest"
}
```

用途：

- 近似获取评论区和社区讨论里的负面反馈。
- 查找用户是否曾经被指控 rug、scam、钓鱼、盗号、恶意合约、无法提现等。
- 由于第一版不解析单条推文完整评论树，这些搜索结果只作为风险证据，不作为确定结论。

## 数据流

```text
alpha WS 消息
-> 共同关注阈值判断
-> Grok 账号分类
   -> KOL / PERSONAL：拦截，结束
   -> PROJECT / ALPHA / UNKNOWN：发送频道主消息
-> triggerAnalysisComment
   -> 如果是重复项目：回复第一次分析评论，不查 6551
   -> 如果是首次项目：
      -> RugHistoryProvider 调用 6551
      -> 汇总 Rug 风险证据
      -> buildGrokPrompt 加入 Rug 历史/风险输入
      -> Grok 输出分析评论
```

这样设计的原因：

- 频道主消息不等待 6551 查询，避免主推送延迟过高。
- Rug 查询只影响讨论群里的分析评论。
- 重复项目不重复查询，避免接口成本和刷屏。

## 模块设计

### `rug-history-provider.ts`

新增模块，负责 6551 查询和结构化摘要。

建议类型：

```ts
export interface RugHistoryEvidence {
  source: '6551';
  available: boolean;
  deletedTweetCount: number | null;
  negativeMentionCount: number | null;
  recentTweetCount: number | null;
  deletedTweetSamples: string[];
  negativeMentionSamples: string[];
  recentRiskSignals: string[];
  warnings: string[];
}
```

职责：

- 从 X 链接里提取 `username`。
- 调用 6551 的账号信息、删帖、近期推文、搜索接口。
- 将不同接口返回归一化为 `RugHistoryEvidence`。
- 控制每类样本最多保留 3 条，避免 prompt 过长。
- 捕获接口失败，将失败原因写入 `warnings`。

### `twitter-6551-client.ts`

可选独立模块，负责底层 HTTP 请求。

职责：

- 注入 `TWITTER_TOKEN`。
- 注入 `TWITTER_API_BASE_URL`。
- 统一发送 `POST /open/...` 请求。
- 统一处理非 2xx、JSON 解析失败、超时。

如果第一版范围要小，也可以先把 HTTP client 放在 `rug-history-provider.ts` 内部，后续再拆。

### `grok.ts`

扩展分析输入：

```ts
export interface GrokAnalysisInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
  rugHistory?: RugHistoryEvidence;
}
```

分析提示词新增一行输出：

```text
7. Rug 历史/风险：基于删帖记录和社区评论判断是否存在跑路、骗局、严重负面历史；没有证据时明确写“暂无直接证据”。
```

Grok 输入里新增结构化 Rug 证据：

```text
Rug 历史数据源：6551
删帖数量：...
负面提及数量：...
删帖样本：...
负面评论样本：...
风险信号：...
数据警告：...
```

### `analysis-service.ts`

在首次分析路径中接入 Rug 历史：

- 如果 `existingAnalysis` 存在：保持现状，只回复重复命中提醒。
- 如果是首次分析：先调用 `getRugHistoryEvidence()`，再构造 Grok prompt。
- 如果 `TWITTER_TOKEN` 缺失：不抛错，返回 `available=false` 和 warning。
- 如果 6551 部分接口失败：保留成功接口数据，并把失败写入 warning。

## 失败处理

6551 查询失败不能影响主链路：

- `TWITTER_TOKEN` 未配置：分析仍然进行，Rug 历史写“未配置数据源”。
- 单个 6551 接口失败：继续使用其它接口数据。
- 所有 6551 接口失败：分析仍然进行，Rug 历史写“数据源查询失败，暂无可用证据”。
- 6551 返回空数据：分析里写“暂无直接证据”，不能写成“确定没有 Rug 历史”。

## 延迟与成本

第一版会让首次分析评论变慢，但不会拖慢频道主消息。

建议限制：

- 每个接口 `maxResults` 控制在 20-30。
- 每类样本最多传给 Grok 3 条。
- 只对首次分析调用 6551。
- 被分类为 `KOL` / `PERSONAL` 的账号不调用 6551。

后续如调用量过高，再增加：

- 账号级短期缓存。
- 星级阈值限制，例如只对 2 星或 3 星以上做 Rug 查询。
- 数据库持久化，服务重启后复用证据。

## 测试范围

新增测试：

- `rug-history-provider` 在 `TWITTER_TOKEN` 缺失时返回 warning，不抛错。
- 6551 删除推文结果能汇总 `deletedTweetCount` 和样本。
- 6551 搜索结果能汇总 `negativeMentionCount` 和样本。
- 单个接口失败时，其它接口结果仍保留。
- `buildGrokPrompt` 在有 Rug 证据时包含 `Rug 历史/风险`。
- `analysis-service` 首次分析会调用 Rug provider。
- `analysis-service` 重复项目不会调用 Rug provider。

现有验证命令：

```bash
npm test
npm run typecheck
```

## 后续可选优化

- 拉取目标账号最热门推文的 quote tweets，用于更接近真实评论区。
- 将 Rug 证据和分析结果持久化，给重复项目直接复用。
- 增加风险评分，例如 `low`、`medium`、`high`。
- 如果 Rug 风险为高，再额外在讨论群回复一条风险提醒。
- 接入更多链上或安全数据源，避免只依赖 X 舆论。
