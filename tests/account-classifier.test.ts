import { describe, expect, it, vi } from 'vitest';
import {
  buildAccountClassificationPrompt,
  classifyAccount,
  parseAccountClassificationResponse,
  shouldAllowClassifiedAccount
} from '../src/account-classifier.js';

describe('account classifier', () => {
  const input = {
    title: '[重点] A 关注了 B',
    content: '用户简介: DeFi protocol for onchain liquidity',
    link: 'https://x.com/project_b',
    count: 8,
    star: 2
  };

  it('builds a prompt that asks for strict JSON classification', () => {
    const prompt = buildAccountClassificationPrompt(input);

    expect(prompt).toContain('只返回 JSON');
    expect(prompt).toContain('PROJECT');
    expect(prompt).toContain('KOL');
    expect(prompt).toContain('MEDIA');
    expect(prompt).toContain('DEV');
    expect(prompt).toContain('Meme Degen');
    expect(prompt).toContain('memer');
    expect(prompt).toContain('speculator');
    expect(prompt).toContain('alpha caller');
    expect(prompt).toContain('alpha calls');
    expect(prompt).toContain('signals');
    expect(prompt).toContain('gem hunter');
    expect(prompt).toContain('100x');
    expect(prompt).toContain('喊单');
    expect(prompt).toContain('带单');
    expect(prompt).toContain('归为 KOL');
    expect(prompt).toContain('Alpha 工具');
    expect(prompt).toContain('数据平台');
    expect(prompt).toContain('不应因为出现 alpha 一词就归为 KOL');
    expect(prompt).toContain('founder');
    expect(prompt).toContain('co-founder');
    expect(prompt).toContain('core team');
    expect(prompt).toContain('team member');
    expect(prompt).toContain('core contributor');
    expect(prompt).toContain('community lead');
    expect(prompt).toContain('核心成员');
    expect(prompt).toContain('归为 PERSONAL');
    expect(prompt).toContain('core developer');
    expect(prompt).toContain('technical contributor');
    expect(prompt).toContain('技术贡献者');
    expect(prompt).toContain('归为 DEV');
    expect(prompt).toContain('不应仅凭这些词归为 PERSONAL 或 DEV');
    expect(prompt).toContain('meme 项目官方账号');
    expect(prompt).toContain('https://x.com/project_b');
  });

  it('parses direct JSON classification responses', () => {
    const result = parseAccountClassificationResponse(
      '{"type":"PROJECT","confidence":0.82,"reason":"官方项目账号"}'
    );

    expect(result).toEqual({
      type: 'PROJECT',
      confidence: 0.82,
      reason: '官方项目账号'
    });
  });

  it('parses JSON wrapped in a markdown code block', () => {
    const result = parseAccountClassificationResponse(
      '```json\n{"type":"KOL","confidence":0.91,"reason":"个人观点账号"}\n```'
    );

    expect(result.type).toBe('KOL');
    expect(result.confidence).toBe(0.91);
  });

  it('parses the first JSON object when Grok appends extra text', () => {
    const result = parseAccountClassificationResponse(
      '{"type":"PERSONAL","confidence":0.88,"reason":"个人构建者账号"}\n\n说明：这是个人账号。'
    );

    expect(result).toEqual({
      type: 'PERSONAL',
      confidence: 0.88,
      reason: '个人构建者账号'
    });
  });

  it('rejects invalid classification responses', () => {
    expect(() => parseAccountClassificationResponse('not json')).toThrow(/无法解析账号分类/);
    expect(() =>
      parseAccountClassificationResponse('{"type":"BOT","confidence":1,"reason":"x"}')
    ).toThrow(/未知账号分类/);
  });

  it('allows project, alpha, and unknown classifications', () => {
    expect(shouldAllowClassifiedAccount({ type: 'PROJECT', confidence: 0.8, reason: 'x' })).toBe(true);
    expect(shouldAllowClassifiedAccount({ type: 'ALPHA', confidence: 0.8, reason: 'x' })).toBe(true);
    expect(shouldAllowClassifiedAccount({ type: 'UNKNOWN', confidence: 0.2, reason: 'x' })).toBe(true);
  });

  it('parses media classification responses', () => {
    const result = parseAccountClassificationResponse(
      '{"type":"MEDIA","confidence":0.86,"reason":"媒体资讯聚合账号"}'
    );

    expect(result).toEqual({
      type: 'MEDIA',
      confidence: 0.86,
      reason: '媒体资讯聚合账号'
    });
  });

  it('parses dev classification responses', () => {
    const result = parseAccountClassificationResponse(
      '{"type":"DEV","confidence":0.9,"reason":"个人开发者账号"}'
    );

    expect(result).toEqual({
      type: 'DEV',
      confidence: 0.9,
      reason: '个人开发者账号'
    });
  });

  it('blocks KOL, personal, media, and dev classifications', () => {
    expect(shouldAllowClassifiedAccount({ type: 'KOL', confidence: 0.9, reason: 'x' })).toBe(false);
    expect(shouldAllowClassifiedAccount({ type: 'PERSONAL', confidence: 0.9, reason: 'x' })).toBe(false);
    expect(shouldAllowClassifiedAccount({ type: 'MEDIA', confidence: 0.9, reason: 'x' })).toBe(false);
    expect(shouldAllowClassifiedAccount({ type: 'DEV', confidence: 0.9, reason: 'x' })).toBe(false);
  });

  it('continues to block alpha caller accounts once classified as KOL', () => {
    expect(shouldAllowClassifiedAccount({
      type: 'KOL',
      confidence: 0.92,
      reason: '个人 alpha caller / signals 喊单账号'
    })).toBe(false);
  });

  it('continues to block team core member accounts once classified as PERSONAL', () => {
    expect(shouldAllowClassifiedAccount({
      type: 'PERSONAL',
      confidence: 0.91,
      reason: '项目 founder / core team 成员个人账号'
    })).toBe(false);
  });

  it('continues to block core technical contributor accounts once classified as DEV', () => {
    expect(shouldAllowClassifiedAccount({
      type: 'DEV',
      confidence: 0.9,
      reason: 'core developer / technical contributor 个人账号'
    })).toBe(false);
  });

  it('classifies an account by calling the injected analyzer', async () => {
    const analyze = vi.fn().mockResolvedValue('{"type":"ALPHA","confidence":0.73,"reason":"早期项目线索"}');

    await expect(classifyAccount({ ...input, xaiModel: 'grok-4.20-fast', analyze })).resolves.toEqual({
      type: 'ALPHA',
      confidence: 0.73,
      reason: '早期项目线索'
    });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toContain('只返回 JSON');
  });
});
