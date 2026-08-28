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
export interface ScreeningResult {
  decision: ScreeningDecision;
  accountType: AccountType | 'UNKNOWN';
  reason: string;
  chainCategory?: string;
  playbookCategory?: string;
  providerName?: string;
  model?: string;
  attempts: number;
}

const BLOCKED_TYPES = new Set<AccountType>(['KOL', 'PERSONAL', 'DEV', 'MEDIA', 'TRADFI', 'CORPORATE', 'CAPITAL', 'CHAIN', 'EXCHANGE', 'FOUNDATION', 'AFFILIATE']);
const PROJECT_CONTRADICTION_TYPES = new Set<AccountType>(['KOL', 'PERSONAL', 'DEV', 'MEDIA', 'TRADFI']);
// “粉丝数较少”按 1 万作为默认早期项目阈值，后续可按盘面调整。
export const EARLY_PROJECT_FOLLOWER_LIMIT = 10_000;

function hasChinese(value: string): boolean { return /[\u3400-\u9fff]/u.test(value); }

const FALLBACK_REASON: Record<AccountType, string> = {
    PROJECT: 'AI 判断该账号具有项目官方主体特征。',
    ALPHA: 'AI 判断该账号属于上游 Alpha 数据账号。',
    UNKNOWN: 'AI 暂未确认账号属性，先保留观察。',
    KOL: 'AI 判断该账号主要承担意见领袖传播职能，不是项目官方账号。',
    PERSONAL: 'AI 判断该账号属于个人账号，缺少项目官方主体特征。',
    DEV: 'AI 判断该账号主要是个人开发者账号，缺少独立项目主体特征。',
    MEDIA: 'AI 判断该账号具有媒体或资讯传播属性，不属于项目官方账号。',
    NFT: 'AI 判断该账号是 NFT、PFP、收藏品或数字藏品项目官方账号，作为短期项目保留观察。',
    TRADFI: 'AI 判断该账号属于传统金融或非加密主体，不属于短期加密投机/创业项目。',
    CORPORATE: 'AI 判断该账号属于企业或品牌官方账号，不属于早期短期投机/创业项目。',
    CAPITAL: 'AI 判断该账号属于 VC、基金或资本投资机构账号，不属于早期项目主体。',
    CHAIN: 'AI 判断该账号属于公链、L1、L2 或区块链网络官方账号，不属于独立早期项目。',
    EXCHANGE: 'AI 判断该账号属于中心化或去中心化交易所官方账号，不属于独立早期项目。',
    FOUNDATION: 'AI 判断该账号属于基金会官方账号，不属于独立早期项目。',
    AFFILIATE: 'AI 判断该账号属于公链、交易所或基金会的官方附属账号，不属于独立早期项目。'
};
const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { PROJECT: '项目账号', ALPHA: 'Alpha 数据账号', UNKNOWN: '账号属性暂不明确', KOL: 'KOL 账号', PERSONAL: '个人账号', DEV: '个人开发者 / Dev 账号', MEDIA: '媒体 / 社媒账号', NFT: 'NFT / PFP / 数字藏品项目', TRADFI: '传统金融 / 非加密主体', CORPORATE: '企业 / 品牌官方账号', CAPITAL: 'VC / 基金 / 资本账号', CHAIN: '公链 / 区块链网络官方账号', EXCHANGE: '交易所官方账号', FOUNDATION: '基金会官方账号', AFFILIATE: '官方附属账号' };

function clip(value: string, max = 110): string { const normalized = value.replace(/\s+/gu, ' ').trim(); return normalized ? normalized.slice(0, max) : '未提供'; }

/**
 * Compatible relays occasionally return a one-line verdict even though the
 * prompt asks for evidence. Keep the model's verdict, but append a compact,
 * deterministic evidence block so every stored reason is auditable.
 */
