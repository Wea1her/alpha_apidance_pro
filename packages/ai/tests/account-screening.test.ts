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
    ['KOL', 'blocked'], ['PERSONAL', 'blocked'], ['DEV', 'blocked'], ['MEDIA', 'blocked'], ['NFT', 'allowed'], ['PROJECT', 'allowed'], ['ALPHA', 'allowed'], ['UNKNOWN', 'allowed']
  ] as const)('classifies %s as %s', async (accountType, decision) => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType, reason: '分类理由' }))]));
    await expect(service.classify(input)).resolves.toMatchObject({ accountType, decision });
  });
  it('automatically allows invalid output after retries without manual review', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter('not-json')]), 2);
    await expect(service.classify(input)).resolves.toMatchObject({ decision: 'allowed', accountType: 'UNKNOWN', attempts: 2 });
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
  it('blocks traditional stock or broker profiles as TRADFI instead of treating them as KOL', async () => {
    const service = new AccountScreeningService(new AiProviderRouter([adapter(JSON.stringify({ accountType: 'PROJECT', reason: '简介证据：像素经纪人通过工作获得真实股票；推文证据：未提供；粉丝/认证证据：粉丝数4884，未认证；项目类型结论：项目账号。' }))]));
    await expect(service.classify({ ...input, handle: 'thefirmbrokers', displayName: 'FIRM BROKERS', bio: '5,000 pixel brokers who work every hour and pay you in real stocks.' })).resolves.toMatchObject({ decision: 'blocked', accountType: 'TRADFI' });
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
});
