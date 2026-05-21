# Alpha Caller 账号筛出设计

## 背景

当前服务在主频道推送前会调用 Grok 做账号分类。现有分类结果包括：

- `PROJECT`：项目、协议、产品、应用、平台、官方账号。
- `ALPHA`：早期机会、链上热点、打新线索，信息不完整但更像项目或产品。
- `KOL`：个人影响力账号、交易员、研究员、博主、资讯号主、Meme Degen、memer、speculator 等个人投机/喊单身份账号。
- `PERSONAL`：普通个人账号、创始人个人号、团队成员个人号。
- `DEV`：个人开发者、工程师、独立开发者等。
- `MEDIA`：媒体、新闻、资讯聚合、快讯、行情播报等。
- `UNKNOWN`：信息不足，无法明确判断。

当前放行 `PROJECT`、`ALPHA`、`UNKNOWN`，拦截 `KOL`、`PERSONAL`、`DEV`、`MEDIA`。

新需求是把 **个人 Alpha caller / 喊单 / 带单账号** 也筛出去。后续补充范围是把 **团队核心成员个人号** 和 **核心技术贡献者个人号** 也明确筛出去。这里的目标不是拦截 Alpha 工具、Alpha 项目、协议官方号或数据平台，而是拦截以个人身份输出 calls、signals、100x、gem hunting、degen calls，或以 founder、co-founder、CEO、CTO、core team、team member、core contributor、BD、community lead、core developer、engineer 等个人身份出现的账号。

## 目标

把个人 Alpha caller 相关账号归类为 `KOL`，沿用现有 KOL 拦截逻辑：

```text
个人 alpha caller / calls / signal / gem hunter / degen calls / 100x 账号
-> Grok 分类为 KOL
-> shouldAllowClassifiedAccount 返回 false
-> 不发送主频道，不写 Grok 分析
```

把团队核心成员个人号归类为 `PERSONAL`，把核心开发者、工程师、技术贡献者等个人技术身份账号归类为 `DEV`：

```text
founder / co-founder / CEO / CTO / core team / team member / BD / community lead 等个人账号
-> Grok 分类为 PERSONAL
-> shouldAllowClassifiedAccount 返回 false

core developer / engineer / builder / technical contributor / 开发者 / 工程师 / 技术贡献者等个人账号
-> Grok 分类为 DEV
-> shouldAllowClassifiedAccount 返回 false
```

## 非目标

- 不新增 `CALLER` 分类类型。
- 不改 `shouldAllowClassifiedAccount()` 的允许/拦截规则。
- 不做本地关键词硬拦截。
- 不拦截 Alpha 项目、Alpha 工具、研究平台、数据产品、社区产品等官方或产品型账号。
- 不拦截项目、协议、产品、平台、官方社区或生态官方号；即使它们描述 team、core、dev，也不能仅凭这些词误归为 `PERSONAL` 或 `DEV`。
- 不改变分类失败时的保守推送策略。

## 决策

采用提示词增强方案，不新增类型。

在 `account-classifier.ts` 的分类说明和判断原则里明确：

- `alpha caller`
- `alpha calls`
- `calls`
- `signals`
- `gem hunter`
- `degen calls`
- `100x`
- `moonshot calls`
- 喊单
- 带单
- 土狗推荐

如果这些词描述的是个人、频道主、博主、交易员、KOL 或投机喊单身份，应归为 `KOL`。

团队核心成员和核心技术贡献者的个人号继续沿用现有 `PERSONAL` / `DEV` 拦截链路，但提示词要更明确：

- `founder`
- `co-founder`
- `CEO`
- `CTO`
- `core team`
- `team member`
- `core contributor`
- `BD`
- `community lead`
- 核心成员
- 团队成员
- 创始人
- 联创
- 负责人

如果这些词描述的是个人身份账号，应归为 `PERSONAL`。

- `core developer`
- `developer`
- `engineer`
- `builder`
- `technical contributor`
- 开发者
- 工程师
- 技术贡献者

如果这些词描述的是个人技术贡献者账号，应归为 `DEV`。

同时保留边界说明：

如果账号是 Alpha 工具、Alpha 数据平台、项目发现产品、研究平台、协议、官方社区或产品账号，即使文案包含 alpha，也不应因为出现 `alpha` 一词就归为 `KOL`；这类账号仍可归为 `PROJECT` 或 `ALPHA`。

如果账号是项目、协议、产品、平台、官方社区、生态官方号或团队官方号，即使简介里出现 team、core、dev、developer、builder 等词，也不应仅凭这些词归为 `PERSONAL` 或 `DEV`；这类账号仍可归为 `PROJECT` 或 `ALPHA`。

## 数据流

```text
Alpha WS 推送
-> 解析共同关注数和星级
-> buildAccountClassificationPrompt()
-> Grok 返回分类 JSON
-> parseAccountClassificationResponse()
-> shouldAllowClassifiedAccount()
   -> PROJECT / ALPHA / UNKNOWN：继续主推送和分析
   -> KOL / PERSONAL / DEV / MEDIA：拦截
```

本次只增强 `buildAccountClassificationPrompt()`，不改变后续流程。

## 测试要求

需要覆盖：

- 分类提示词包含 `alpha caller`、`alpha calls`、`signals`、`gem hunter`、`100x` 等 Alpha caller 关键词。
- 分类提示词明确个人 Alpha caller / calls / signals / gem hunter / 100x 类账号归为 `KOL`。
- 分类提示词包含 `founder`、`co-founder`、`core team`、`team member`、`core contributor`、`BD`、`community lead`、核心成员、团队成员等团队核心成员关键词。
- 分类提示词明确团队核心成员个人号归为 `PERSONAL`。
- 分类提示词包含 `core developer`、`engineer`、`technical contributor`、开发者、工程师、技术贡献者等个人技术贡献者关键词。
- 分类提示词明确个人核心开发者/技术贡献者账号归为 `DEV`。
- 分类提示词明确 Alpha 工具、数据平台、项目发现产品、研究平台不因 `alpha` 一词被误归为 `KOL`。
- 分类提示词明确项目/协议/产品/平台/官方社区/团队官方号不因 `team`、`core`、`dev` 等词被误归为 `PERSONAL` 或 `DEV`。
- 现有 `shouldAllowClassifiedAccount()` 测试继续验证 `KOL` 被拦截。
- 现有 `shouldAllowClassifiedAccount()` 测试继续验证 `PERSONAL` 和 `DEV` 被拦截。

## 验收标准

- Grok 分类 prompt 明确要求个人 Alpha caller/喊单/带单账号归为 `KOL`。
- Grok 分类 prompt 明确要求团队核心成员个人号归为 `PERSONAL`。
- Grok 分类 prompt 明确要求核心开发者/技术贡献者个人号归为 `DEV`。
- Alpha 工具/平台/项目类账号仍有机会归为 `PROJECT` 或 `ALPHA`。
- 项目/协议/产品/平台/官方社区/团队官方号不因 team/core/dev 等词被误杀。
- 不新增分类类型。
- 不改变服务主流程。
- 测试通过。
