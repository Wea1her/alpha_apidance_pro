import type { ReportDocument } from './report-schema.js';

function list(items: readonly string[]): string { return items.length ? items.map((item) => `- ${item}`).join('\n') : '- 暂无'; }

export function renderReportMarkdown(report: ReportDocument, generatedAt = new Date()): string {
  return [
    `# ${report.coreInfo.projectName}｜AI 调研报告`,
    '',
    `> 生成时间：${generatedAt.toISOString()}`,
    '',
    '## 一、项目核心信息',
    '',
    `- 项目：${report.coreInfo.projectName}`,
    `- X 账号：${report.coreInfo.handle}`,
    `- 当前阶段：${report.coreInfo.stage}`,
    '',
    report.coreInfo.summary,
    '',
    '## 二、项目背景/背书账号',
    '',
    report.coreInfo.background || '当前无法确认知名 Crypto 背书账号或机构背景。',
    '',
    '## 三、当前进展',
    '',
    report.focusReason.currentProgress,
    '',
    '## 四、优点',
    '',
    list(report.focusReason.strengths),
    '',
    '## 五、缺点',
    '',
    list(report.focusReason.weaknesses),
    '',
    '## 六、关注理由',
    '',
    report.focusReason.reason,
    '',
    '## 七、标签',
    '',
    report.tags.map((tag) => '`' + tag + '`').join(' · '),
    '',
    ''
  ].join('\n');
}
