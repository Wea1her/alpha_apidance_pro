# 参照站拆解：alpha.fajiazhifu.cc

用途：前端迁移的**列表层**以该站为参照（用户 2026-09-14 确认 Q90-A）。本文件只记录从公开页面观察到的结构与机制，作为实现时的结构/视觉对齐依据；不代表要复制其数据或商业模型。

观察方式：`curl` 取原始 HTML + headless Chrome（`--dump-dom`）渲染后解析 `/app.js`、`/styles.css`、首页与子页面。观察时间：2026-09-14。

## 1. 技术栈与页面形态

| 项 | 观察结果 |
|---|---|
| 框架 | **无框架**：原生 HTML + CSS + 单个 `/app.js`（51 KB）+ `/styles.css`（35 KB），无 React/Vue 构建产物 |
| 渲染 | 服务端直出 HTML（`vary: Cookie`、`cache-control: no-store`），列表项由 `app.js` 用模板字符串在客户端生成 |
| 子页面 | 首页、`/extension`（X 浏览器插件说明）、`/membership`（订阅）；另有外链 `guiji.fajiazhifu.cc`（代币归集） |
| 字体 | `Inter, ui-sans-serif, system-ui, …`；地址/代码用 `ui-monospace, SFMono-Regular, Menlo, …` |
| 圆角 | 5 / 6 / 7 / 8 / 10 / 11 / 14 px 与 `999px`（胶囊） |
| 主题 | `html[data-theme="dark"]` 切换，CSS 变量在浅色/深色各定义一套 |
| 品牌资产 | `/brand/logo.png`、`/brand/favicon.png` |

## 2. 设计令牌（CSS 变量）

浅色与深色各定义一套同名变量：

| 变量 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#eef2f5` | `#10161b` | 页面底色 |
| `--surface` | `#ffffff` | `#192127` | 卡片面 |
| `--surface-soft` | `#f7f9fb` | `#212a31` | 次级面 |
| `--ink` | `#17202a` | `#e7edf2` | 主文字 |
| `--muted` | `#6d7781` | `#9aa6b0` | 次要文字 |
| `--line` | `#d9e0e7` | `#35414a` | 分隔线/描边 |
| `--accent` | `#0d8f75` | `#48c5a7` | 主强调（榜单） |
| `--accent-soft` | `#e0f4ef` | `#173b34` | 强调底色 |
| `--discover` | `#3973d6` | `#79a9ff` | 「最新发现」列强调 |
| `--discover-soft` | `#eaf1fc` | `#1d304c` | 同上底色 |
| `--gmgn` | `#7358a8` | `#b6a0e7` | 代币列强调 |
| `--gmgn-soft` | `#f0ecf8` | `#302842` | 同上底色 |
| `--grey-card` | `#e7eaed` | `#252d33` | 中性卡片 |

**可借鉴的骨架**：三栏各有自己的强调色 + 软底色，用颜色区分"这是哪一列"，而不是靠标题。

## 3. 首页信息架构

三个并排面板（各自独立滚动、可折叠/可切换为只看某一列）：

1. **热度榜单**（`#alphaList`）——行式紧凑列表，约 50 行。
   - 行内元素：`rank`（`#1`）、`avatar`（失败回退首字母）、`identity`（`identity-name-line`）、`rating`（分级徽章）、`alpha-card-actions`。
   - 分级筛选用**等级词**而非数字：`全部 / 夯 / 顶级 / 人上人 / npc / 拉完了`（对应 `rating-elite` 等类）。
   - 视图页签 `alphaViewTabs`（如"排行榜 / 最近更新"），`count-pill` 显示数量，搜索框 `searchInput` 全局搜索。
   - 每行有「已读」按钮（`read-button`，激活态文案"已读 ✓"），读过整卡加 `is-read` 类并弱化正文。
2. **最新发现**（`#discoveryList`）——卡片流，约 100 张。
   - 卡片元素：`discovery-accent`（左侧色条）、`avatar large`、`kind-badge` + `badges`（分类：`项目 / KOL / Crypto / 待确认`）、`ai-summary`、`original-description`、`metrics-line`、`note-button`、`read-button`。
   - 按类型筛选：`全部 / 项目 / KOL / Crypto / 待确认`；有 `discoveryCount` 计数。
