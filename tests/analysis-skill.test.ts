import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadAnalysisSkill, DEFAULT_ANALYSIS_SKILL } from '../src/analysis-skill.js';

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
    expect(DEFAULT_ANALYSIS_SKILL).toContain('类似项目结局');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('删帖频率');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('发现 CA/合约相关删帖');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不能只凭这一点直接判定跑路');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目背景/背书账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目背景/背书账号证据');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('最多列 10 个账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不得编造未出现在候选池中的账号');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('项目方、交易所、VC、基金、生态官方');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('主要是 KOL 关注，不等同于项目方/VC/生态背书');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('8. Rug 历史/风险');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('第 8 节明确写“发现 CA/合约相关删帖”');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('`1. 项目核心信息`、`2. 项目背景/背书账号`、`3. 当前进展`、`4. 优点`、`5. 缺点`、`6. 关注理由`、`7. 标签`、`8. Rug 历史/风险`');
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

    const runtimeSkill = await readFile(join(process.cwd(), 'analysis-skills/project-alpha.md'), 'utf8');
    expect(runtimeSkill).toContain('严格按分析维度输出 8 个章节');
    expect(runtimeSkill).toContain('项目背景/背书账号证据');
    expect(runtimeSkill).toContain('不得编造未出现在候选池中的账号');
    expect(runtimeSkill).toContain('项目方、交易所、VC、基金、生态官方');
    expect(runtimeSkill).toContain('主要是 KOL 关注，不等同于项目方/VC/生态背书');
    expect(runtimeSkill).toContain('8. Rug 历史/风险');
    expect(runtimeSkill).toContain('第 8 节明确写“发现 CA/合约相关删帖”');
    expect(runtimeSkill).toContain('`1. 项目核心信息`、`2. 项目背景/背书账号`、`3. 当前进展`、`4. 优点`、`5. 缺点`、`6. 关注理由`、`7. 标签`、`8. Rug 历史/风险`');
    expect(runtimeSkill).not.toContain('其他账号');
    expect(runtimeSkill).not.toContain('其他的优先级');
  });
});
