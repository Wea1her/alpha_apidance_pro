# Grok 项目背景背书账号设计

## 背景

当前 Grok 分析已经包含项目核心信息、当前进展、关注理由和 Rug 历史/风险。分析原则里要求优先关注知名项目方、蓝 V、KOL、交易所、基金、生态官方等背书，但现有 prompt 没有稳定的数据输入，只能依赖原始推送内容和模型自身判断。

新需求是在 Grok 分析中新增一个专门的“项目背景/背书账号”章节：查询被推送 X 账号是否被知名 Crypto 官方账号、项目方、交易所、VC、基金、生态官方、蓝 V 或 KOL 关注，并列举出来。

## 目标

- 使用 6551 `twitter_kol_followers` 查询目标账号的知名关注者。
- 在 Grok 分析中新增独立章节 `2. 项目背景/背书账号`，整体输出从 7 节调整为 8 节。
- 6551 返回的候选账号最多保留 30 个注入 prompt。
- Grok 从候选池中按优先级筛选最多 10 个账号输出。
- 输出优先展示项目方、交易所、VC、基金、生态官方，其次才是知名 KOL、媒体、社区号或其他账号。
- 查询失败或没有结果时仍保留该章节，并明确说明数据状态。

## 非目标

- 不让 Grok 自己联网查询 follower graph。
- 不新增人工白名单或长期维护的官方账号列表。
- 不把该功能混进 Rug 历史查询模型。
- 不阻塞主频道推送；查询失败只影响项目背景章节的信息完整度。
- 不改变账号分类拦截逻辑。

## 输出结构

Grok 分析章节调整为：

1. 项目核心信息
2. 项目背景/背书账号
3. 当前进展
4. 优点
5. 缺点
6. 关注理由
7. 标签
8. Rug 历史/风险

`2. 项目背景/背书账号` 必须说明：

- 6551 是否成功查询。
- 是否查询到知名 Crypto 背书账号。
- 查询到时列出最多 10 个账号。
- 每个账号尽量包含用户名、显示名、类别和简短背书含义。
- 不允许编造不在候选池里的账号。

建议输出示例：

```text
2. 项目背景/背书账号
6551 查询到若干知名关注者，优先级较高的是项目方/VC/生态账号：@xxx（项目方）、@yyy（VC/基金）、@zzz（生态官方）。这些关注说明该账号已经进入部分 Crypto 资源圈层，但仍需要结合产品进展和互动热度判断。
```

空结果示例：

```text
2. 项目背景/背书账号
6551 未查询到知名 Crypto 背书账号，当前缺少项目方、交易所、VC、基金或生态官方的明确关注信号，不能把背书作为主要关注理由。
```

失败示例：

```text
2. 项目背景/背书账号
6551 背书账号查询失败或未配置，当前无法确认是否有知名 Crypto 官方账号、项目方、VC 或生态官方关注，不能据此推断存在背书。
```

## 数据采集设计

新增 `project-backing-provider`，职责只包括采集和规整项目背书关注者证据。

输入：

- `link`：被推送账号链接。
- `twitterToken`：沿用 `TWITTER_TOKEN`。
- `twitterApiBaseUrl`：沿用 `TWITTER_API_BASE_URL`。
- `proxyUrl`：沿用现有代理配置。
- `client`：测试注入用的 6551 client。

流程：

```text
triggerAnalysisComment
-> collectProjectBackingEvidence
   -> extractUsernameFromXLink
   -> twitter_kol_followers({ username })
   -> 解析候选关注者
   -> 最多保留 30 个候选
-> buildGrokPrompt 注入项目背景证据
-> Grok 输出 8 节分析
```

数据结构建议：

```ts
export interface ProjectBackingEvidence {
  source: '6551';
  available: boolean;
  candidateCount: number | null;
  candidates: ProjectBackingCandidate[];
  warnings: string[];
}

export interface ProjectBackingCandidate {
  username: string;
  displayName?: string;
  description?: string;
  followersCount?: number;
  verified?: boolean;
  rawCategory?: string;
}
```

解析规则需要兼容 6551 返回结构差异：

- 支持顶层数组。
- 支持 `{ data: [] }`、`{ result: [] }`、`{ users: [] }`。
- 支持常见字段：`username`、`screenName`、`userName`、`name`、`displayName`、`description`、`bio`、`followersCount`、`verified`、`isBlueVerified`。
- 只要无法解析出 username，就跳过该条候选。

## 候选池和排序规则

代码层不直接做最终分类，只把最多 30 个候选账号传给 Grok。Grok 负责从候选池中选择最多 10 个输出。

Grok 筛选优先级固定为：

1. 项目方 / 协议官方 / 产品官方
2. 交易所官方
3. VC / 基金 / Ventures / Capital
4. 生态官方 / 公链 / Foundation / Labs
5. 知名 Crypto KOL
6. 媒体 / 社区号
7. 其他

