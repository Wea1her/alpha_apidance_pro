import { describe, expect, it } from 'vitest';
import { ReportDocumentSchema, buildResearchReportPrompt, renderReportMarkdown, REPORT_STYLE_TEMPLATE } from '../src/index.js';

const report = { coreInfo: { projectName: 'Northstar', handle: '@northstar', summary: '基础设施项目。', stage: '测试网' }, focusReason: { currentProgress: '已发布测试网。', strengths: ['团队持续交付'], weaknesses: ['代币经济尚未公布'], reason: '值得继续观察。' }, tags: ['DePIN'] };

describe('research report document', () => {
  it('builds the fixed six-section template prompt', () => {
    const prompt = buildResearchReportPrompt({ project: { name: 'Northstar', handle: '@northstar' }, signals: ['Alpha 共同关注 12'], evidence: ['00000000-0000-4000-8000-000000000001'] });
    expect(prompt.user).toContain('产品机制与用户参与方式');
    expect(prompt.user).not.toContain('请完成 L2 六赛道深挖');
    expect(prompt.user).toContain('不要进行 L2 六赛道深挖');
    expect(prompt.user).toContain('项目名 (@账号) 定位为');
    expect(prompt.user).toContain('商业模式或收入分配');
    expect(prompt.user).toContain('完整连贯的中文分析');
    expect(prompt.user).toContain('首句必须明确写“值得小仓试错”“持续观察”或“暂不纳入”');
    expect(prompt.user).toContain('白名单、NFT mint 或首发 meme');
    expect(prompt.user).toContain(REPORT_STYLE_TEMPLATE);
    expect(prompt.user).not.toContain('已完成事项、未完成事项');
    expect(prompt.user).not.toContain('项目背景');
    expect(prompt.system).toContain('ReportDocumentSchema');
    expect(prompt.system).toContain('顶层只能包含 coreInfo、focusReason、tags 三个键');
    expect(prompt.system).not.toContain('thesis');
    expect(prompt.system).not.toContain('l2Tracks');
    expect(prompt.system).toContain('coreInfo.summary 必须采用');
    expect(prompt.system).toContain('focusReason.reason 必须是交易决策式完整段落');
    expect(prompt.system).toContain(REPORT_STYLE_TEMPLATE);
    expect(prompt.system).toContain('不要进行 L2 六赛道深挖');
    expect(prompt.system).toContain('不要生成独立的项目背景章节');
  });
  it('accepts only the six-section V2 contract and renders a readable Chinese document', () => {
    const parsed = ReportDocumentSchema.parse(report);
    const markdown = renderReportMarkdown(parsed, new Date('2026-08-26T00:00:00Z'));
    expect(markdown).toContain('# Northstar｜AI 调研报告');
    expect(markdown).toContain('## 二、当前进展');
    expect(markdown).toContain('## 五、关注理由');
    expect(markdown).not.toContain('项目背景');
    expect(markdown).not.toContain('## 八、核心论点');
    expect(markdown).not.toContain('## 九、参与玩法');
    expect(markdown).not.toContain('## 十、L2 六赛道深挖');
    expect(markdown).not.toContain('## 十一、独立复核轮：证伪检查');
    expect(markdown).not.toContain('## 十二、评分总览');
    expect(markdown).not.toContain('## 十三、风险与证据链');
    expect(markdown).not.toContain('总分：60.0 / 100');
    expect(markdown).not.toContain('"coreInfo"');
  });

  it('rejects removed V1 analysis fields instead of retaining hidden output', () => {
    expect(() => ReportDocumentSchema.parse({ ...report, thesis: ['旧版字段'] })).toThrow();
  });
});
