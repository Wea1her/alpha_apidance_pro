# CA/合约相关删帖风险提示设计

## 背景

当前服务已经在首次 Grok 分析前调用 6551 查询 Rug 历史证据。现有 `rug-history-provider.ts` 会调用：

```text
POST /open/twitter_deleted_tweets
```

并从最多 100 条历史删帖里筛选 CA/合约相关原文。现有匹配范围包括：

- `CA`
- `contract` / `contract address`
- `token address`
- `合约` / `合约地址` / `代币地址`
- `0x...` EVM 地址
- 类 Solana/Base58 地址

筛出的原文会进入 `contractDeletedTweetSamples`，随后进入 Grok prompt 的“合约相关删帖原文”。问题是：如果只把原文塞进 prompt，Grok 可能写得不够明确，导致“发现过 CA/合约相关删帖”这个信号没有被稳定表达出来。

## 目标

当 6551 查到被推送账号存在 CA/合约相关删帖时，Grok 分析必须明确写出：

```text
发现 CA/合约相关删帖
```

这条提示只影响 Grok 分析文本，不影响主频道推送速度，也不额外发送讨论群提醒。

## 非目标

- 不改变主频道推送流程。
- 不让主频道推送等待 6551 查询。
- 不额外在讨论群发送单独风险提醒。
- 不把 CA/合约相关删帖直接作为自动拦截条件。
- 不仅凭 CA/合约相关删帖强制判定跑路或强制给出“暂不参与”。
- 不新增 6551 接口；继续复用现有 `twitter_deleted_tweets` 查询。
- 不扩大到普通历史推文里的 CA 搜索；本次只强化“删帖里的 CA/合约相关内容”。

## 决策

采用结构化 prompt 增强方案。

当 `contractDeletedTweetSamples.length > 0` 时，`buildGrokPrompt` 在 Rug 历史输入里增加显式状态和写作要求：

```text
CA/合约相关删帖：发现
要求：第 7 节必须明确写“发现 CA/合约相关删帖”，并引用合约相关删帖原文；但不得仅凭这一点直接判定跑路，需结合删帖数量、负面提及、评论区样本和其他证据判断。
```

当没有样本时，保持中性：

```text
CA/合约相关删帖：未发现
```

这样做的原因：

- 现有数据模型已经有 `contractDeletedTweetSamples`，不需要新增字段。
- prompt 明确状态比只改分析 Skill 更稳定。
- 结论保持中性，符合“发现 CA 删帖是风险信号，但不能单点定罪”的要求。

## 数据流

```text
Alpha 推送
-> 通过账号分类和星级判断
-> 主频道推送成功
-> 进入 Grok 分析补偿任务
-> 6551 查询历史删帖
-> 本地筛选 CA/合约相关删帖原文
-> buildGrokPrompt 注入 CA/合约相关删帖状态
-> Grok 第 7 节明确写出风险信号
-> 分析评论写入讨论群
```

主频道推送仍然不等待 6551 查询。6551 查询失败时，Grok 分析继续执行，风险部分按“数据缺口，不能判安全”表达。

## 输出要求

如果存在 `contractDeletedTweetSamples`：

- `Rug 历史/风险` 第 7 节必须包含“发现 CA/合约相关删帖”。
- 第 7 节必须引用最多 3 条合约相关删帖原文。
- Grok 可以把它作为风险信号，但不能只凭这一点写成“确定跑路”。
- `关注理由` 可以结合该信号做谨慎判断，但是否“小仓试错 / 重点跟踪 / 暂不参与”仍由综合证据决定。

如果不存在 `contractDeletedTweetSamples`：

- 不写“发现 CA/合约相关删帖”。
- 只能写“未发现相关删帖证据”或“暂无直接证据”，不能写成“确定没有风险”。

## 涉及模块

### `rug-history-provider.ts`

保持现有 6551 查询和本地筛选逻辑：

- `twitter_deleted_tweets` 最多查询 100 条。
- `contractDeletedTweetTexts()` 继续负责筛选 CA/合约相关删帖。
- `contractDeletedTweetSamples` 继续最多保留 3 条。

本次不要求新增字段。

### `grok.ts`

增强 `formatRugHistory()`：

- 根据 `contractDeletedTweetSamples.length` 输出 CA/合约相关删帖状态。
- 有样本时加入强制写作要求。
- 保留现有“合约相关删帖原文”列表。

### `analysis-skill.ts`

可以轻微同步文案，使 Skill 与结构化 prompt 一致：

- 如果存在合约相关删帖原文，第 7 节必须明确写“发现 CA/合约相关删帖”。
- 结论不得只凭这一点直接判定跑路。

这属于辅助约束，核心约束仍放在 `grok.ts` 的结构化 prompt 中。

## 错误处理

- `TWITTER_TOKEN` 未配置：沿用现有 warning，Grok 分析继续。
- `twitter_deleted_tweets` 失败：保留现有 warning，CA/合约相关删帖状态不写成“未发现”，而应跟随“数据缺口，不能判安全”的语义。
- 6551 返回空数组：可以写“未发现 CA/合约相关删帖证据”，但不能写“确定没有删帖风险”。

## 测试计划

需要覆盖：

- 有 `contractDeletedTweetSamples` 时，`buildGrokPrompt()` 包含 `CA/合约相关删帖：发现`。
- 有 `contractDeletedTweetSamples` 时，prompt 包含“第 7 节必须明确写‘发现 CA/合约相关删帖’”的要求。
- 有 `contractDeletedTweetSamples` 时，prompt 仍包含原文列表。
- 没有 `contractDeletedTweetSamples` 时，prompt 包含 `CA/合约相关删帖：未发现`，且不包含“发现 CA/合约相关删帖”的强制要求。
- 现有 `rug-history-provider` 测试继续验证 CA/合约相关删帖筛选规则。

## 验收标准

- 当 6551 返回 `CA: 0x...` 这类删帖原文时，Grok prompt 明确标记“CA/合约相关删帖：发现”。
- Grok 分析的第 7 节被明确要求写出“发现 CA/合约相关删帖”。
- 主频道推送行为不变。
- 讨论群不新增单独风险提醒。
- 没有 CA/合约相关删帖样本时，不产生误报。
