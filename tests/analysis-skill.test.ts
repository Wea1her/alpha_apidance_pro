import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadAnalysisSkill, DEFAULT_ANALYSIS_SKILL, loadDeepAnalysisSkill, DEFAULT_DEEP_ANALYSIS_SKILL } from '../src/analysis-skill.js';

describe('loadAnalysisSkill', () => {
  it('loads a skill by name from a custom directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analysis-skill-'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'custom.md'), '# 自定义分析 Skill\n\n只输出测试维度。', 'utf8');

    await expect(loadAnalysisSkill({ name: 'custom', directory: dir })).resolves.toContain('只输出测试维度');
  });

  it('falls back to the default skill when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analysis-skill-'));

    await expect(loadAnalysisSkill({ name: 'missing', directory: dir })).resolves.toBe(DEFAULT_ANALYSIS_SKILL);
  });

  it('keeps the default skill aligned with the asymmetric trading analysis rules', async () => {
    expect(DEFAULT_ANALYSIS_SKILL).toContain('低成本试错');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('高赔率机会');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('小资金试错');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('知名项目方');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('蓝 V');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('KOL');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('浏览量、评论量、转发量');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('follower 基数、follower 增长、互动率只作为辅助');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('follower 增长');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('互动率');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('链上关联');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目背景/背书账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('背书账号必须基于检索');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('x_search');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('web_search');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('最多列 10 个账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不得编造');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('未检索到知名 Crypto 背书账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目方、交易所、VC、基金、生态官方');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('主要是 KOL 关注，不等同于项目方/VC/生态背书');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('严格按分析维度输出 7 个章节');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('`1. 项目核心信息`、`2. 项目背景/背书账号`、`3. 当前进展`、`4. 优点`、`5. 缺点`、`6. 关注理由`、`7. 标签`');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('8. Rug 历史/风险');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('Rug');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('删帖');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('6551');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('候选池');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('项目背景/背书账号证据');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('其他账号');
    expect(DEFAULT_ANALYSIS_SKILL).not.toContain('其他的优先级');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('值得小资金试错/重点跟踪/暂不参与');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('小仓试错');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('重点跟踪');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('暂不参与');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('接近 100 字');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不要使用 Markdown 加粗');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不要输出 * 号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('章节标题单独一行');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('正文必须另起下一行');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不要输出 Source、来源、参考来源、数据来源或引用列表');

    const runtimeSkill = await readFile(join(process.cwd(), 'analysis-skills/project-alpha.md'), 'utf8');
    expect(runtimeSkill.trim()).toBe(DEFAULT_ANALYSIS_SKILL);
  });
});

describe('loadDeepAnalysisSkill', () => {
  it('uses a separate default when the deep skill file is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deep-skill-'));
    await expect(loadDeepAnalysisSkill({ directory })).resolves.toBe(DEFAULT_DEEP_ANALYSIS_SKILL);
    expect(DEFAULT_DEEP_ANALYSIS_SKILL).toContain('6 个章节');
    expect(DEFAULT_DEEP_ANALYSIS_SKILL).toContain('未经检索确认');
  });

  it('loads project-deep.md without changing the standard skill', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'deep-skill-'));
    await writeFile(join(directory, 'project-deep.md'), '\n# 自定义深度模板\n');
    await expect(loadDeepAnalysisSkill({ directory })).resolves.toBe('# 自定义深度模板');
    await expect(loadAnalysisSkill({ directory })).resolves.toBe(DEFAULT_ANALYSIS_SKILL);
  });
});