function detailedChineseReason(input: ScreeningInput, accountType: AccountType, reason: string): string {
  const base = hasChinese(reason) && reason.trim().length >= 8 ? reason.trim() : FALLBACK_REASON[accountType];
  const sections: Array<[string, string]> = [
    ['简介证据', clip(input.bio ?? '')],
    ['推文证据', clip(input.sourceText ?? '')],
    ['粉丝/认证证据', `粉丝数 ${input.followerCount == null ? '未提供' : input.followerCount}，${input.verified == null ? '认证状态未提供' : input.verified ? '已认证' : '未认证'}`],
    ['账号定位证据', `名称 ${clip(input.displayName ?? '', 55)}，账号 @${clip(input.handle, 55).replace(/^@/, '')}`],
    ['项目类型结论', ACCOUNT_TYPE_LABEL[accountType]]
  ];
  const markerCount = sections.filter(([label]) => base.includes(`${label}：`)).length;
  // Preserve a model explanation that already contains at least three
  // independent evidence dimensions; only augment terse or one-dimensional
  // responses that users cannot audit from the project card.
  if (markerCount >= 3) return base;
  const missing = sections.filter(([label]) => !base.includes(`${label}：`)).map(([label, value]) => `${label}：${value}`);
  const compactBase = missing.length ? clip(base, 180) : base;
  const combined = missing.length ? `${compactBase.replace(/[。；;\s]+$/u, '')}；${missing.join('；')}。` : base;
  return combined.slice(0, 500);
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
  if (['CORPORATE', '企业', '企业账号', '品牌官方', '公司官方', '官方企业'].includes(normalized)) return 'CORPORATE';
  if (['CAPITAL', '资本', '投资机构', 'VC', '基金', '风投', '创投'].includes(normalized)) return 'CAPITAL';
  if (['CHAIN', '公链', '公链官方', '区块链网络', '网络官方', 'L1', 'L2'].includes(normalized)) return 'CHAIN';
  if (['EXCHANGE', '交易所', '交易所官方', 'CEX', 'DEX'].includes(normalized)) return 'EXCHANGE';
  if (['FOUNDATION', '基金会', '基金会官方'].includes(normalized)) return 'FOUNDATION';
  if (['AFFILIATE', '附属账号', '官方附属账号', '生态官方', '开发者关系', 'DEVREL'].includes(normalized)) return 'AFFILIATE';
  return 'UNKNOWN';
}

function normalizeCategory(value: unknown): string | undefined {
  const category = String(value ?? '').trim();
  if (!category || /^(?:待研判|待分类|未知|unknown|未确认|暂无)$/iu.test(category)) return undefined;
  return category.slice(0, 80);
}

function isFunHandle(handle: string): boolean {
  return /^@?[a-z0-9_]+\.fun$/iu.test(handle.trim());
}

function inferAccountTypeFromReason(reason: string): AccountType {
  if (/(?:KOL|大V|意见领袖|影响力账号|观点账号)/i.test(reason)) return 'KOL';
  if (/(?:媒体|资讯|新闻|内容传播账号)/i.test(reason)) return 'MEDIA';
  if (/(?:个人开发者|开发者账号|dev 账号|dev账号)/i.test(reason)) return 'DEV';
  if (/(?:个人账号|普通个人|个人用户)/i.test(reason)) return 'PERSONAL';
  if (/(?:NFT\s*收藏者|NFT\s*collector|PFP\s*holder|个人收藏|持有者)/iu.test(reason)
    && !/(?:NFT\s*项目|PFP\s*项目|官方账号|项目主体|collection\s*project)/iu.test(reason)) return 'PERSONAL';
  if (/(?:NFT|PFP|数字藏品|收藏品|头像项目|collectible)/i.test(reason)) return 'NFT';
  if (/(?:企业官方|品牌官方|公司账号|企业账号|公司官方)/iu.test(reason)) return 'CORPORATE';
  if (/(?:基金会官方|官方基金会|foundation\s+(?:official\s+)?account)/iu.test(reason)) return 'FOUNDATION';
  if (/(?:交易所官方|官方交易所|中心化交易所|去中心化交易所|crypto\s+exchange|centralized\s+exchange|decentralized\s+exchange)/iu.test(reason)) return 'EXCHANGE';
  if (/(?:公链官方|区块链网络官方|L1\s*官方|L2\s*官方|official\s+(?:blockchain|chain|network))/iu.test(reason)) return 'CHAIN';
  if (/(?:官方附属账号|官方(?:生态|开发者|社区|客服|地区|活动|资助)账号|developer\s+relations|devrel|official\s+(?:ecosystem|developer|community|support|regional|events?|grants?)\s+account)/iu.test(reason)) return 'AFFILIATE';
  if (/(?:VC|基金(?!会)|投资机构|风投|创投|资本账号|投资组合)/iu.test(reason)) return 'CAPITAL';
  // Do not infer TRADFI from a negated mention such as “不是新股研究”.
  // The model must explicitly return TRADFI, or the profile scope guard below
  // must find a clearly non-crypto traditional-finance profile.
  return 'UNKNOWN';
}

