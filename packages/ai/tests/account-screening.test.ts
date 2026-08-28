import { describe, expect, it } from 'vitest';
import { AccountScreeningService } from '../src/screening/account-screening.js';
import { AiProviderRouter } from '../src/provider-router.js';
import type { AiProviderAdapter } from '../src/provider.js';

function adapter(text: string): AiProviderAdapter {
  return { profile: { id: 'p', name: 'screening', baseUrl: 'https://ai.test', screeningModel: 'screen-v1', researchModel: 'research-v1', capabilities: ['chat', 'structured_output'], role: 'main', enabled: true, health: 'healthy' }, complete: async () => ({ text, model: 'screen-v1' }), healthCheck: async () => 'healthy' };
}
describe('AccountScreeningService', () => {
  const input = { xUserId: '42', handle: 'alpha', displayName: 'Alpha', bio: 'test' };
  it.each([
    ['KOL', 'blocked'], ['PERSONAL', 'blocked'], ['DEV', 'blocked'], ['MEDIA', 'blocked'], ['NFT', 'allowed'], ['PROJECT', 'allowed'], ['ALPHA', 'allowed'], ['UNKNOWN', 'allowed'],
    ['CHAIN', 'blocked'], ['EXCHANGE', 'blocked'], ['FOUNDATION', 'blocked'], ['AFFILIATE', 'blocked']
  ] as const)('classifies %s as %s', async (accountType, decision) => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType, reason: '分类理由' }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ accountType, decision });
  });
  it('automatically allows invalid output after retries without manual review', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter('not-json')]), 2);
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'allowed', accountType: 'UNKNOWN', attempts: 2 });
  });
  it('still blocks deterministic exchange identities when AI is unavailable', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter('not-json')]), 2);
    await expect(service.classify({ ...input, handle: 'brc_exchange', displayName: 'BRC Exchange', bio: 'Swap and liquidity markets.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'EXCHANGE', attempts: 2 });
  });
  it('still blocks deterministic institutional affiliates when AI is unavailable', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter('not-json')]), 2);
    await expect(service.classify({ ...input, handle: 'CoinbaseDev', displayName: 'Coinbase Developer Platform', bio: 'Trusted crypto infrastructure.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'AFFILIATE', attempts: 2 });
  });
  it('accepts fenced JSON and Chinese account labels from compatible providers', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter('```json\n{"account_type":"媒体","explanation":"资讯媒体账号"}\n```')]));
    const result = await service.classify(input);
    expect(result).toMatchObject({ decision: 'blocked', accountType: 'MEDIA' });
    expect(result.reason).toContain('简介证据：test');
  });
  it('keeps detailed Chinese evidence even when it contains account terminology', async () => {
    const reason = '简介证据：长期发布市场观点；推文证据：以项目解读和推广为主；粉丝/认证证据：粉丝数较高且未显示官方项目认证；结论：判定为 KOL。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'KOL', reason }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'blocked', reason });
  });
  it('infers a blocked account type when the model only states it in the reason', async () => {
    const reason = '简介证据：个人宣言；推文证据：持续发布交易观点；粉丝/认证证据：粉丝数较高但无官方认证；结论：该账号为个人账号，应过滤。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ reason }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'blocked', accountType: 'PERSONAL' });
  });
  it('keeps NFT and collectible projects in the short-term project pool', async () => {
    const reason = '简介证据：NFT/PFP 收藏品项目；推文证据：持续发布头像铸造和藏品活动；粉丝/认证证据：未显示协议或产品交付；项目类型结论：NFT 官方项目，应保留。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'NFT', reason }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'allowed', accountType: 'NFT', reason });
  });
  it('keeps a contradictory PROJECT label specific as NFT and allowed', async () => {
    const reason = '简介证据：PFP 项目；推文证据：头像铸造活动；粉丝/认证证据：无协议交付信息；项目类型结论：NFT 收藏品。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'allowed', accountType: 'NFT' });
  });
  it('still blocks a personal NFT collector account', async () => {
    const reason = '简介证据：NFT collector / PFP holder；推文证据：分享个人收藏；项目类型结论：个人收藏者，不是 NFT 官方项目。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ reason }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'blocked', accountType: 'PERSONAL' });
  });
  it('keeps an official NFT collection when the relay mislabels it as KOL', async () => {
    const reason = '简介证据：The first NFT collection on ZEC；推文证据：发布 mint 和白名单安排；粉丝/认证证据：粉丝数2342，未认证；项目类型结论：NFT 官方项目。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'KOL', reason }))]));
    await expect(service.classify({ ...input, handle: 'zec_bit', displayName: 'Zec Bit', bio: 'The first NFT collection on ZEC', sourceText: 'Mint soon; whitelist is open.' })).resolves.toMatchObject({ decision: 'allowed', accountType: 'NFT' });
  });
  it('blocks high-follower airdrop and testnet campaigns from the early pool', async () => {
    const reason = '简介证据：大型测试网项目；推文证据：持续进行空投和积分活动；粉丝/认证证据：粉丝数125000，已认证；项目类型结论：项目账号。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify({ ...input, handle: 'large_testnet', bio: 'Testnet airdrop points campaign', followerCount: 125000, verified: true })).resolves.toMatchObject({ decision: 'blocked', accountType: 'PROJECT' });
  });
  it('blocks established protocols such as Polymarket', async () => {
    const reason = '简介证据：预测市场协议；推文证据：产品已完善并持续运营；粉丝/认证证据：粉丝数300000，已认证；项目类型结论：项目账号。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    const result = await service.classify({ ...input, handle: 'Polymarket', displayName: 'Polymarket', bio: 'The world\'s largest prediction market.', followerCount: 300000, verified: true });
    expect(result).toMatchObject({ decision: 'blocked', accountType: 'PROJECT' });
    expect(result.reason).toContain('成熟运营');
  });
  it('keeps a small startup account with few posts but strong post views', async () => {
    const reason = '简介证据：正在构建链上创业产品；推文证据：仅发布2条帖子但单帖浏览量92000；粉丝/认证证据：粉丝数680，未认证；项目类型结论：早期创业项目，应保留。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify({ ...input, handle: 'quiet_builder', bio: 'Building a new onchain product.', sourceText: '2 posts; latest post views 92000', followerCount: 680 })).resolves.toMatchObject({ decision: 'allowed', accountType: 'PROJECT' });
  });
  it('blocks traditional stock or broker profiles as TRADFI instead of treating them as KOL', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：像素经纪人通过工作获得真实股票；推文证据：未提供；粉丝/认证证据：粉丝数4884，未认证；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'thefirmbrokers', displayName: 'FIRM BROKERS', bio: '5,000 pixel brokers who work every hour and pay you in real stocks.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'TRADFI' });
  });
  it('blocks enterprise official accounts such as NVIDIA', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：NVIDIA 官方企业账号；推文证据：发布品牌和产品新闻；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'nvidia', displayName: 'NVIDIA', bio: 'Official NVIDIA account.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'CORPORATE' });
  });
  it('blocks venture capital and fund accounts', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：VC 投资机构；推文证据：发布投资组合和融资公告；项目类型结论：资本账号。' }))]));
    await expect(service.classify({ ...input, handle: 'alpha_ventures', displayName: 'Alpha Ventures', bio: 'Venture capital fund investing in crypto.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'CAPITAL' });
  });
  it('blocks public-chain official accounts even when the model labels them as projects', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：Solana 官方网络账号；推文证据：发布主网生态更新；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'solana', displayName: 'Solana', bio: 'Official account of the Solana blockchain network.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'CHAIN' });
  });
  it('does not confuse unrelated Official and chain mentions in a project bio', async () => {
    const reason = '简介证据：AI Agents Network项目；推文证据：发布产品进展；粉丝/认证证据：粉丝数800；项目类型结论：独立早期项目，应保留。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify({ ...input, handle: 'AiWhitebridge', displayName: 'WhiteBridge: AI Agents Network', bio: '@MEXC_Official Part of MVB10 @yzilabs @BNBCHAIN CMC Labs', followerCount: 800 })).resolves.toMatchObject({ decision: 'allowed', accountType: 'PROJECT' });
  });
  it('blocks exchange official accounts even when the model labels them as projects', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：Binance 交易所官方；推文证据：发布现货和合约产品公告；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'binance', displayName: 'Binance', bio: 'The world leading crypto exchange.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'EXCHANGE' });
  });
  it('blocks smaller accounts whose identity explicitly says Exchange', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：链上交易产品；推文证据：发布交易功能；项目类型结论：早期项目。' }))]));
    await expect(service.classify({ ...input, handle: 'brc_exchange', displayName: 'BRC Exchange', bio: 'Swap, liquidity and cross-chain markets.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'EXCHANGE' });
  });
  it('blocks camel-case handles ending in Exchange', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'NFT', reason: '简介证据：集中流动性项目；推文证据：发布激励活动；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'PharaohExchange', displayName: 'Pharaoh on AVAX', bio: 'Concentrated liquidity markets.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'EXCHANGE' });
  });
  it('blocks foundation official accounts without misclassifying them as capital funds', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：Ethereum Foundation 官方账号；推文证据：发布生态资助公告；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'ethereumfndn', displayName: 'Ethereum Foundation', bio: 'Official Ethereum Foundation account.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'FOUNDATION' });
  });
  it('blocks official developer and ecosystem affiliate accounts', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：Solana 官方开发者账号；推文证据：发布开发者活动；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'solanadevs', displayName: 'Solana Developers', bio: 'Official developer account for the Solana ecosystem.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'AFFILIATE' });
  });
  it('keeps an independent early project that only builds on a public chain', async () => {
    const reason = '简介证据：独立 NFT 发射项目；推文证据：即将在 Solana 上开放 mint；粉丝/认证证据：粉丝数320，未认证；项目类型结论：独立早期项目，应保留。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify({ ...input, handle: 'tiny_mint', displayName: 'Tiny Mint', bio: 'Independent NFT mint project building on Solana.', followerCount: 320 })).resolves.toMatchObject({ decision: 'allowed', accountType: 'NFT' });
  });
  it('does not turn negated institutional labels in the model reason into positive matches', async () => {
    const reason = '简介证据：独立生态项目；推文证据：正在发布产品；粉丝/认证证据：粉丝数500；项目类型结论：独立项目，不是公链、交易所、基金会官方或附属账号，应保留。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify({ ...input, handle: 'ponsecosystem', displayName: 'Pons', bio: 'Highlighting the pons ecosystem.', followerCount: 500 })).resolves.toMatchObject({ decision: 'allowed', accountType: 'PROJECT' });
  });
  it('does not treat a negated stock-research phrase as TRADFI', async () => {
    const reason = '简介证据：正在构建链上交易产品；推文证据：明确说明这不是新股申购研究，而是测试网发布；粉丝/认证证据：未提供；项目类型结论：加密项目。';
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason }))]));
    await expect(service.classify({ ...input, bio: 'Building an onchain testnet product.' })).resolves.toMatchObject({ decision: 'allowed', accountType: 'PROJECT' });
  });
  it('augments terse model reasons with auditable profile evidence', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '项目账号。' }))]));
    const result = await service.classify({ ...input, displayName: 'Arc Launch', bio: 'Building an onchain launch layer.', sourceText: 'Testnet is live; points soon.', followerCount: 128, verified: true });
    expect(result.reason).toContain('简介证据：Building an onchain launch layer.');
    expect(result.reason).toContain('推文证据：Testnet is live; points soon.');
    expect(result.reason).toContain('粉丝/认证证据：粉丝数 128，已认证');
    expect(result.reason).toContain('项目类型结论：项目账号');
  });
  it('returns AI chain and playbook classifications with the screening decision', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '项目账号。', chainCategory: 'Base', playbookCategory: 'Launchpad' }))]));
    await expect(service.classify({ ...input, handle: 'base_launch' })).resolves.toMatchObject({ decision: 'allowed', chainCategory: 'Base', playbookCategory: 'Launchpad' });
  });
  it('forces every .fun account into Launchpad when the model misclassifies it', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '发射项目。', chainCategory: 'Monad', playbookCategory: 'DeFi / 交易' }))]));
    await expect(service.classify({ ...input, handle: 'rocket.fun' })).resolves.toMatchObject({ decision: 'allowed', chainCategory: 'Monad', playbookCategory: 'Launchpad' });
  });
});
