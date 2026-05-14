# 6551 Rug 评论区深挖设计

## 背景

当前 Rug 历史分析已经接入 6551 数据源，首次项目分析时会查询：

- `twitter_user_info`：账号基础信息。
- `twitter_deleted_tweets`：历史删帖。
- `twitter_user_tweets`：近期推文。
- `twitter_search`：负面关键词和提及搜索。

这能覆盖“账号被用户提及并带有负面关键词”的舆论线索，但还不等同于查看目标账号帖子下面的评论区。新需求是进一步分析目标账号近期帖子的评论/引用讨论，辅助判断项目是否有跑路、骗局、钓鱼、无法提现、退款争议等历史风险。

## 6551 能力边界

当前本地 6551 文档里没有“按 tweet id 拉完整 replies 树”的接口。可用的近似能力是：

- `twitter_user_tweets`：获取目标账号近期推文。
- `twitter_quote_tweets_by_id`：获取某条推文的引用推文。
- `twitter_search`：通过 `toUser`、`mentionUser`、`keywords` 搜索相关讨论。

因此第一版评论区深挖不是完整 replies 抓取，而是：

- 对近期推文拉 quote tweets，查看引用评论里的负面反馈。
- 用 `twitter_search` 对目标账号做回复/提及/关键词补充搜索。
- 将这些证据汇总为“评论区负面样本”，进入 Grok 的 `Rug 历史/风险` 判断。

## 目标

在现有 Rug 历史分析基础上新增评论区深挖：

- 从目标账号近期推文中提取最多 3 条 tweet id。
- 对每条 tweet id 调用 `twitter_quote_tweets_by_id`。
- 从 quote tweets 中提取负面评论样本。
- 使用 `twitter_search` 增加 `toUser` 和负面关键词组合，近似获取回复区负面讨论。
- 在 `RugHistoryEvidence` 中新增评论区相关字段。
- Grok prompt 中展示评论区负面样本和数量。
- 单条推文查询失败不阻塞其它推文，不阻塞主分析。

## 非目标

- 不实现完整 replies 树抓取，因为当前 6551 文档没有对应接口。
- 不因为评论区负面样本自动拦截项目推送。
- 不对 `KOL` / `PERSONAL` 拦截账号做评论区深挖。
- 不对重复项目重新查询评论区。
- 不做数据库缓存；后续如调用量过高再增加缓存。

## 数据流

```text
PROJECT / ALPHA / UNKNOWN 通过分类
-> 发送频道主消息
-> 首次分析触发 RugHistoryProvider
   -> twitter_user_tweets 获取近期推文
   -> 提取最多 3 个 tweet id
   -> 对每条 tweet 调 twitter_quote_tweets_by_id
   -> twitter_search 用 toUser + 负面关键词补充 replies 近似搜索
   -> 汇总 quote/reply 负面样本
-> buildGrokPrompt 加入评论区深挖证据
-> Grok 输出 Rug 历史/风险
```

## 6551 调用设计

### 近期推文

沿用当前请求：

```json
{
  "username": "target_handle",
  "maxResults": 30,
  "product": "Latest",
  "includeReplies": true,
  "includeRetweets": false
}
```

从返回 item 中提取 tweet id。兼容字段：

- `id`
- `idStr`
- `twId`
- `tweetId`
- `rest_id`

最多选前 3 条有 id 的推文。

### 引用评论

对每条 tweet id 调用：

```text
POST /open/twitter_quote_tweets_by_id
```

请求：

```json
{
  "id": "tweet_id",
  "maxResults": 20
}
```

从返回 quote tweets 中提取文本，筛选负面关键词。

### 回复/评论近似搜索

新增一组 `twitter_search`：

```json
{
  "toUser": "target_handle",
  "keywords": "rug OR scam OR drain OR phishing OR hacked OR fraud",
  "maxResults": 20,
  "product": "Latest"
}
```

中文关键词：

```json
{
  "toUser": "target_handle",
  "keywords": "跑路 OR 割 OR 骗局 OR 诈骗 OR 钓鱼 OR 黑客 OR 归零 OR 无法提现",
  "maxResults": 20,
  "product": "Latest"
}
```

这不能保证只来自某一条推文的评论区，但能补充“直接回复该账号”的负面讨论。

## 数据结构调整

扩展 `RugHistoryEvidence`：

```ts
export interface RugHistoryEvidence {
  source: '6551';
  available: boolean;
  deletedTweetCount: number | null;
  negativeMentionCount: number | null;
  recentTweetCount: number | null;
  commentNegativeCount: number | null;
  checkedTweetCount: number | null;
  deletedTweetSamples: string[];
  negativeMentionSamples: string[];
  commentNegativeSamples: string[];
  recentRiskSignals: string[];
  warnings: string[];
}
```

字段含义：

- `checkedTweetCount`：实际用于 quote 查询的推文数量。
- `commentNegativeCount`：quote tweets 与 `toUser` 搜索里去重后的负面评论数量。
- `commentNegativeSamples`：最多 3 条评论区负面样本。

## 负面关键词

第一版使用固定关键词：

```text
rug
scam
drain
phishing
hacked
fraud
跑路
割
骗局
诈骗
钓鱼
黑客
归零
无法提现
退款
```

筛选逻辑只用于降低 prompt 噪音，不作为确定结论。Grok 仍需要根据样本判断风险强弱。

## 失败处理

- `twitter_quote_tweets_by_id` 单条失败：写入 warning，继续查其它 tweet。
- 没有 tweet id：`checkedTweetCount=0`，warning 写“近期推文缺少可查询 tweet id”。
- quote tweets 为空：`commentNegativeCount` 可以为 0。
- `toUser` 搜索失败：写入 warning，保留 quote 结果。
- 所有评论区查询失败：Rug 分析仍继续，评论区样本显示暂无可用证据。

## 延迟和调用量

每个首次项目分析新增调用量：

- 最多 3 次 `twitter_quote_tweets_by_id`
- 2 次 `twitter_search` 的 `toUser` 负面关键词补充

加上现有 Rug 历史查询，首次分析会更慢，但频道主消息仍然不等待 Rug 查询完成。第一版先保持这个范围；如果后续发现 6551 限流或延迟高，再考虑：

- 降到只检查最近 1 条推文。
- 只对 2 星或 3 星以上启用评论区深挖。
- 增加账号级缓存。

## 测试范围

新增或调整测试：

- 能从近期推文 item 中提取 tweet id。
- 最多只对 3 条推文调用 `twitter_quote_tweets_by_id`。
- quote tweets 中的负面评论会进入 `commentNegativeSamples`。
- `toUser` 搜索结果会合并进评论区负面样本。
- 单条 quote 查询失败时只写 warning，不阻塞其它证据。
- `buildGrokPrompt` 包含 `评论区负面数量` 和 `评论区负面样本`。

验证命令保持：

```bash
npm test
npm run typecheck
```
