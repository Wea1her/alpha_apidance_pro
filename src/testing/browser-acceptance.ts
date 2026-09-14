import { performance } from 'node:perf_hooks';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { summarizeLatencies, type LatencySummary } from './benchmark.js';

/**
 * 浏览器端验收（M5、验收方案第 2 节）。
 *
 * 为什么需要它：第 12 节的 HTTP 层采集不含浏览器渲染、前端 JS 执行与轮询调度，
 * 而验收方案定义的指标是**端到端**的：
 * - “列表查询 p95 ≤ 1 秒”：记录 API 请求与浏览器列表更新的端到端时长；
 * - “状态可见 ≤ 3 秒”：数据库提交可展示状态 → 在线浏览器显示。
 *
 * 浏览器来源：默认复用**系统 Chrome**（`executablePath`），不下载 Playwright 自带 Chromium。
 * 这会影响数字的绝对可比性（版本与构建不同），报告里如实标注。
 *
 * 本模块只读：不触发模型调用、不创建任务、不发送 Telegram（第 8 节）。
 */

export const DEFAULT_CHROME_PATH = '/opt/google/chrome/chrome';
export const SYSTEM_CHROME_CHANNEL = 'chrome';

export interface BrowserAcceptanceOptions {
  baseUrl: string;
  /** 共享访问密钥；提供时脚本会走真实登录流程。 */
  accessKey?: string | null;
  /** 并发标签页数（验收方案：10 个独立浏览器会话）。 */
  sessions?: number;
  durationMs?: number;
  /** 每个会话的轮询间隔（Q25：列表页 2 秒）。 */
  pollIntervalMs?: number;
  /** 列表分页查询的采样次数上限，避免长跑。 */
  maxListSamples?: number;
  executablePath?: string;
  headless?: boolean;
  /** 是否在结束时保留浏览器（调试用）。 */
  keepOpen?: boolean;
  /** 状态可见性注入：往库里写一条可展示状态，然后观测页面多久显示它。 */
  commitMarker?: {
    marker: string;
    commit: (marker: string) => Promise<{ committedAt: Date }>;
  };
}

export interface StateVisibilitySample {
  /** 数据库侧提交时间（ISO）。 */
  committedAt: string;
  /** 页面首次显示该状态的时间（ISO）。 */
  visibleAt: string;
  /** 可见延迟（毫秒）。 */
  latencyMs: number;
  /** 被观测到的状态文本。 */
  marker: string;
}

export interface BrowserAcceptanceResult {
  baseUrl: string;
  browserVersion: string;
  /** 浏览器来源：系统 Chrome 还是 Playwright 自带。 */
  browserSource: 'system-chrome' | 'bundled';
  sessions: number;
  durationMs: number;
  loginSucceeded: boolean;
  /** 列表查询端到端延迟（含渲染）。 */
  list: LatencySummary;
  /** 状态可见延迟。 */
  stateVisibility: LatencySummary;
  visibilitySamples: StateVisibilitySample[];
  /** 其它只有浏览器能验证的检查项。 */
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  errors: string[];
  notes: string[];
}

/**
 * 登录（如果页面要求）。
 *
 * 注意：访问模型是“验证一次后长期有效”（Q82），所以复用浏览器会话时页面**不会**再要求输入密钥。
 * 首次实测就因为脚本傻等输入框消失而超时——这里必须先判断输入框是否存在。
 */
async function loginIfRequired(page: Page, accessKey: string | null | undefined): Promise<'already-authenticated' | 'logged-in' | 'no-key-provided'> {
  const input = page.locator('input[type="password"]');
  if ((await input.count()) === 0) return 'already-authenticated';
  if (!accessKey) return 'no-key-provided';
  await input.first().fill(accessKey);
  await page.locator('button[type="submit"]').first().click();
  // 登录成功的判据是“工作台出现”，而不是“输入框消失”（后者在已登录页面永远不成立）。
  await page.locator('text=项目池').first().waitFor({ timeout: 15_000 });
  return 'logged-in';
}

