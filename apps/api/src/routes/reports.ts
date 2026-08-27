import type { FastifyInstance } from 'fastify';
import type { ApiDatabase } from '../types.js';

/** Hide internal research sections from legacy stored reports at read time. */
function publicReportMarkdown(markdown: string | null): string | null {
  if (!markdown) return markdown;
  const marker = /(?:^|\n)##\s+[^\n]*(?:核心论点|参与玩法|L2 六赛道深挖|独立复核轮|评分总览|风险与证据链)[^\n]*/u;
  const match = marker.exec(markdown);
  return match ? markdown.slice(0, match.index).trimEnd() : markdown;
}

export function registerReportRoutes(app: FastifyInstance, options: { database: ApiDatabase }): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/reports', async (request) => {
    const eligible = await options.database.query<{ id: string }>(
      `select p.id from projects p
       where p.id = $1 and p.status <> 'excluded'
         and exists (
           select 1 from screening_decisions sd
           where sd.project_id = p.id
             and sd.decision in ('allowed', 'manual_allowed')
           and sd.account_type not in ('KOL', 'PERSONAL', 'DEV', 'MEDIA', 'TRADFI')
             and sd.created_at = (select max(sd2.created_at) from screening_decisions sd2 where sd2.project_id = p.id)
         )`,
      [request.params.id]
    );
    if (!eligible.rows[0]) return { items: [] };
    const result = await options.database.query(
      `select id, version, status, change_summary, created_at, completed_at
       from report_versions where project_id = $1 order by version desc`,
      [request.params.id]
    );
    return { items: result.rows };
  });

  app.get<{ Params: { id: string; version: string } }>('/api/projects/:id/reports/:version', async (request, reply) => {
    const version = Number.parseInt(request.params.version, 10);
    if (!Number.isInteger(version) || version < 1) return reply.code(400).send({ error: 'invalid_version' });
    const eligible = await options.database.query<{ id: string }>(
      `select p.id from projects p
       where p.id = $1 and p.status <> 'excluded'
         and exists (
           select 1 from screening_decisions sd
           where sd.project_id = p.id
             and sd.decision in ('allowed', 'manual_allowed')
           and sd.account_type not in ('KOL', 'PERSONAL', 'DEV', 'MEDIA', 'TRADFI')
             and sd.created_at = (select max(sd2.created_at) from screening_decisions sd2 where sd2.project_id = p.id)
         )`,
      [request.params.id]
    );
    if (!eligible.rows[0]) return reply.code(404).send({ error: 'not_found' });
    const result = await options.database.query<{
      id: string; version: number; status: string; structured_document: unknown;
      rendered_markdown: string | null; change_summary: unknown; created_at: string; completed_at: string | null;
    }>(
      `select id, version, status, structured_document, rendered_markdown, change_summary, created_at, completed_at
       from report_versions where project_id = $1 and version = $2`,
      [request.params.id, version]
    );
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { item: { ...row, rendered_markdown: publicReportMarkdown(row.rendered_markdown) } };
  });
}
