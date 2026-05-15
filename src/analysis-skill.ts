import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_ANALYSIS_SKILL = `# 项目/Alpha 账号分析 Skill

## 目标
判断该 X 账号是否值得作为打新、空投、链上热点跟踪目标。

## 分析维度
1. 项目核心信息：概括这个账号/项目的核心定位、产品或叙事。
2. 当前进展：概括目前可见的阶段、动作、热度或生态进展。
3. 优点：从增长、产品、叙事、资源、传播性等角度提炼 1-2 点。
4. 缺点：从真实性、落地性、可持续性、估值泡沫、信息不足等角度提炼 1-2 点。
5. 关注理由：说明为什么值得关注或不值得关注，结论要明确。
6. 标签：给出 2-4 个中文短标签，用顿号分隔。
7. Rug 历史/风险：基于删帖记录和社区评论判断是否存在跑路、骗局、严重负面历史；没有证据时明确写“暂无直接证据”。

## 输出要求
- 严格按分析维度输出 7 行，每一行都必须有内容。
- 不要写前言，不要写总结。
- 全部使用中文。
- 风格专业、克制、信息密度高。
- 每行尽量控制在 30-50 字。
- 不要输出 Source、来源、参考来源、数据来源或引用列表。`;

export interface LoadAnalysisSkillOptions {
  name?: string;
  directory?: string;
}

export async function loadAnalysisSkill(options: LoadAnalysisSkillOptions = {}): Promise<string> {
  const name = options.name ?? 'project-alpha';
  const directory = options.directory ?? join(process.cwd(), 'analysis-skills');

  try {
    const content = await readFile(join(directory, `${name}.md`), 'utf8');
    return content.trim();
  } catch {
    return DEFAULT_ANALYSIS_SKILL;
  }
}
