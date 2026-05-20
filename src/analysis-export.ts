import type {
  AnalysisArchiveAnalysisRecord,
  AnalysisArchiveRecord
} from './analysis-archive-store.js';

export interface AnalysisExportRange {
  from: Date;
  to: Date;
  fromLabel: string;
  toLabel: string;
}

interface ProjectExportItem {
  projectKey: string;
  analysis: AnalysisArchiveAnalysisRecord;
  records: AnalysisArchiveRecord[];
  highestStar: number;
  highestCount: number;
  firstPushedAtMs: number;
}

const SHANGHAI_OFFSET_HOURS = 8;
const HOUR_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

export function parseShanghaiHourRange(fromRaw: string, toRaw: string): AnalysisExportRange {
  const fromParts = parseShanghaiHourInput(fromRaw);
  const toParts = parseShanghaiHourInput(toRaw);
  const from = toShanghaiDate(fromParts, false);
  const to = toShanghaiDate(toParts, true);

  if (from.getTime() > to.getTime()) {
    throw new Error('开始时间不能晚于结束时间');
  }

  return {
    from,
    to,
    fromLabel: `${fromRaw.replace('T', ' ')}:00`,
    toLabel: `${toRaw.replace('T', ' ')}:59`
  };
}

export function isExportAuthorized(
  update: { chatId: string; username?: string },
  adminUsernames: readonly string[],
  allowedChatIds: readonly string[]
): boolean {
  if (allowedChatIds.includes(update.chatId)) {
    return true;
  }

  const username = normalizeUsername(update.username);
  if (!username) {
    return false;
  }

  return adminUsernames.some((admin) => normalizeUsername(admin) === username);
}

export function buildAnalysisExport(
  records: readonly AnalysisArchiveRecord[],
  range: AnalysisExportRange,
  now = new Date()
): { projectCount: number; markdown: string } {
  const analysesByProject = firstAnalysesByProject(records);
  const rangedRecordsByProject = new Map<string, AnalysisArchiveRecord[]>();

  for (const record of records) {
    if (!analysesByProject.has(record.projectKey)) {
      continue;
    }
    const pushedAt = new Date(record.mainPushedAt).getTime();
    if (pushedAt < range.from.getTime() || pushedAt > range.to.getTime()) {
      continue;
    }
    const projectRecords = rangedRecordsByProject.get(record.projectKey) ?? [];
    projectRecords.push(record);
    rangedRecordsByProject.set(record.projectKey, projectRecords);
  }

  const projects = [...rangedRecordsByProject.entries()]
    .map(([projectKey, projectRecords]): ProjectExportItem => {
      const analysis = analysesByProject.get(projectKey);
      if (!analysis) {
        throw new Error(`missing analysis for project ${projectKey}`);
      }
      return {
        projectKey,
        analysis,
        records: [...projectRecords].sort(compareRecordsByMainPushedAt),
        highestStar: Math.max(...projectRecords.map((record) => record.star)),
        highestCount: Math.max(...projectRecords.map((record) => record.count)),
        firstPushedAtMs: Math.min(...projectRecords.map((record) => new Date(record.mainPushedAt).getTime()))
      };
    })
    .sort(compareProjects);

  const lines = [
    '# Alpha 项目分析导出',
    '',
    `时间范围：${range.fromLabel} ~ ${range.toLabel}（Asia/Shanghai）`,
    `导出时间：${formatShanghaiMinute(now)}`,
    `项目数：${projects.length}`,
    ''
  ];

  if (projects.length === 0) {
    lines.push('该时间段没有已完成 Grok 分析的项目。');
    return { projectCount: 0, markdown: `${lines.join('\n')}\n` };
  }

  const stars = [...new Set(projects.map((project) => project.highestStar))].sort((a, b) => b - a);
  for (const star of stars) {
    const group = projects.filter((project) => project.highestStar === star);
    lines.push(`## ${star} 星项目（${group.length} 个）`, '');

    group.forEach((project, index) => {
      const channelUrl = messageUrl(project.analysis.channelMessage);
      const discussionUrl = messageUrl(project.analysis.discussionAnalysisMessage);
      lines.push(`### ${index + 1}. ${project.analysis.title || project.projectKey}`);
      lines.push(`- 链接：${project.analysis.link}`);
      lines.push(`- 最高星级：${project.highestStar} 星`);
      lines.push(`- 最高监控池关注数：${project.highestCount}`);
      lines.push(`- 首次主推送时间：${formatShanghaiMinute(new Date(project.firstPushedAtMs))}`);
      if (channelUrl) {
        lines.push(`- 主频道消息：${channelUrl}`);
      }
      if (discussionUrl) {
        lines.push(`- 讨论群分析消息：${discussionUrl}`);
      }
      lines.push('', '#### Grok 分析全文', '', project.analysis.analysisText, '', '#### 时间段内命中记录', '');
      for (const record of project.records) {
        lines.push(`- ${formatShanghaiMinute(record.mainPushedAt)}，${record.star} 星，监控池关注数 ${record.count}`);
      }
      lines.push('');
    });
  }

  return { projectCount: projects.length, markdown: `${lines.join('\n').trimEnd()}\n` };
}

