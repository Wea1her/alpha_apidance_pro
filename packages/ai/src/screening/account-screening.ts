import { AiProviderRouter } from '../provider-router.js';
import { ScreeningOutputSchema, type AccountType, type ScreeningOutput } from './schema.js';

export interface ScreeningInput {
  xUserId: string;
  handle: string;
  displayName?: string;
  bio?: string;
  sourceText?: string;
  followerCount?: number;
  verified?: boolean;
  profileUrl?: string;
}
export type ScreeningDecision = 'allowed' | 'blocked' | 'failed' | 'pending_review';
export interface ScreeningResult { decision: ScreeningDecision; accountType: AccountType | 'UNKNOWN'; reason: string; providerName?: string; model?: string; attempts: number; }

const BLOCKED_TYPES = new Set<AccountType>(['KOL', 'PERSONAL', 'DEV', 'MEDIA', 'NFT', 'TRADFI']);

function hasChinese(value: string): boolean { return /[\u3400-\u9fff]/u.test(value); }

function chineseReason(accountType: AccountType, reason: string): string {
  if (hasChinese(reason) && reason.trim().length >= 8) return reason.trim();
  const fallback: Record<AccountType, string> = {
    PROJECT: 'AI 判断该账号具有项目官方主体特征。',
    ALPHA: 'AI 判断该账号属于上游 Alpha 数据账号。',
    UNKNOWN: 'AI 暂未确认账号属性，先保留观察。',
    KOL: 'AI 判断该账号主要承担意见领袖传播职能，不是项目官方账号。',
    PERSONAL: 'AI 判断该账号属于个人账号，缺少项目官方主体特征。',
    DEV: 'AI 判断该账号主要是个人开发者账号，缺少独立项目主体特征。',
    MEDIA: 'AI 判断该账号具有媒体或资讯传播属性，不属于项目官方账号。',
    NFT: 'AI 判断该账号主要是 NFT、PFP、收藏品或数字藏品项目，不纳入短期打新项目池。',
    TRADFI: 'AI 判断该账号属于传统金融、股票、证券或新股申购相关主体，不属于短期加密投机/创业项目。'
  };
  return fallback[accountType];
}

function normalizeAccountType(value: unknown): AccountType {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (['PROJECT', '项目', '项目账号', '项目方', '项目官方'].includes(normalized)) return 'PROJECT';
  if (['ALPHA', '数据源', '上游'].includes(normalized)) return 'ALPHA';
  if (['KOL', '大V', '意见领袖', '观点账号'].includes(normalized)) return 'KOL';
  if (['PERSONAL', '个人', '个人账号', '个人用户'].includes(normalized)) return 'PERSONAL';
  if (['DEV', '开发者', '个人开发者', 'DEVELOPER', 'BUILDЕR'].includes(normalized)) return 'DEV';
  if (['MEDIA', '媒体', '媒体账号', '资讯媒体'].includes(normalized)) return 'MEDIA';
  if (['NFT', 'NFT项目', 'NFT账号', 'PFP', '头像项目', '收藏品', '数字藏品', 'NFT_COLLECTION'].includes(normalized)) return 'NFT';
  return 'UNKNOWN';
}

function inferAccountTypeFromReason(reason: string): AccountType {
  if (/(?:KOL|大V|意见领袖|影响力账号|观点账号)/i.test(reason)) return 'KOL';
  if (/(?:媒体|资讯|新闻|内容传播账号)/i.test(reason)) return 'MEDIA';
  if (/(?:个人开发者|开发者账号|dev 账号|dev账号)/i.test(reason)) return 'DEV';
  if (/(?:个人账号|普通个人|个人用户)/i.test(reason)) return 'PERSONAL';
  if (/(?:NFT|PFP|数字藏品|收藏品|头像项目|collectible)/i.test(reason)) return 'NFT';
  if (/(?:传统金融|股票|证券|新股|IPO|经纪商|股票研究|证券研究|equities|stock broker|brokerage)/i.test(reason)
      && !/(?:加密|区块链|代币|链上|crypto|web3|token|defi|airdrop|testnet|mainnet)/i.test(reason)) return 'TRADFI';
  return 'UNKNOWN';
}

function hasCryptoScope(value: string): boolean {
  return /(?:加密|区块链|代币|链上|crypto|web3|token|defi|airdrop|testnet|mainnet|solana|ethereum|base|meme coin)/i.test(value);
}

function hasTraditionalFinanceScope(value: string): boolean {
  return /(?:传统金融|股票|证券|新股|IPO|经纪商|股票研究|证券研究|equities|stock broker|brokerage|real stocks?)/i.test(value);
}

