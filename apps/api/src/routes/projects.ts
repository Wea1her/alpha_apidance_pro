import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

export interface ProjectRoutesOptions { database: ApiDatabase; }

interface ProjectRow {
  id: string; x_user_id: string; current_handle: string; display_name: string; avatar_url: string | null;
  status: string; highest_star: number; highest_common_follow_count: number; surge_until: string | null;
  exclusion_reason: string | null; screening_account_type?: string | null; screening_reason?: string | null;
  latest_signal_context?: string | null;
  has_ca: boolean; latest_signal_at: string | null; report_status: string | null; screening_decision?: string | null; monitor_actual_state?: string | null; monitor_desired_state?: string | null;
}

function classifyChain(context: string): string {
  const value = context.toLowerCase();
  const chains: Array<[string, string[]]> = [
    ['Robinhood Chain', ['robinhood chain', 'robinhoodcrypto']],
    ['Solana', ['solana', 'solana vm']],
    ['Base', ['base chain', 'base network', 'base.org']],
    ['Arbitrum', ['arbitrum', 'arb one']],
    ['Optimism', ['optimism', 'op mainnet']],
    ['BNB Chain', ['bnb chain', 'binance smart chain', 'bsc']],
    ['Polygon', ['polygon', 'matic']],
    ['Avalanche', ['avalanche', 'avax']],
    ['Sui', ['sui network', 'sui blockchain']],
    ['Aptos', ['aptos']],
    ['TON', ['the open network', ' ton ', 'ton blockchain']],
    ['Cosmos', ['cosmos sdk', 'ibc', 'cosmos hub']],
    ['Starknet', ['starknet', 'cairo']],
    ['zkSync', ['zksync']],
    ['Scroll', ['scroll zk', 'scroll network']],
    ['Linea', ['linea network', 'linea build']],
    ['Monad', ['monad']],
    ['Hyperliquid', ['hyperliquid']],
    ['EVM 多链', ['evm', 'ethereum', ' eth ', 'erc-20', 'erc20']]
  ];
  return chains.find(([, needles]) => needles.some((needle) => value.includes(needle)))?.[0] ?? '待研判';
}