export function buildAnalysisExportFilename(range: AnalysisExportRange): string {
  const fromHour = range.fromLabel.replace(' ', 'T').slice(0, 13);
  const toHour = range.toLabel.replace(' ', 'T').slice(0, 13);
  return `alpha-analysis-${fromHour}-${toHour}.md`;
}

function firstAnalysesByProject(records: readonly AnalysisArchiveRecord[]): Map<string, AnalysisArchiveAnalysisRecord> {
  const analysesByProject = new Map<string, AnalysisArchiveAnalysisRecord>();

  for (const record of records) {
    if (record.recordType !== 'analysis') {
      continue;
    }
    const existing = analysesByProject.get(record.projectKey);
    if (!existing || compareRecordsByMainPushedAt(record, existing) < 0) {
      analysesByProject.set(record.projectKey, record);
    }
  }

  return analysesByProject;
}

function parseShanghaiHourInput(raw: string): { year: number; month: number; day: number; hour: number } {
  const match = raw.match(HOUR_INPUT_PATTERN);
  if (!match) {
    throw new Error('时间格式必须是 YYYY-MM-DDTHH');
  }

  const [, yearRaw, monthRaw, dayRaw, hourRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (month < 1 || month > 12 || day < 1 || day > lastDay || hour < 0 || hour > 23) {
    throw new Error('时间格式必须是 YYYY-MM-DDTHH');
  }

  return { year, month, day, hour };
}

function toShanghaiDate(
  parts: { year: number; month: number; day: number; hour: number },
  endHour: boolean
): Date {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour - SHANGHAI_OFFSET_HOURS,
      endHour ? 59 : 0,
      endHour ? 59 : 0,
      endHour ? 999 : 0
    )
  );
}

function normalizeUsername(username: string | undefined): string | null {
  const normalized = username?.trim().replace(/^@/, '').toLowerCase();
  return normalized ? normalized : null;
}

function compareRecordsByMainPushedAt(a: AnalysisArchiveRecord, b: AnalysisArchiveRecord): number {
  const byTime = new Date(a.mainPushedAt).getTime() - new Date(b.mainPushedAt).getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return a.sourceTaskKey.localeCompare(b.sourceTaskKey);
}

function compareProjects(a: ProjectExportItem, b: ProjectExportItem): number {
  return (
    b.highestStar - a.highestStar ||
    b.highestCount - a.highestCount ||
    a.firstPushedAtMs - b.firstPushedAtMs ||
    a.projectKey.localeCompare(b.projectKey) ||
    a.analysis.title.localeCompare(b.analysis.title)
  );
}

function formatShanghaiMinute(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const shanghaiMs = date.getTime() + SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000;
  const shanghaiDate = new Date(shanghaiMs);
  const year = shanghaiDate.getUTCFullYear();
  const month = String(shanghaiDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shanghaiDate.getUTCDate()).padStart(2, '0');
  const hour = String(shanghaiDate.getUTCHours()).padStart(2, '0');
  const minute = String(shanghaiDate.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function messageUrl(ref: { chatId: string | number; messageId: number }): string | null {
  const chatId = String(ref.chatId);
  if (!chatId.startsWith('-100')) {
    return null;
  }
  return `https://t.me/c/${chatId.slice(4)}/${ref.messageId}`;
}