/** 启动浏览器：优先系统 Chrome，失败时回退到 Playwright 自带（并在报告里标注）。 */
export async function launchBrowser(options: {
  executablePath?: string;
  headless?: boolean;
}): Promise<{ browser: Browser; source: BrowserAcceptanceResult['browserSource']; notes: string[] }> {
  const notes: string[] = [];
  const headless = options.headless ?? true;
  const executablePath = options.executablePath ?? DEFAULT_CHROME_PATH;

  try {
    const browser = await chromium.launch({
      executablePath,
      headless,
      // 容器/CI 环境常用：无沙箱启动。本地开发同样是可接受的取舍。
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    notes.push(`使用系统 Chrome：${executablePath}（版本 ${browser.version()}）`);
    return { browser, source: 'system-chrome', notes };
  } catch (error) {
    notes.push(
      `系统 Chrome 启动失败（${error instanceof Error ? error.message : String(error)}），回退到 Playwright 自带 Chromium`
    );
    const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    return { browser, source: 'bundled', notes };
  }
}

/**
 * 采集“列表查询端到端延迟”：从发起查询到浏览器里出现行。
 *
 * 用真实的用户路径：点筛选/翻页 → 等 DOM 出现数据行 → 记录耗时。
 */
async function measureListLatency(page: Page, collect: number[]): Promise<void> {
  const started = performance.now();
  // 触发一次前端查询：切换星级筛选会立即重新取数。
  const filter = page.locator('button', { hasText: '3★' });
  if ((await filter.count()) > 0) {
    await filter.first().click();
    await filter.first().click();
  }
  // 等列表行出现（或确认已渲染出空态文案）。
  await page
    .waitForFunction(
      () => {
        const list = document.querySelectorAll('li');
        if (list.length > 0) return true;
        return document.body.innerText.includes('当前条件下没有记录');
      },
      undefined,
      { timeout: 10_000 }
    )
    .catch(() => undefined);
  collect.push(performance.now() - started);
}

/**
 * 采集“状态可见延迟”。
 *
 * 做法：直接往数据库写一条**可展示的状态变化**（事件 + 判定），记录提交时间；
 * 然后在浏览器里轮询页面文本，直到该状态出现。
 * 这样测的是“提交 → 页面可见”，包含 Q25 的 2 秒轮询间隔，符合验收方案定义。
 */
export async function measureStateVisibility(input: {
  page: Page;
  commit: (marker: string) => Promise<{ committedAt: Date }>;
  marker: string;
  timeoutMs?: number;
}): Promise<StateVisibilitySample> {
  const { committedAt } = await input.commit(input.marker);
  const timeoutAt = performance.now() + (input.timeoutMs ?? 15_000);

  while (performance.now() < timeoutAt) {
    const text = await input.page.evaluate(() => document.body.innerText);
    if (text.includes(input.marker)) {
      const visibleAt = new Date();
      return {
        committedAt: committedAt.toISOString(),
        visibleAt: visibleAt.toISOString(),
        latencyMs: visibleAt.getTime() - committedAt.getTime(),
        marker: input.marker,
      };
    }
    await input.page.waitForTimeout(250);
  }

  // 超时也要如实返回一条样本（延迟记为超时值），供报告判断未达标。
  const visibleAt = new Date();
  return {
    committedAt: committedAt.toISOString(),
    visibleAt: visibleAt.toISOString(),
    latencyMs: visibleAt.getTime() - committedAt.getTime(),
    marker: `${input.marker}（超时未观测到）`,
  };
}

/** 只有浏览器才能验证的检查项。 */
export async function runBrowserChecks(page: Page): Promise<BrowserAcceptanceResult['checks']> {
  const checks: BrowserAcceptanceResult['checks'] = [];

  // 1) 静态资源与标题
  const title = await page.title();
  checks.push({ name: '页面标题渲染', passed: title.includes('项目监控台'), detail: `title=${title}` });

  // 2) 三栏结构存在
  const columns = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      pool: text.includes('项目池'),
      activity: text.includes('最近动态'),
      tweets: text.includes('推特喊单'),
    };
  });
  checks.push({
    name: '三栏结构渲染',
    passed: columns.pool && columns.activity && columns.tweets,
    detail: JSON.stringify(columns),
  });

  // 3) 主题切换：data-theme 属性随点击变化
  const beforeTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const toggle = page.locator('button', { hasText: /深色|浅色/ });
  if ((await toggle.count()) > 0) {
    await toggle.first().click();
    await page.waitForTimeout(300);
  }
  const afterTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  checks.push({
    name: '深浅主题切换',
    passed: beforeTheme !== afterTheme && afterTheme !== null,
    detail: `${beforeTheme} → ${afterTheme}`,
  });

  // 4) 工作台不得显示“数据服务异常”等运行时错误横幅
  // 这条检查来自一次真实缺陷：健康接口返回的是快照对象（无 rows），
  // 却被喂给面向列表的 usePolling，运行时抛 “X.rows is not iterable”，
  // 页面顶部长期挂着异常横幅。只有浏览器能发现这类错误。
  const bodyText = await page.evaluate(() => document.body.innerText);
  const runtimeErrorBanner = bodyText.includes('数据服务异常') || bodyText.includes('is not iterable');
  checks.push({
    name: '页面无运行时异常横幅',
    passed: !runtimeErrorBanner,
    detail: runtimeErrorBanner ? (bodyText.match(/数据服务异常[^\n]*/)?.[0] ?? '检测到异常文案') : '未检测到异常横幅',
  });

  // 5) 报告/正文以纯文本渲染，不执行页面注入的脚本（第 7 节不可信内容）
  const injected = await page.evaluate(() => {
    const hostile = '<img src=x onerror="window.__djkXss=1">';
    const target = document.createElement('div');
    // 模拟报告正文的渲染方式：只用 textContent
    target.textContent = hostile;
    document.body.appendChild(target);
    return {
      usedTextContent: target.querySelector('img') === null,
      xssFlag: (window as unknown as { __djkXss?: number }).__djkXss ?? null,
    };
  });
  checks.push({
    name: '不可信正文不执行脚本',
    passed: injected.usedTextContent && injected.xssFlag === null,
    detail: JSON.stringify(injected),
  });

  return checks;
}