function applyScopeGuard(input: ScreeningInput, output: ScreeningOutput): ScreeningOutput {
  const profile = [input.handle, input.displayName, input.bio, input.sourceText].filter(Boolean).join(' ');
  // Keep traditional stock/broker accounts auditable as a distinct blocked
  // category instead of mislabelling them as KOL accounts.
  if (hasTraditionalFinanceScope(profile) && !hasCryptoScope(profile)) {
    const reason = `${output.reason} 范围校验：简介/资料仅体现传统股票或经纪业务，未发现加密项目、代币、链上产品、测试网或空投信号，归类为传统金融/非加密项目。`;
    return { ...output, accountType: 'TRADFI', reason: reason.slice(0, 500) };
  }
  return output;
}

function parseModelOutput(text: string): ScreeningOutput {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('screening output does not contain a JSON object');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const nested = (parsed.output && typeof parsed.output === 'object' ? parsed.output : parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed) as Record<string, unknown>;
  const reason = String(nested.reason ?? nested.explanation ?? nested.summary ?? nested.理由 ?? '').trim();
  if (!reason) throw new Error('screening output is missing reason');
  const confidenceValue = nested.confidence ?? nested.score;
  const confidence = confidenceValue === undefined ? undefined : Number(confidenceValue);
  const explicitType = normalizeAccountType(nested.accountType ?? nested.account_type ?? nested.type ?? nested.category ?? nested.分类);
  const inferredType = inferAccountTypeFromReason(reason);
  // Some compatible providers label every crypto account as PROJECT even when
  // their own explanation clearly describes an NFT/PFP collectible. Treat that
  // contradiction as NFT so it cannot enter the short-term project pool.
  const accountType = explicitType === 'UNKNOWN' || (explicitType === 'PROJECT' && inferredType === 'NFT') ? inferredType : explicitType;
  return ScreeningOutputSchema.parse({ accountType, reason, ...(confidence !== undefined && Number.isFinite(confidence) ? { confidence } : {}) });
}

export class AccountScreeningService {
  constructor(private readonly router: AiProviderRouter, private readonly maxAttempts = 3) {}

  async classify(input: ScreeningInput): Promise<ScreeningResult> {
    let attempts = 0;
    let lastError = 'screening failed';
    while (attempts < this.maxAttempts) {
      attempts += 1;
      try {
        const result = await this.router.complete({
          purpose: 'screening',
          system: '你是短期加密投机/创业项目发现系统的 AI 初筛器，不是新股申购、IPO、传统股票或证券研究筛选器。只保留具有短期打新潜力的加密创业项目、协议、代币、积分、测试网、空投、产品上线或早期基础设施账号。必须过滤 KOL、个人账号、个人开发者/dev 账号、媒体账号，以及 NFT/PFP/头像/数字藏品/收藏品项目；NFT 项目即使有代币或社区活动也必须判定为 NFT 并 blocked。传统股票、证券、IPO、新股申购、基金、券商/经纪商或仅奖励真实股票的非加密项目，统一判定为 TRADFI 并 blocked，不能因为出现 stocks、broker、research 等词就判为 KOL。只有明确存在加密、区块链、代币、链上产品、测试网、空投等证据时，才可保留为 PROJECT。请结合简介、近期推文内容、粉丝数、认证状态、账号名称和账号定位判断；必要时使用 X Search 核对该账号公开资料。reason 必须使用简体中文且详细，明确写出“简介证据、推文证据、粉丝/认证证据、项目类型结论”，缺失字段要写“未提供”，禁止只写笼统结论。必须只返回 JSON。',
          user: JSON.stringify(input),
          schema: '{"accountType":"PROJECT|ALPHA|UNKNOWN|KOL|PERSONAL|DEV|MEDIA|NFT|TRADFI","reason":"中文具体判断理由","confidence":0.0}'
        });
        const output = applyScopeGuard(input, parseModelOutput(result.response.text));
        const blocked = BLOCKED_TYPES.has(output.accountType);
        return { decision: blocked ? 'blocked' : 'allowed', accountType: output.accountType, reason: chineseReason(output.accountType, output.reason), providerName: result.provider.name, model: result.response.model, attempts };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    // 初筛不再阻塞实时信号流等待人工判断：AI 暂时不可用时自动放行到实时信号流，
    // 但保留 UNKNOWN 和失败原因，方便后续自动重跑或在详情中追踪。
    return { decision: 'allowed', accountType: 'UNKNOWN', reason: 'AI 初筛暂不可用，已自动放行到实时信号流，系统将在后续重新尝试。', attempts };
  }
}