function reasonConfirmsProject(reason: string): boolean {
  // Compatible relays have occasionally returned accountType=KOL while the
  // evidence paragraph explicitly says the account is a project and should be
  // retained. Treat that as a model contradiction instead of blocking a valid
  // project. This guard only applies when the reason contains an explicit
  // negation of the blocked labels plus a positive retain/project conclusion.
  if (/(?:判定\s*blocked|应\s*blocked|必须过滤|直接过滤|属于个人\s*KOL|属于\s*KOL\/)/iu.test(reason)) return false;
  const explicitProject = /(?:项目主体|项目账号|协议项目|产品账号|基础设施|链上.*(?:项目|协议|产品)|明确指向.*(?:项目|协议|产品)|账号为.*(?:项目|协议|产品))/u.test(reason);
  const retained = /(?:应保留|保留标准|允许进入|符合(?:筛选|保留|项目)?标准|项目机会)/u.test(reason);
  const notBlocked = /(?:不属于|非|不是)\s*(?:KOL|个人(?:账号|用户)?|开发者|Dev|媒体|NFT|PFP|TRADFI|传统金融)/iu.test(reason);
  return explicitProject && retained && (notBlocked || /项目类型结论/u.test(reason));
}

function hasCryptoScope(value: string): boolean {
  return /(?:加密|区块链|代币|链上|crypto|web3|token|defi|airdrop|testnet|mainnet|solana|ethereum|base|meme coin)/i.test(value);
}

function hasTraditionalFinanceScope(value: string): boolean {
  return /(?:传统金融|股票|证券|新股|IPO|经纪商|股票研究|证券研究|equities|stock broker|brokerage|real stocks?)/i.test(value);
}

/** NFT 官方项目属于允许保留的短期项目类型；仅个人收藏者应被过滤。 */
function isOfficialNftProject(value: string): boolean {
  const hasNft = /(?:\bnft\b|\bpfp\b|digital collectibles?|数字藏品|头像项目|收藏品|collectible)/iu.test(value);
  if (!hasNft) return false;
  if (/(?:不属于|不是|非)[^。；\n]{0,80}(?:\bNFT\b|\bPFP\b|数字藏品|收藏品)/iu.test(value)) return false;
  const isPersonal = /(?:nft\s*(?:collector|holder|trader)|pfp\s*holder|个人收藏者?|个人藏品|我的藏品|分享个人收藏|转售藏品)/iu.test(value);
  if (isPersonal) return false;
  return /(?:官方|项目|collection|mint|铸造|发行|drop|roadmap|白名单|whitelist|built|launch|铸币)/iu.test(value);
}

function extractFollowerCount(value: string): number | undefined {
  const match = /(?:粉丝(?:数)?|followers?(?:\s*count)?)\s*[:：约\s]*([\d,.]+)\s*(万|k)?/iu.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1].replace(/,/gu, ''));
  if (!Number.isFinite(amount)) return undefined;
  return amount * (match[2]?.toLowerCase() === '万' ? 10_000 : match[2] ? 1_000 : 1);
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