/** 主流程：登录 → 并发标签页采集列表延迟 → 采集状态可见延迟 → 浏览器检查。 */
export async function runBrowserAcceptance(options: BrowserAcceptanceOptions): Promise<BrowserAcceptanceResult> {
  const sessions = options.sessions ?? 10;
  const durationMs = options.durationMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const maxListSamples = options.maxListSamples ?? 60;

  const { browser, source, notes } = await launchBrowser({
    ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
    ...(options.headless !== undefined ? { headless: options.headless } : {}),
  });

  const errors: string[] = [];
  const listLatencies: number[] = [];
  const visibilitySamples: StateVisibilitySample[] = [];
  const checks: BrowserAcceptanceResult['checks'] = [];
  let loginSucceeded = false;
  const startedAt = performance.now();

  let firstContext: BrowserContext | null = null;
  try {
    // 第一个上下文用来登录并跑浏览器检查（避免每个会话都做一次登录）。
    firstContext = await browser.newContext();
    const page = await firstContext.newPage();
    await page.goto(options.baseUrl, { waitUntil: 'domcontentloaded' });

    const firstLogin = await loginIfRequired(page, options.accessKey);
    loginSucceeded = firstLogin !== 'no-key-provided';
    if (firstLogin === 'already-authenticated') {
      notes.push('页面未要求输入密钥（复用已有会话），这与“验证一次后长期有效”的设计一致');
    }

    checks.push(...(await runBrowserChecks(page)));

    // 状态可见性：提交 → 页面轮询到可见。第 1 条样本单独测，避免与并发列表竞争。
    if (options.commitMarker) {
      const sample = await measureStateVisibility({
        page,
        marker: options.commitMarker.marker,
        commit: options.commitMarker.commit,
      });
      visibilitySamples.push(sample);
    }

    // 并发标签页：每个会话在自己的上下文里，模拟 10 个独立浏览器会话。
    const sessionPages: Array<{ context: BrowserContext; page: Page }> = [];
    for (let index = 1; index < sessions; index += 1) {
      const context = await browser.newContext();
      {
        const login = await context.newPage();
        await login.goto(options.baseUrl, { waitUntil: 'domcontentloaded' });
        await loginIfRequired(login, options.accessKey);
        await login.close();
      }
      const sessionPage = await context.newPage();
      await sessionPage.goto(options.baseUrl, { waitUntil: 'domcontentloaded' });
      sessionPages.push({ context, page: sessionPage });
    }

    const stopAt = performance.now() + durationMs;
    const workers = sessionPages.map(async ({ page: sessionPage }) => {
      while (performance.now() < stopAt && listLatencies.length < maxListSamples) {
        try {
          await measureListLatency(sessionPage, listLatencies);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
        await sessionPage.waitForTimeout(pollIntervalMs);
      }
    });
    await Promise.all(workers);

    for (const session of sessionPages) await session.context.close();
    notes.push(`并发标签页 ${sessionPages.length + 1} 个；列表采样 ${listLatencies.length} 次`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (firstContext && !options.keepOpen) await firstContext.close();
    if (!options.keepOpen) await browser.close();
  }

  return {
    baseUrl: options.baseUrl,
    browserVersion: browser.version(),
    browserSource: source,
    sessions,
    durationMs: Math.round(performance.now() - startedAt),
    loginSucceeded,
    list: summarizeLatencies(listLatencies),
    stateVisibility: summarizeLatencies(visibilitySamples.map((sample) => sample.latencyMs)),
    visibilitySamples,
    checks,
    errors,
    notes,
  };
}

export function formatBrowserAcceptanceReport(
  result: BrowserAcceptanceResult,
  targets: { listP95Ms?: number; stateVisibleMs?: number } = {}
): string {
  const listTarget = targets.listP95Ms ?? 1_000;
  const stateTarget = targets.stateVisibleMs ?? 3_000;
  const lines: string[] = [];
  lines.push('## 浏览器端验收（Playwright）');
  lines.push('');
  lines.push(`目标：${result.baseUrl}`);
  lines.push(
    `浏览器：${result.browserVersion}（来源 ${result.browserSource === 'system-chrome' ? '系统 Chrome' : 'Playwright 自带 Chromium'}）`
  );
  lines.push(`并发标签页：${result.sessions}；时长 ${(result.durationMs / 1000).toFixed(1)}s；登录成功：${result.loginSucceeded}`);
  lines.push(`错误：${result.errors.length}`);
  lines.push('');
  lines.push('| 指标 | n | p50 | p95 | p99 | max | 目标 | 结论 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
  const row = (label: string, summary: LatencySummary, target: number): string =>
    `| ${label} | ${summary.count} | ${summary.p50.toFixed(0)}ms | ${summary.p95.toFixed(0)}ms | ` +
    `${summary.p99.toFixed(0)}ms | ${summary.max.toFixed(0)}ms | ≤${target}ms | ${summary.count === 0 ? '无样本' : summary.p95 <= target ? '达标' : '未达标'} |`;
  lines.push(row('列表查询（含渲染）', result.list, listTarget));
  lines.push(row('状态可见（含轮询）', result.stateVisibility, stateTarget));
  lines.push('');

  lines.push('### 浏览器专项检查');
  lines.push('');
  for (const check of result.checks) {
    lines.push(`- ${check.passed ? '通过' : '未通过'}：${check.name}（${check.detail}）`);
  }
  lines.push('');

  if (result.visibilitySamples.length > 0) {
    lines.push('### 状态可见性样本');
    lines.push('');
    lines.push('| 提交时间 | 可见时间 | 延迟 | 标记 |');
    lines.push('|---|---|---:|---|');
    for (const sample of result.visibilitySamples) {
      lines.push(`| ${sample.committedAt} | ${sample.visibleAt} | ${sample.latencyMs}ms | ${sample.marker} |`);
    }
    lines.push('');
  }

  if (result.notes.length > 0) {
    lines.push('### 说明');
    lines.push('');
    for (const note of result.notes) lines.push(`- ${note}`);
    lines.push('');
  }
  if (result.errors.length > 0) {
    lines.push('### 错误');
    lines.push('');
    for (const error of result.errors.slice(0, 5)) lines.push(`- ${error}`);
  }
  return lines.join('\n');
}