输出规则：

- 前 4 类优先展示。
- 如果前 4 类不足 10 个，再用知名 KOL、媒体或其他账号补齐。
- 如果候选里只有普通 KOL，也可以列出，但必须说明“主要是 KOL 关注，不等同于项目方/VC/生态背书”。
- 如果候选池为空，不能写“有背书”。

## Prompt 注入设计

`buildGrokPrompt` 新增 `projectBacking?: ProjectBackingEvidence`。

在 Rug 历史之前注入项目背景证据，例如：

```text
项目背景/背书账号证据：
6551 背书账号状态：查询成功
候选账号数量：12
筛选要求：只能从以下候选账号中选最多 10 个，优先级为项目方/协议官方/产品官方、交易所官方、VC/基金、生态官方/公链/Foundation/Labs、知名 Crypto KOL、媒体/社区号、其他。不得编造候选池外账号。
候选账号：
  - @abc | ABC Foundation | verified=true | followers=123456 | bio=...
```

失败时注入：

```text
项目背景/背书账号证据：
6551 背书账号状态：未查询或查询失败
要求：第 2 节必须说明当前无法确认知名 Crypto 背书账号，不能据此推断存在背书。
数据警告：
  - 未配置 TWITTER_TOKEN，跳过 6551 项目背书查询
```

空结果时注入：

```text
项目背景/背书账号证据：
6551 背书账号状态：查询成功但未发现
要求：第 2 节必须说明未查询到知名 Crypto 背书账号，不能把背书作为主要关注理由。
```

## 分析 Skill 调整

`analysis-skills/project-alpha.md` 和内置 `DEFAULT_ANALYSIS_SKILL` 同步改为 8 节。

新增第 2 节要求：

- 标题固定为 `2. 项目背景/背书账号`。
- 必须优先使用 `项目背景/背书账号证据`。
- 必须优先列项目方、交易所、VC、基金、生态官方。
- 最多列 10 个账号。
- 不允许编造未出现在候选池中的账号。
- 查询失败或空结果时必须明示，不得模糊写成“有背书”。

原第 2 到第 7 节顺延为第 3 到第 8 节。Rug 历史/风险变为第 8 节，原有 CA/合约相关删帖要求保持不变。

## 错误处理

- 未配置 `TWITTER_TOKEN`：返回 `available=false`，warnings 写明原因，Grok 仍继续分析。
- 无法从链接提取 username：返回 `available=false`，warnings 写明原因。
- 6551 请求失败：保留 warnings，Grok 仍继续分析。
- 6551 返回空数组：返回 `available=true`、`candidateCount=0`、`candidates=[]`。
- 单条候选字段缺失：跳过无法解析 username 的候选，不中断整体查询。

## 配置

不新增环境变量。复用：

- `TWITTER_TOKEN`
- `TWITTER_API_BASE_URL`
- `PROXY_URL`

如果后续发现 prompt 太长，可以再增加候选池上限配置；第一版固定 30 个候选。

## 测试计划

Provider 测试：

- 未配置 token 时返回 warning evidence。
- 无法从 X 链接提取 username 时返回 warning evidence。
- 成功调用 `twitter_kol_followers` 并解析候选账号。
- 候选账号超过 30 个时只保留 30 个。
- 6551 endpoint 失败时返回 `available=false` 和 warning。
- 跳过无法解析 username 的候选。

Grok prompt 测试：

- 有项目背书证据时 prompt 包含候选账号、筛选优先级、最多 10 个输出要求。
- 空结果时 prompt 包含“查询成功但未发现”。
- 查询失败时 prompt 包含“未查询或查询失败”。
- prompt 不包含 `source` 或 `数据源` 字样。

Analysis skill 测试：

- 默认 skill 和 Markdown skill 都包含 8 个固定章节标题。
- 第 2 节包含项目背景/背书账号要求。
- 第 8 节仍保留 Rug 历史/风险和 CA/合约相关删帖约束。

Analysis service 测试：

- 首次分析会同时采集 Rug 历史证据和项目背书证据。
- `buildGrokPrompt` 收到项目背书证据。
- 已存在分析的重复命中提醒不重复调用项目背书查询。

## 验收标准

- Grok 分析稳定输出 8 节，其中第 2 节为 `项目背景/背书账号`。
- 查询成功且有候选时，第 2 节最多列 10 个账号，并优先项目方、交易所、VC、基金、生态官方。
- 查询为空时，第 2 节明确写未查询到知名 Crypto 背书账号。
- 查询失败时，第 2 节明确写查询失败或未配置，不能推断存在背书。
- 没有 `TWITTER_TOKEN` 时主推送和 Grok 分析不中断。
- 现有 Rug 历史/风险、CA/合约相关删帖逻辑不回退。