function applyNftProjectGuard(input: ScreeningInput, output: ScreeningOutput): ScreeningOutput {
  const evidence = [input.handle, input.displayName, input.bio, input.sourceText, output.reason].filter(Boolean).join(' ');
  if (output.accountType !== 'NFT' && isOfficialNftProject(evidence)) {
    return {
      ...output,
      accountType: 'NFT',
      reason: `${output.reason} 类型校验：简介/推文明确指向 NFT 官方项目、collection 或发行活动，非个人收藏者，按允许的 NFT 项目保留。`.slice(0, 500)
    };
  }
  return output;
}

function applyEntityGuard(input: ScreeningInput, output: ScreeningOutput): ScreeningOutput {
  const identity = `${input.handle} ${input.displayName}`;
  // Entity guards must only inspect source profile evidence. Model reasons
  // often contain negated phrases such as “不是交易所/基金会官方”; feeding
  // those phrases back into positive regexes causes valid projects to be
  // blocked by the very explanation that says they should be retained.
  const profile = [identity, input.bio, input.sourceText].filter(Boolean).join(' ');
  const handle = input.handle.replace(/^@/u, '').trim().toLowerCase();
  const displayName = (input.displayName ?? '').trim().toLowerCase();
  const knownChains = new Set(['ethereum', 'solana', 'solanafoundation', 'bnbchain', 'arbitrum', 'optimism', 'base', 'avalancheavax', '0xpolygon', 'sui_network', 'aptos', 'cosmos', 'celestiaorg', 'starknet', 'zksync', 'scroll_zkp', 'lineabuild', 'monad', 'ton_blockchain']);
  const knownExchanges = new Set(['binance', 'coinbase', 'okx', 'bybit_official', 'krakenfx', 'kucoincom', 'gate_io', 'bitgetglobal', 'mexc_official', 'htx_global', 'upbitglobal', 'uniswap', 'pancakeswap']);
  const knownChainIdentity = knownChains.has(handle) || knownChains.has(displayName.replace(/\s+/gu, ''));
  const knownExchangeIdentity = knownExchanges.has(handle) || knownExchanges.has(displayName.replace(/\s+/gu, ''));
  const foundation = /(?:foundation|基金会|fndn)/iu.test(identity)
    || /(?:official\s+(?:account\s+(?:of|for)\s+)?(?:the\s+)?(?:[\w-]+\s+){0,3}foundation|foundation\s+(?:official\s+)?account|基金会官方|官方基金会)/iu.test(profile);
  const compactHandle = handle.replace(/[^a-z0-9]/gu, '');
  const exchangeIdentity = compactHandle.endsWith('exchange') || /(?:^|[\s._-])exchange(?:$|[\s._-])|交易所/iu.test(identity);
  const exchange = knownExchangeIdentity || exchangeIdentity
    || /(?:交易所官方|官方交易所|(?:crypto|centralized|decentralized)\s+exchange(?:\s+official)?|official\s+(?:account\s+(?:of|for)\s+)?(?:the\s+)?(?:[\w-]+\s+){0,3}(?:crypto\s+)?exchange)/iu.test(profile);
  const chain = knownChainIdentity
    || /(?:公链官方|区块链网络官方|official\s+(?:account\s+(?:of|for)\s+)?(?:the\s+)?(?:[\w-]+\s+){0,3}(?:blockchain|chain|layer\s*[12]|l[12]\s+network)|(?:layer\s*[12]|l[12]|public\s+blockchain)\s+(?:blockchain|network))/iu.test(profile);
  const institutionParent = /(?:ethereum|solana|bnb|binance|coinbase|arbitrum|optimism|base|avalanche|polygon|sui|aptos|cosmos|celestia|starknet|zksync|scroll|linea|monad|ton|okx|bybit|kraken|kucoin|uniswap|pancakeswap)/iu.test(identity);
  const affiliateRole = /(?:developers?|devrel|ecosystem|community|support|regional|events?|grants?|labs|builds|zh|cn|asia|中文|生态|开发者|社区|客服|地区|活动|资助)/iu.test(identity);
  const affiliate = /(?:官方附属账号|官方(?:生态|开发者|社区|客服|地区|活动|资助)账号|developer\s+relations|devrel|official\s+(?:ecosystem|developers?|community|support|regional|events?|grants?)\s+(?:account|channel))/iu.test(profile)
    || (institutionParent && affiliateRole);
  const corporateName = /(?:^|[^a-z])(nvidia|microsoft|apple|google|tesla|amazon|meta|intel|adobe|samsung|sony|oracle|ibm|openai)(?:$|[^a-z])/iu.test(identity);
  const corporate = corporateName || /(?:企业官方|品牌官方|公司官方|corporate\s+account|official\s+company|official\s+brand|科技公司)/iu.test(profile);
  const capital = /(?:\bvc\b|venture\s+capital|投资机构|基金(?!会)|风投|创投|资本管理|capital\s+(?:fund|partners?|ventures?)|asset\s+management)/iu.test(profile);
  if (foundation) return { ...output, accountType: 'FOUNDATION', reason: `${output.reason} 范围校验：账号本身是基金会官方主体，自动排除；基金会支持或投资某个独立项目不等同于该项目是基金会账号。`.slice(0, 500) };
  if (exchange) return { ...output, accountType: 'EXCHANGE', reason: `${output.reason} 范围校验：账号本身是中心化或去中心化交易所官方主体，自动排除。`.slice(0, 500) };
  if (chain) return { ...output, accountType: 'CHAIN', reason: `${output.reason} 范围校验：账号本身是公链、L1、L2 或区块链网络官方主体，自动排除。`.slice(0, 500) };
  if (affiliate) return { ...output, accountType: 'AFFILIATE', reason: `${output.reason} 范围校验：账号是公链、交易所或基金会的官方生态、开发者、社区、地区、活动、支持或 Labs 等附属账号，自动排除。`.slice(0, 500) };
  if (capital) return { ...output, accountType: 'CAPITAL', reason: `${output.reason} 范围校验：账号体现 VC、基金或资本投资机构属性，自动排除。`.slice(0, 500) };
  if (corporate) return { ...output, accountType: 'CORPORATE', reason: `${output.reason} 范围校验：账号体现企业或品牌官方属性，自动排除。`.slice(0, 500) };
  return output;
}

