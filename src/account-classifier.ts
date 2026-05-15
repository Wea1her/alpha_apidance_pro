import { requestGrokAnalysis } from './xai-client.js';

export type AccountClassificationType = 'PROJECT' | 'ALPHA' | 'KOL' | 'PERSONAL' | 'MEDIA' | 'UNKNOWN';

export interface AccountClassificationInput {
  title: string;
  content: string;
  link: string;
  count: number;
  star: number;
}

export interface AccountClassification {
  type: AccountClassificationType;
  confidence: number;
  reason: string;
}

export interface ClassifyAccountOptions extends AccountClassificationInput {
  xaiApiKey?: string;
  xaiBaseUrl?: string;
  xaiModel: string;
  proxyUrl?: string;
  analyze?: (prompt: string) => Promise<string>;
}

const CLASSIFICATION_TYPES = new Set<AccountClassificationType>([
  'PROJECT',
  'ALPHA',
  'KOL',
  'PERSONAL',
  'MEDIA',
  'UNKNOWN'
]);

export function buildAccountClassificationPrompt(input: AccountClassificationInput): string {
  return [
    '请判断这个 X 账号是否应该作为打新/链上热点项目进入推送频道。',
    '',
    '只返回 JSON，不要写 Markdown，不要写额外解释。JSON 格式必须是：',
    '{"type":"PROJECT","confidence":0.82,"reason":"一句中文理由"}',
    '',
    'type 只能是以下之一：',
    '- PROJECT：项目、协议、产品、应用、平台、官方账号',
    '- ALPHA：早期机会、链上热点、打新线索，信息不完整但更像项目或产品',
    '- KOL：个人影响力账号、交易员、研究员、博主、资讯号主',
    '- PERSONAL：普通个人账号、创始人个人号、团队成员个人号',
    '- MEDIA：媒体、新闻、资讯聚合、快讯、行情播报、内容搬运或媒体属性账号',
    '- UNKNOWN：信息不足，无法明确判断',
    '',
    '已知信息：',
    `- 事件：${input.title}`,
    `- 链接：${input.link}`,
    `- 监控池关注数：${input.count}`,
    `- 重要程度：${input.star} 星`,
    `- 原始内容：${input.content}`,
    '',
    '判断原则：',
    '- 项目、协议、产品、应用、平台、官方账号优先归为 PROJECT',
    '- 早期但明显像项目或机会线索的账号归为 ALPHA',
    '- 个人观点、交易观点、研究分享、博主身份明显的账号归为 KOL',
    '- 创始人或团队成员个人号归为 PERSONAL',
    '- 媒体、新闻、快讯、资讯聚合、内容搬运、行情播报属性明显的账号归为 MEDIA',
    '- 信息不足时归为 UNKNOWN'
  ].join('\n');
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf('{');
  if (start === -1) return trimmed;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed;
}

export function parseAccountClassificationResponse(text: string): AccountClassification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch (error) {
    throw new Error(`无法解析账号分类 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('账号分类结果不是对象');
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.type !== 'string' || !CLASSIFICATION_TYPES.has(value.type as AccountClassificationType)) {
    throw new Error(`未知账号分类：${String(value.type)}`);
  }
  if (typeof value.confidence !== 'number' || Number.isNaN(value.confidence)) {
    throw new Error('账号分类 confidence 缺失或不是数字');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    throw new Error('账号分类 reason 缺失');
  }

  return {
    type: value.type as AccountClassificationType,
    confidence: Math.max(0, Math.min(1, value.confidence)),
    reason: value.reason.trim()
  };
}

export function shouldAllowClassifiedAccount(result: AccountClassification): boolean {
  return result.type === 'PROJECT' || result.type === 'ALPHA' || result.type === 'UNKNOWN';
}

export async function classifyAccount(options: ClassifyAccountOptions): Promise<AccountClassification> {
  const prompt = buildAccountClassificationPrompt(options);
  if (!options.analyze && !options.xaiApiKey) {
    throw new Error('未配置 XAI_API_KEY，无法进行账号分类');
  }

  const response = options.analyze
    ? await options.analyze(prompt)
    : await requestGrokAnalysis({
        apiKey: options.xaiApiKey!,
        baseUrl: options.xaiBaseUrl,
        model: options.xaiModel,
        proxyUrl: options.proxyUrl,
        prompt
      });

  return parseAccountClassificationResponse(response);
}