function classifyPlaybook(context: string): string {
  const value = context.toLowerCase();
  const playbooks: Array<[string, string[]]> = [
    ['空投 / 积分 / 测试网', ['airdrop', '空投', 'points', '积分', 'testnet', '测试网', '任务']],
    ['DeFi / 交易', ['defi', 'swap', 'lending', '借贷', 'perp', '永续', 'trading', '交易']],
    ['质押 / 收益', ['staking', '质押', 'restaking', '再质押', 'yield', '收益']],
    ['DePIN / 节点', ['depin', 'depin', 'gpu', 'compute', '算力', 'node', '节点']],
    ['AI / Agent', [' ai ', '人工智能', 'agent', '智能体', 'llm']],
    ['NFT / 游戏', ['nft', 'gamefi', 'gaming', '游戏', 'collectible']],
    ['Meme', ['memecoin', 'meme coin', 'meme', '土狗']],
    ['SocialFi / 社交', ['socialfi', 'social network', '社交']],
    ['基础设施', ['infrastructure', '基础设施', 'rollup', 'bridge', '跨链', 'protocol']]
  ];
  return playbooks.find(([, needles]) => needles.some((needle) => value.includes(needle)))?.[0] ?? '待研判';
}

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    xUserId: row.x_user_id,
    handle: row.current_handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: row.status,
    highestStar: row.highest_star,
    highestCommonFollowCount: row.highest_common_follow_count,
    surge: Boolean(row.surge_until && new Date(row.surge_until).getTime() > Date.now()),
    surgeUntil: row.surge_until,
    hasCa: row.has_ca,
    latestSignalAt: row.latest_signal_at,
    reportStatus: row.report_status,
    screeningDecision: row.screening_decision ?? null,
    screeningAccountType: row.screening_account_type ?? null,
    screeningReason: row.screening_reason ?? null,
    exclusionReason: row.exclusion_reason ?? null,
    chainCategory: classifyChain(`${row.display_name} ${row.current_handle} ${row.latest_signal_context ?? ''}`),
    playbookCategory: classifyPlaybook(`${row.display_name} ${row.current_handle} ${row.latest_signal_context ?? ''}`),
    monitorStatus: row.monitor_actual_state ?? null,
    monitorDesiredState: row.monitor_desired_state ?? null
  };
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectRoutesOptions): void {
  app.get<{ Querystring: { filter?: string; limit?: string } }>('/api/projects', async (request, reply) => {
    const filter = request.query.filter ?? 'all';
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '50', 10) || 50, 1), 100);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const approvedClause = `p.status <> 'excluded' and exists (select 1 from screening_decisions sd where sd.project_id = p.id and sd.decision in ('allowed', 'manual_allowed'))`;
    if (filter === 'three_plus') clauses.push(`p.highest_star >= 3`, approvedClause);
    else if (filter === 'surge') clauses.push(`p.surge_until > now()`, approvedClause);
    else if (filter === 'ca') clauses.push(`exists (select 1 from signals ca where ca.project_id = p.id and ca.type = 'ca')`, approvedClause);
    else if (filter === 'pending_review') clauses.push(`p.status = 'pending_review'`);
    else if (filter === 'excluded') clauses.push(`p.status = 'excluded'`);
    else if (filter === 'all') clauses.push(approvedClause);
    else if (filter !== 'all') return reply.code(400).send({ error: 'invalid_filter' });
    const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
    const rows = await options.database.query<ProjectRow>(
      `select p.id, p.x_user_id, p.current_handle, p.display_name, p.avatar_url, p.status, p.exclusion_reason,
              p.highest_star, p.highest_common_follow_count, p.surge_until,
              exists (select 1 from signals ca where ca.project_id = p.id and ca.type = 'ca') as has_ca,
              (select max(s.occurred_at) from signals s where s.project_id = p.id) as latest_signal_at,
              (select coalesce(s.content, '') || ' ' || coalesce(s.data::text, '') from signals s where s.project_id = p.id order by s.occurred_at desc limit 1) as latest_signal_context,
              (select rv.status from report_versions rv where rv.project_id = p.id order by rv.version desc limit 1) as report_status,
              (select sd.decision from screening_decisions sd where sd.project_id = p.id order by sd.created_at desc limit 1) as screening_decision,
              (select sd.account_type from screening_decisions sd where sd.project_id = p.id order by sd.created_at desc limit 1) as screening_account_type,
              (select sd.reason from screening_decisions sd where sd.project_id = p.id order by sd.created_at desc limit 1) as screening_reason,
              (select am.actual_state from alpha_monitors am where am.project_id = p.id) as monitor_actual_state,
              (select am.desired_state from alpha_monitors am where am.project_id = p.id) as monitor_desired_state
       from projects p ${where}
       order by (p.surge_until > now()) desc, p.highest_star desc, p.updated_at desc
       limit $1`,
      [limit]
    );
    return { items: rows.rows.map(toProject), nextCursor: null };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/signals', async (request) => {
    const rows = await options.database.query(
      `select id, type, occurred_at, common_follow_count, x_post_url, content, data
       from signals where project_id = $1 order by occurred_at desc limit 100`,
      [request.params.id]
    );
    return { items: rows.rows };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const result = await options.database.query(
      `select p.id, p.x_user_id, p.current_handle, p.display_name, p.avatar_url, p.status, p.exclusion_reason,
              p.highest_star, p.highest_common_follow_count, p.surge_until,
              p.created_at, p.updated_at, p.excluded_at, p.exclusion_reason,
              exists (select 1 from signals ca where ca.project_id = p.id and ca.type = 'ca') as has_ca,
              (select max(s.occurred_at) from signals s where s.project_id = p.id) as latest_signal_at,
              (select coalesce(s.content, '') || ' ' || coalesce(s.data::text, '') from signals s where s.project_id = p.id order by s.occurred_at desc limit 1) as latest_signal_context,
              (select rv.status from report_versions rv where rv.project_id = p.id order by rv.version desc limit 1) as report_status,
              (select rv.version from report_versions rv where rv.project_id = p.id order by rv.version desc limit 1) as report_version,
              (select sd.decision from screening_decisions sd where sd.project_id = p.id order by sd.created_at desc limit 1) as screening_decision,
              (select sd.account_type from screening_decisions sd where sd.project_id = p.id order by sd.created_at desc limit 1) as screening_account_type,
              (select sd.reason from screening_decisions sd where sd.project_id = p.id order by sd.created_at desc limit 1) as screening_reason,
              (select am.actual_state from alpha_monitors am where am.project_id = p.id) as monitor_actual_state,
              (select am.desired_state from alpha_monitors am where am.project_id = p.id) as monitor_desired_state
       from projects p where p.id = $1`,
      [request.params.id]
    );
    const row = result.rows[0] as (ProjectRow & { created_at: string; updated_at: string; excluded_at: string | null; exclusion_reason: string | null; report_version: number | null }) | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { ...toProject(row), createdAt: row.created_at, updatedAt: row.updated_at, excludedAt: row.excluded_at, exclusionReason: row.exclusion_reason, reportVersion: row.report_version };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/projects/:id/exclude', async (request, reply) => {
    const result = await options.database.query<{ id: string }>(
      `update projects set status = 'excluded', excluded_at = now(), exclusion_reason = $2, updated_at = now()
       where id = $1 and status <> 'excluded' returning id`,
      [request.params.id, request.body?.reason ?? '人工排除']
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await options.database.query(
      `update jobs
       set status = 'dead', last_error = 'project excluded before deep research', updated_at = now()
       where type = 'research_project'
         and status in ('queued', 'retry')
         and coalesce(payload->>'projectId', ((payload #>> '{}')::jsonb)->>'projectId') = $1`,
      [request.params.id]
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/restore', async (request, reply) => {
    const result = await options.database.query<{ id: string }>(
      `update projects set status = 'screening', excluded_at = null, exclusion_reason = null, updated_at = now()
       where id = $1 and status = 'excluded' returning id`,
      [request.params.id]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { content?: string } }>('/api/projects/:id/notes', async (request, reply) => {
    const content = String(request.body?.content ?? '').trim();
    if (!content) return reply.code(400).send({ error: 'content_required' });
    const result = await options.database.query(
      `insert into personal_notes (project_id, content) values ($1, $2)
       returning id, project_id, content, created_at, updated_at`,
      [request.params.id, content]
    );
    return { item: result.rows[0] };
  });
}