function applyEarlyStageGuard(input: ScreeningInput, output: ScreeningOutput): { output: ScreeningOutput; blocked: boolean } {
  const profile = [input.handle, input.displayName, input.bio, input.sourceText, output.reason].filter(Boolean).join(' ');
  const followers = input.followerCount ?? extractFollowerCount(profile);
  const highFollowers = followers != null && Number.isFinite(followers) && followers >= EARLY_PROJECT_FOLLOWER_LIMIT;
  const earlyDistribution = /(?:airdrop|testnet|mainnet\s*launch|points|积分|空投|测试网|任务活动|早期激励)/iu.test(profile);
  const establishedName = /(?:^|[^a-z])(polymarket|uniswap|aave|compound|opensea|blur|metamask|phantom|layerzero|starknet|zksync|arbitrum|optimism|coinbase|binance)(?:$|[^a-z])/iu.test(`${input.handle} ${input.displayName}`);
  const establishedEvidence = /(?:millions?\s+of\s+users|数百万用户|成熟(?:项目|协议)|已完善|fully\s+launched|established\s+protocol|多年运营|长期运营)/iu.test(profile);
  const reasons: string[] = [];
  if (establishedName || (highFollowers && establishedEvidence)) {
    reasons.push('账号对应已完善或成熟运营的项目，不属于本项目池的早期创业/短期投机范围');
  } else if (highFollowers && earlyDistribution) {
    reasons.push(`粉丝数 ${followers!.toLocaleString()} 已达到早期项目上限 ${EARLY_PROJECT_FOLLOWER_LIMIT.toLocaleString()}，且主要是空投/测试网/积分传播`);
  }
  if (!reasons.length) return { output, blocked: false };
  return {
    output: { ...output, reason: `${output.reason} 范围校验：${reasons.join('；')}，自动排除。`.slice(0, 500) },
    blocked: true
  };
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
  // their own explanation clearly describes an NFT/PFP collectible. Preserve
  // the more specific NFT type; NFT is an allowed project category.
  let accountType = explicitType === 'UNKNOWN' || (explicitType === 'PROJECT' && inferredType === 'NFT') ? inferredType : explicitType;
  if (accountType === 'NFT' && /(?:NFT\s*收藏者|NFT\s*collector|PFP\s*holder|个人收藏|持有者)/iu.test(reason)
    && !/(?:NFT\s*项目|PFP\s*项目|官方账号|项目主体|collection\s*project)/iu.test(reason)) accountType = 'PERSONAL';
  if (PROJECT_CONTRADICTION_TYPES.has(accountType) && reasonConfirmsProject(reason)) accountType = 'PROJECT';
  const chainCategory = normalizeCategory(nested.chainCategory ?? nested.chain_category ?? nested.chain ?? nested.链分类);
  let playbookCategory = normalizeCategory(nested.playbookCategory ?? nested.playbook_category ?? nested.playbook ?? nested.gameplay ?? nested.玩法板块);
  if (isFunHandle((nested.handle as string | undefined) ?? '')) playbookCategory = 'Launchpad';
  return ScreeningOutputSchema.parse({ accountType, reason, ...(confidence !== undefined && Number.isFinite(confidence) ? { confidence } : {}), ...(chainCategory ? { chainCategory } : {}), ...(playbookCategory ? { playbookCategory } : {}) });
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
          system: '你是短期投机/创业项目发现系统的 AI 初筛器。唯一筛选标准是：账号是否代表一个粉丝规模较小、正在构建、发行、测试、增长或即将上线的短期投机型项目机会。默认将粉丝数达到或超过10000视为较高体量：这类账号若主要做空投、积分、测试网或早期激励，应判定为范围外并 blocked；已经完善、成熟运营的协议或平台（例如 Polymarket 等）无论粉丝数多少都判定为范围外并 blocked。只保留粉丝数较少的独立创业/短期投机项目、发射台、个人发币项目，以及 NFT/PFP/头像/数字藏品/收藏品官方项目；NFT 官方项目属于允许保留类型，只有 NFT 收藏者、NFT KOL 或个人账号才过滤。粉丝数少、发帖数量少但单帖浏览量较高的疑似创业项目，属于重点早期信号，必须保留，不得仅因发帖少或浏览量高而排除。必须过滤 KOL、个人账号、个人开发者/dev 账号、媒体账号、企业/品牌官方账号、VC/基金/资本投资机构账号、公链/L1/L2/区块链网络官方账号、中心化或去中心化交易所官方账号、基金会官方账号，以及这些主体的附属账号。附属账号包括明确隶属于公链、交易所或基金会的生态、开发者关系/DevRel、社区、客服、地区、中文、活动、资助、Labs 等官方账号。账号本身是官方主体时，无论粉丝数多少都 blocked；独立项目仅仅部署在某条链、获得基金会支持、使用交易所服务或与这些机构合作，不属于附属账号，不得因此排除。企业、资本、公链、交易所、基金会及附属账号即使发布加密内容，也不代表本项目池中的独立早期创业项目。只有当账号明确属于传统金融业务、经纪服务或仅奖励真实股票的非加密主体，且没有任何短期项目构建/交付信号时，才判定为 TRADFI 并 blocked；这不是新股研究判断。若同时存在加密项目、链上产品、测试网、空投或创业交付证据，应按项目证据综合判断，不得因单个金融词汇否定。请结合简介、近期推文内容、粉丝数、认证状态、账号名称和账号定位判断；必要时使用 X Search 核对该账号公开资料。除 accountType 和 reason 外，还必须返回 chainCategory（链分类）和 playbookCategory（玩法板块）。链分类可选 Solana、Base、Ethereum、Arbitrum、Optimism、BNB Chain、Polygon、Avalanche、Sui、Aptos、Monad、Zcash、ARC、Litecoin、Cosmos、Starknet、zkSync、Scroll、Linea、TON、Hyperliquid、多链、待研判；玩法板块可选 Launchpad、NFT / 游戏、Meme、空投 / 积分 / 测试网、DeFi / 交易、质押 / 收益、DePIN / 节点、AI / Agent、SocialFi / 社交、基础设施、待研判。账号 ID 以 .fun 结尾时，无论其他描述如何，playbookCategory 必须为 Launchpad，不能归类为 DeFi。reason 必须使用简体中文且详细，明确写出“简介证据、推文证据、粉丝/认证证据、项目类型结论”，缺失字段要写“未提供”，禁止只写笼统结论。必须只返回 JSON。',
          user: JSON.stringify({ ...input, handle: input.handle }),
          schema: '{"accountType":"PROJECT|ALPHA|UNKNOWN|KOL|PERSONAL|DEV|MEDIA|NFT|TRADFI|CORPORATE|CAPITAL|CHAIN|EXCHANGE|FOUNDATION|AFFILIATE","reason":"中文具体判断理由","chainCategory":"Solana|Base|Ethereum|Arbitrum|Optimism|BNB Chain|Polygon|Avalanche|Sui|Aptos|Monad|Zcash|ARC|Litecoin|Cosmos|Starknet|zkSync|Scroll|Linea|TON|Hyperliquid|多链|待研判","playbookCategory":"Launchpad|NFT / 游戏|Meme|空投 / 积分 / 测试网|DeFi / 交易|质押 / 收益|DePIN / 节点|AI / Agent|SocialFi / 社交|基础设施|待研判","confidence":0.0}'
        });
        let parsed = parseModelOutput(result.response.text);
        if (isFunHandle(input.handle)) parsed = { ...parsed, playbookCategory: 'Launchpad' };
        const nftOutput = applyNftProjectGuard(input, applyScopeGuard(input, parsed));
        const entityOutput = applyEntityGuard(input, nftOutput);
        const stageGuard = applyEarlyStageGuard(input, entityOutput);
        const output = stageGuard.output;
        const blocked = stageGuard.blocked || BLOCKED_TYPES.has(output.accountType);
        return { decision: blocked ? 'blocked' : 'allowed', accountType: output.accountType, reason: detailedChineseReason(input, output.accountType, output.reason), chainCategory: output.chainCategory, playbookCategory: output.playbookCategory, providerName: result.provider.name, model: result.response.model, attempts };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    // 初筛不再阻塞实时信号流等待人工判断：AI 暂时不可用时自动放行到实时信号流，
    // 但保留 UNKNOWN 和失败原因，方便后续自动重跑或在详情中追踪。
    const unavailable = applyEntityGuard(input, applyNftProjectGuard(input, applyScopeGuard(input, {
      accountType: 'UNKNOWN',
      reason: 'AI 初筛暂不可用，已执行本地账号范围校验；系统将在后续重新尝试。'
    })));
    const stageGuard = applyEarlyStageGuard(input, unavailable);
    const output = stageGuard.output;
    const blocked = stageGuard.blocked || BLOCKED_TYPES.has(output.accountType);
    return { decision: blocked ? 'blocked' : 'allowed', accountType: output.accountType, reason: detailedChineseReason(input, output.accountType, output.reason), ...(isFunHandle(input.handle) ? { playbookCategory: 'Launchpad' } : {}), attempts };
  }
}
