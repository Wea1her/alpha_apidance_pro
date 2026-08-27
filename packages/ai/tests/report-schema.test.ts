import { describe, expect, it } from 'vitest';
import { ReportDocumentSchema, buildResearchReportPrompt, renderReportMarkdown, validateEvidenceReferences } from '../src/index.js';

const evidenceId = '00000000-0000-4000-8000-000000000001';
const trackKeys = ['product', 'technology', 'team', 'market', 'tokenomics', 'catalysts'] as const;
const report = { coreInfo: { projectName: 'Northstar', handle: '@northstar', summary: '基础设施项目。', stage: '测试网' }, focusReason: { currentProgress: '已发布测试网。', strengths: ['团队持续交付'], weaknesses: ['代币经济尚未公布'], reason: '值得继续观察。' }, tags: ['DePIN'], thesis: ['真实使用量是核心验证点'], playbook: ['关注测试网任务'], l2Tracks: trackKeys.map((key) => ({ key, title: key, score: 6, summary: '阶段性判断。', findings: ['需要继续验证。'], evidence: [{ evidenceId, claim: 'Alpha 已收到相关信号。', sourceUrl: 'https://example.com' }] })), independentReview: { status: 'challenged', hypotheses: ['项目将持续交付产品。'], falsificationChecks: ['检查后续版本与公开进展是否兑现。'], counterEvidence: ['暂无充分反证。'], conclusion: '暂未证伪，但证据强度有限。', evidence: [{ evidenceId, claim: '当前仅有 Alpha 信号证据。', sourceUrl: 'https://example.com' }] }, score: { overall: 60, confidence: 0.55, verdict: '持续观察', dimensions: trackKeys.map((key) => ({ key, score: 6, rationale: '证据有限。' })) }, risksEvidence: [{ risk: '代币经济不明', evidence: [{ evidenceId, claim: '官方尚未公布代币模型', sourceUrl: 'https://example.com' }] }] };

describe('research report document', () => {
  it('builds an L2 six-track and falsification prompt', () => {
    const prompt = buildResearchReportPrompt({ project: { name: 'Northstar', handle: '@northstar' }, signals: ['Alpha 共同关注 12'], evidence: [evidenceId] });
    expect(prompt.user).toContain('产品与需求');
    expect(prompt.user).toContain('独立复核轮');
    expect(prompt.user).toContain('至少 2-4 个完整句子');
    expect(prompt.user).toContain('不要单独输出或猜测背书账号');
    expect(prompt.system).toContain('ReportDocumentSchema');
    expect(prompt.system).toContain('JSON 键名必须严格使用 Schema 定义的英文键名');
  });
  it('validates evidence ids and renders a readable Chinese document', () => {
    const parsed = ReportDocumentSchema.parse(report);
    expect(() => validateEvidenceReferences(parsed, new Set([evidenceId]))).not.toThrow();
    const markdown = renderReportMarkdown(parsed, new Date('2026-08-26T00:00:00Z'));
    expect(markdown).toContain('# Northstar｜AI 调研报告');
    expect(markdown).toContain('## 二、项目背景');
    expect(markdown).toContain('## 六、关注理由');
    expect(markdown).not.toContain('## 八、核心论点');
    expect(markdown).not.toContain('## 九、参与玩法');
    expect(markdown).not.toContain('## 十、L2 六赛道深挖');
    expect(markdown).not.toContain('## 十一、独立复核轮：证伪检查');
    expect(markdown).not.toContain('## 十二、评分总览');
    expect(markdown).not.toContain('## 十三、风险与证据链');
    expect(markdown).not.toContain('总分：60.0 / 100');
    expect(markdown).not.toContain('"coreInfo"');
  });
  it('rejects a report that cites an unavailable evidence id', () => {
    const parsed = ReportDocumentSchema.parse(report);
    expect(() => validateEvidenceReferences(parsed, new Set())).toThrow('missing evidence');
  });
});