3. **GMGN 新币**（`#gmgnList`）——网格（`repeat(4, minmax(0,1fr))`，`grid-auto-rows: max-content`），可整体折叠（`gmgnCollapseToggle` / `columns.gmgn-collapsed`）。
   - 卡内元素：`gmgn-token-header`、`gmgn-ticker`、`gmgn-token-name`、`gmgn-found-time`、`gmgn-token-tags`、`platform-badge`、`chain-badge`（`chain-bsc` 黄 `#f0b90b`、`chain-robinhood` 荧光绿 `#ccff00`）、`gmgn-address` + 复制按钮与 `gmgn-copy-feedback`、`gmgn-original`、`gmgn-narrative`。
   - 按链筛选：`全部 / BSC / Robinhood`。

顶栏：站点状态点 + 状态文案（`statusDot`/`statusText`）、下次扫描时间（`nextScanText`）、本地时钟（`updateClock` 每秒）、首页/榜单视图切换（`homeViewButton`/`memeViewButton`）、搜索、主题开关、四组音效开关与音效选择（`alphaSoundToggle`、`discoverySoundToggle`、`gmgnSoundToggle`）。

## 4. 数据与刷新机制（对本次迁移最有参考价值）

- 单一聚合接口：`GET /api/member-dashboard?version=<上次版本>`，返回 `{ version, unchanged, sync, isAdmin }` 形态。
- 客户端维护 `state.dashboardVersion`：请求带上次版本；服务端判定未变更时返回 `unchanged`，前端**直接跳过 DOM 同步**；版本不一致则报错重试——等价于"轮询 + 实体版本号去重"（本规划第 12 节 Q14/Q25 已确认的机制）。
- 轮询间隔分离：时钟 1 s；公共 dashboard 有独立常量 `DASHBOARD_REFRESH_MS`；发现与 GMGN 各有兜底刷新常量（`DISCOVERY_FALLBACK_REFRESH_MS`、`GMGN_FALLBACK_REFRESH_MS`）；榜单有按需刷新（`refreshAlphaIfDue`）。
- 管理入口可见性来自服务端标志：`#dashboardAdminLink` 根据 `dashboard.isAdmin !== true` 设置 `hidden`；CSS 用 `#dashboardAdminLink[hidden] { display: none !important; }` 保证隐藏。
- 头像懒加载 + 失败回退：`data-avatar-src` / `data-avatar-fallback`（取名字首字母）。
- 已读状态按条记录（`data-read-alpha` / `data-read-discovery`），并回流到服务端同步。

## 5. 子页面要点

- `/extension`：X 浏览器插件落地页，三步说明（下载解压 / 加载插件 / 打开 X 即可使用），提到后续收费。
- `/membership`：**钱包连接登录**（`connect`/`signedIn`/`wallet`/`expiry`）+ 订阅方案（月卡 30 天、季卡 90 天）+ 限时优惠倒计时（`priceDeadline`）+ 管理员入口链接（`adminLink`）。用户已确认本次迁移**不做订阅**（Q91-A），此页仅作商业模型参考。

## 6. 与本项目数据的映射（实现时的对齐口径）

| 参照站 | 本项目对应 |
|---|---|
| 热度榜单行（rank/avatar/identity/rating） | **项目列表行**：归一化账号、当前星级、最近真实事件时间、报告状态、来源（自然/手动/导入） |
| `rating` 等级筛选（夯/顶级/…） | 按**星级档位**与**项目状态**筛选 |
| `is-read` / 「已读 ✓」 | 可选：报告已读/未读（需用户确认，见第 6 轮开放问题） |
| 最新发现卡片（kind-badge/badges/ai-summary/original-description/metrics-line） | **事件/项目详情卡**：原始输入、判定结论、原因码、分类理由、报告摘要 |
| GMGN 代币卡（ticker/address/chain/copy） | 无直接对应；可作"外部链接 + 一键复制"的交互参考 |
| `version` + `unchanged` 轮询 | 已确认的轮询 + 实体版本号去重（Q14/Q25） |
| `isAdmin` 控制管理入口 | 管理入口需管理员密码后才显示/可用（Q84） |

## 7. 明确不照搬的部分

- 不做订阅、付费墙、钱包连接（Q91-A、Q89-B）。
- 不采用"公开门户"定位：整站仍需共享访问密钥（Q89-B）。
- 榜单的等级词（夯/顶级/人上人/npc/拉完了）属该站的自有分级，本项目沿用既有星级语义与原因码。
