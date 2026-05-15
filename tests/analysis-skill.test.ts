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
});
