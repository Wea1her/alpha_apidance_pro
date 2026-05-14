# 账号分类过滤与全星级分析设计

## 背景

当前服务从 alpha WebSocket 接收关注事件，解析 `你关注的 N 个用户也关注了ta`，按 `5,8,12,15,20` 映射为 1-5 星。事件达到推送阈值后会先发送频道主消息；当星级大于等于 3 时，再调用 Grok 生成分析并评论到关联讨论群。重复项目命中时，服务不会再次分析，而是回复第一次分析评论做提醒。

新需求是从 1 星开始做 Grok 账号分类过滤。项目、协议、产品、Alpha 线索可以推送并分析；KOL、个人号、普通个人账号不进入频道，也不产生首次分析或后续重复提醒。

## 目标

所有达到推送阈值的事件都先经过账号分类：

- `count < 5`：保持现状，不推送。
- `count >= 5`：得到 1-5 星后，先调用 Grok 分类。
- 分类为项目、协议、产品、Alpha 线索：发送频道主消息，并写 Grok 分析评论。
- 分类为 KOL 或个人账号：完全拦截，不发频道、不写分析、不做重复提醒。
- 分类失败、超时、JSON 解析失败或模型返回不确定：保守推送，并继续写分析。

第一版不做人工复核队列。人工复核可以作为后续优化，用于替代分类失败时的保守推送。

## 非目标

- 不改变 alpha WebSocket 登录、重连、heartbeat 逻辑。
- 不改变共同关注数解析和星级阈值。
- 不新增数据库持久化；分类结果和分析记录仍使用当前进程内状态。
- 不合并分类和详细分析为一次 Grok 调用。
- 不对 KOL/个人账号发送任何频道消息或讨论群消息。

## 分类类型

新增账号分类结果类型：

- `PROJECT`：项目、协议、产品、应用、平台、官方账号。
- `ALPHA`：早期机会、链上热点、打新线索，信息不完整但更像项目或产品。
- `KOL`：个人影响力账号、交易员、研究员、博主、资讯号主。
- `PERSONAL`：普通个人账号、创始人个人号、团队成员个人号。
- `UNKNOWN`：信息不足，无法明确判断。

推送判定：

- 允许推送：`PROJECT`、`ALPHA`、`UNKNOWN`。
- 拦截推送：`KOL`、`PERSONAL`。
- 调用异常或解析异常：允许推送，并记录日志。

## 数据流

```text
alpha WS 消息
-> parseAlphaMessage
-> heartbeat 直接跳过
-> extractCommonFollowCount
-> count < 5 直接跳过
-> buildCommonFollowDecision 得到星级
-> 事件去重
-> Grok 分类
   -> PROJECT / ALPHA / UNKNOWN：继续
   -> KOL / PERSONAL：拦截并记录日志
   -> 分类失败：继续
-> sendTelegramMessage 发送频道主消息
-> triggerAnalysisComment 写讨论群评论
   -> 首次项目：生成 6 行专业分析
   -> 重复项目：回复第一次分析评论，提醒重复命中
```

这会把频道主消息发送动作从“星级判断之后”移动到“分类判断之后”。因此分类会影响频道是否出现这条消息。

## 模块设计

### `account-classifier.ts`

新增模块，负责账号分类：

- `buildAccountClassificationPrompt(input)`：构造短提示词。
- `parseAccountClassificationResponse(text)`：解析模型返回。
- `classifyAccount(options)`：调用 Grok 并返回规范化结果。
- `shouldAllowClassifiedAccount(result)`：把分类结果转换成是否允许推送。

建议返回结构：

```ts
interface AccountClassification {
  type: 'PROJECT' | 'ALPHA' | 'KOL' | 'PERSONAL' | 'UNKNOWN';
  confidence: number;
  reason: string;
}
```

提示词要求 Grok 只返回 JSON，例如：

```json
{
  "type": "PROJECT",
  "confidence": 0.82,
  "reason": "简介和链接更像协议或产品账号，不是个人观点账号"
}
```

解析时需要兼容模型把 JSON 包在代码块里的情况。若缺少 `type`、`confidence` 非数字、`type` 不在枚举内，则视为解析失败。

### `service.ts`

调整 `processAlphaMessage()` 的流程：

- 保持 heartbeat、共同关注数、星级、事件去重逻辑。
- 在 `send()` 前新增可注入的分类步骤。
- 分类为 `KOL` 或 `PERSONAL` 时直接返回。
- 分类允许或分类失败时才调用 `send()`。
- 所有允许推送的星级都触发分析评论，不再只限 `>= 3 星`。

建议将当前 `analyze` 回调拆成更准确的职责：

- `classify`：发送频道前调用，决定是否允许推送。
- `afterSend`：发送频道后调用，负责首次分析或重复提醒。

这样测试可以分别验证“是否发送频道”和“发送后是否写评论”。

### `grok.ts`

保留现有 6 行投研分析提示词，不承担分类职责。

当前 `shouldTriggerGrokAnalysis(star >= 3)` 不再适合新规则。实现时可以移除该判断，或改名为更明确的配置判断。第一版规则是：只要分类允许且事件已经推送，就进行分析评论。

### `analysis-service.ts`

保持现有语义：

- 没有既有分析记录时，调用 Grok 生成 6 行分析，回复到频道消息对应讨论线程。
- 已有分析记录时，不再调用 Grok，直接回复第一次分析评论做重复命中提醒。

分类拦截发生在调用 `analysis-service.ts` 之前，所以该模块不需要理解 KOL/个人账号。

## 失败处理

分类相关失败都不能阻塞潜在项目机会：

- Grok 请求失败：记录 `账号分类失败，按保守策略推送`，继续推送并分析。
- 响应不是 JSON：记录原始片段，继续推送并分析。
- 返回 `UNKNOWN`：记录分类原因，继续推送并分析。
- 返回 `KOL` 或 `PERSONAL`：记录拦截原因，不推送。

详细分析失败沿用当前行为：如果主消息已经发出但分析失败，只记录错误，不撤回频道消息。

## 日志

建议新增关键日志：

- `账号分类允许：type=PROJECT confidence=0.82 reason=...`
- `账号分类拦截：type=KOL confidence=0.91 reason=...`
- `账号分类失败，按保守策略推送：...`

日志不打印 API key、钱包私钥、Telegram token。

## 测试范围

新增或调整单元测试：

- 解析标准 JSON 分类结果。
- 解析代码块包裹的 JSON 分类结果。
- 无效 JSON 视为解析失败。
- `PROJECT`、`ALPHA`、`UNKNOWN` 允许推送。
- `KOL`、`PERSONAL` 拦截推送。
- 1 星项目账号：分类允许，发送频道并触发分析。
- 1 星 KOL：不发送频道，不触发分析。
- 分类失败：发送频道并触发分析。
- 重复项目：分类允许后发送频道，回复第一次分析评论，不重复调用详细分析。

现有验证命令保持：

```bash
npm test
npm run typecheck
```

## 后续可选优化

- 将分类结果和分析记录持久化到数据库，服务重启后仍能识别重复项目。
- 对同一账号分类结果设置短期缓存，减少 Grok 调用。
- 当分类失败时改为发送到人工复核队列，而不是保守推送。
- 如果调用成本过高，再考虑把分类和详细分析合并为一次 Grok 调用。
