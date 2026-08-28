import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '@alpha-research/db';
import { registerReportRoutes } from '../src/routes/reports.js';

describe('public report routes', () => {
  const databases: PGlite[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  it('hides the legacy project background section from stored reports', async () => {
    const database = new PGlite(); databases.push(database); await migrateDatabase(database);
    const project = await database.query<{ id: string }>(`insert into projects (x_user_id, current_handle, status) values ('report-user', 'report_user', 'active') returning id`);
    await database.query(`insert into screening_decisions (project_id, decision, account_type, reason) values ($1, 'allowed', 'PROJECT', '项目账号')`, [project.rows[0].id]);
    await database.query(`insert into report_versions (project_id, version, status, structured_document, rendered_markdown) values ($1, 1, 'ready', $2::jsonb, $3)`, [project.rows[0].id, JSON.stringify({ coreInfo: { projectName: 'Report', background: '旧背景' } }), '# Report\n\n## 一、项目核心信息\n\n摘要\n\n## 二、项目背景\n\n旧背景\n\n## 三、当前进展\n\n最近帖子\n\n## 四、优点\n\n优势\n\n## 五、缺点\n\n不足\n\n## 六、关注理由\n\n理由\n\n## 七、标签\n\n标签']);
    await database.query(`insert into report_versions (project_id, version, status, structured_document, rendered_markdown) values ($1, 2, 'ready', $2::jsonb, $3)`, [project.rows[0].id, JSON.stringify({ coreInfo: { projectName: 'Report', background: '不应展示' } }), '# Report\n\n## 一、项目核心信息\n\n摘要\n\n## 二、当前进展\n\n最近帖子']);
    const app = Fastify(); apps.push(app); registerReportRoutes(app, { database }); await app.ready();
    const response = await app.inject({ method: 'GET', url: `/api/projects/${project.rows[0].id}/reports/2` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ item: { rendered_markdown: string; structured_document: { coreInfo: Record<string, unknown> } } }>().item.rendered_markdown).not.toContain('项目背景');
    expect(response.json<{ item: { rendered_markdown: string } }>().item.rendered_markdown).toContain('## 二、当前进展');
    expect(response.json<{ item: { structured_document: { coreInfo: Record<string, unknown> } } }>().item.structured_document.coreInfo).not.toHaveProperty('background');
  });
});
