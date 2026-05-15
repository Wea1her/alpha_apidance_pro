import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

  it('keeps the default skill aligned with the asymmetric trading analysis rules', () => {
    expect(DEFAULT_ANALYSIS_SKILL).toContain('低成本试错');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('高赔率机会');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('follower 增长');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('互动率');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('链上关联');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('类似项目结局');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('删帖频率');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('值得/不值得');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('建议仓位/操作');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('小仓观察');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('重仓打新');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('Pass');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('接近 100 字');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不要使用 Markdown 加粗');
    expect(DEFAULT_ANALYSIS_SKILL).toContain('不要输出 * 号');
  });
});
