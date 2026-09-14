import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import {
  buildRestoreJobId,
  excludeProject,
  listExcludedProjects,
  restoreProject
} from '../src/storage/pool-actions.js';

/**
 * 排除与恢复的集成测试（Q132-Q136）。
 * 需要真实 PostgreSQL；不可用时全部跳过。
 */

let pool: StoragePool | null = null;
let available = false;

function itDb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!available) return;
    await fn();
  });
}

beforeAll(async () => {
  pool = await openTestDatabase();
  available = pool !== null;
  if (available) await resetSchemaAndMigrate(pool!);
});

beforeEach(async () => {
  if (!available) return;
  await pool!.query('TRUNCATE projects, jobs, decisions, inbound_events, audit_records RESTART IDENTITY CASCADE');
});

afterAll(async () => {
  if (pool) await pool.close();
});

async function seedProject(star = 3): Promise<string> {
  const projectId = 'proj-action';
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, display_name, link, source, pool_state, star, display_push_count)
     VALUES ($1, 'actionproject', 'Action Project', 'https://x.com/actionproject', 'natural', 'monitored', $2, 1)`,
    [projectId, star]
  );
  return projectId;
}

async function seedDecision(projectId: string, eventId: string, reasonCode: string): Promise<void> {
  await pool!.query(
    `INSERT INTO inbound_events (event_id, collector_id, ingest_seq, received_at, raw_payload)
     VALUES ($1, 'collector-action', $2, now(), '{}')`,
    [eventId, Math.floor(Math.random() * 100000)]
  );
  await pool!.query(
    `INSERT INTO decisions (decision_id, event_id, project_id, project_key, reason_code, decided_at)
     VALUES ($1, $2, $3, 'actionproject', $4, now())`,
    [`dec-${eventId}`, eventId, projectId, reasonCode]
  );
}

describe('排除动作', () => {
  itDb('把监控中的项目移入排除池，并记录当时星级与事件数', async () => {
    const projectId = await seedProject(3);
    await seedDecision(projectId, 'evt-a', 'PUSHED');
    await seedDecision(projectId, 'evt-b', 'BELOW_THRESHOLD');

    const result = await excludeProject(pool!, { projectId, reason: 'manual', now: new Date('2026-09-14T05:00:00.000Z') });
    expect(result).toMatchObject({ applied: true, alreadyExcluded: false, excludedStar: 3, excludedEventCount: 2 });

    const row = await pool!.query(
      `SELECT pool_state, exclusion_reason, excluded_at, excluded_star, excluded_event_count, restore_reason
       FROM projects WHERE project_id = $1`,
      [projectId]
    );
    expect(row.rows[0]).toMatchObject({
      pool_state: 'excluded',
      exclusion_reason: 'manual',
      excluded_star: 3,
      excluded_event_count: 2,
      restore_reason: null
    });
    expect(row.rows[0]?.excluded_at).not.toBeNull();
  });

  itDb('重复排除是幂等的，不重复写审计', async () => {
    const projectId = await seedProject();
    const first = await excludeProject(pool!, { projectId, reason: 'manual' });
    const second = await excludeProject(pool!, { projectId, reason: 'manual' });
    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, alreadyExcluded: true });

    const audits = await pool!.query(`SELECT count(*)::int AS c FROM audit_records WHERE action = 'project.exclude'`);
    expect(audits.rows[0]?.c).toBe(1);
  });

  itDb('排除终止未执行的任务，但保留运行中的任务（Q133）', async () => {
    const projectId = await seedProject();
    await pool!.query(
      `INSERT INTO jobs (job_id, kind, project_id, stage, triggered_by) VALUES
        ('job-queued', 'classification', $1, 'queued', 'natural'),
        ('job-waiting', 'delivery', $1, 'waiting_dependency', 'natural'),
        ('job-running', 'classification', $1, 'running', 'natural')`,
      [projectId]
    );

    const result = await excludeProject(pool!, { projectId, reason: 'classification' });
    expect(result.cancelledJobs).toBe(2);

    const jobs = await pool!.query(`SELECT job_id, stage, last_error FROM jobs WHERE project_id = $1 ORDER BY job_id`, [
      projectId
    ]);
    expect(jobs.rows.map((row) => [row.job_id, row.stage])).toEqual([
      ['job-queued', 'dead_letter'],
      ['job-running', 'running'],
      ['job-waiting', 'dead_letter']
    ]);
    expect(String(jobs.rows[0]?.last_error)).toContain('排除池');
  });

  itDb('排除写入不含身份的审计记录（Q50、Q75）', async () => {
    const projectId = await seedProject();
    await excludeProject(pool!, { projectId, reason: 'manual', note: '项目方跑路' });
    const audit = await pool!.query(`SELECT action, target_type, target_id, before_summary, after_summary FROM audit_records`);
    expect(audit.rows[0]).toMatchObject({
      action: 'project.exclude',
      target_type: 'project',
      target_id: projectId,
      before_summary: 'monitored/star=3/events=0',
      after_summary: 'excluded/manual/项目方跑路'
    });
  });
});

describe('恢复动作', () => {
  itDb('规则拦截的项目可以恢复，无需理由，并新建一次标准分析任务', async () => {
    const projectId = await seedProject();
    await excludeProject(pool!, { projectId, reason: 'classification', now: new Date('2026-09-14T05:00:00.000Z') });

    const result = await restoreProject(pool!, { projectId, now: new Date('2026-09-14T06:00:00.000Z') });
    expect(result).toMatchObject({ applied: true, alreadyMonitored: false, requiredReason: false, jobCreated: true });
    expect(result.jobId).toBe(buildRestoreJobId(projectId));

    const project = await pool!.query(`SELECT pool_state, exclusion_reason, excluded_at, source, restore_reason FROM projects WHERE project_id = $1`, [
      projectId
    ]);
    expect(project.rows[0]).toMatchObject({ pool_state: 'monitored', exclusion_reason: null, excluded_at: null, source: 'restored' });

    const job = await pool!.query(`SELECT kind, stage, triggered_by FROM jobs WHERE job_id = $1`, [result.jobId]);
    expect(job.rows[0]).toMatchObject({ kind: 'standard', stage: 'queued', triggered_by: 'restore' });

    // 两次动作使用不同时间戳，保证审计顺序可判定（Q50：审计只记时间与动作）。
    const audit = await pool!.query(`SELECT action, occurred_at FROM audit_records ORDER BY occurred_at, audit_id`);
    expect(audit.rows.map((row) => row.action)).toEqual(['project.exclude', 'project.restore']);
  });

  itDb('人工排除的项目恢复必须填写理由（Q136）', async () => {
    const projectId = await seedProject();
    await excludeProject(pool!, { projectId, reason: 'manual' });

    await expect(restoreProject(pool!, { projectId })).rejects.toThrow(/必须填写恢复理由/);

    const result = await restoreProject(pool!, { projectId, reason: '项目方已澄清并提交证明' });
    expect(result.applied).toBe(true);
    const project = await pool!.query(`SELECT restore_reason, source FROM projects WHERE project_id = $1`, [projectId]);
    expect(project.rows[0]).toMatchObject({ restore_reason: '项目方已澄清并提交证明', source: 'restored' });
  });

  itDb('重复恢复是幂等的，复用同一任务', async () => {
    const projectId = await seedProject();
    await excludeProject(pool!, { projectId, reason: 'classification' });

    const first = await restoreProject(pool!, { projectId });
    const second = await restoreProject(pool!, { projectId });
    expect(first.jobCreated).toBe(true);
    expect(second).toMatchObject({ applied: false, alreadyMonitored: true });

    const jobs = await pool!.query(`SELECT count(*)::int AS c FROM jobs WHERE project_id = $1`, [projectId]);
    expect(jobs.rows[0]?.c).toBe(1);
  });

  itDb('历史导入的项目保留来源，不被恢复动作改写成 restored', async () => {
    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star, excluded_at, exclusion_reason)
       VALUES ('proj-history', 'historyproject', 'history_import', 'excluded', 2, now(), 'classification')`
    );
    await restoreProject(pool!, { projectId: 'proj-history' });
    const project = await pool!.query(`SELECT source, pool_state FROM projects WHERE project_id = 'proj-history'`);
    expect(project.rows[0]).toMatchObject({ source: 'history_import', pool_state: 'monitored' });
  });
});

describe('排除列表', () => {
  itDb('按进入原因区分规则拦截与人工排除，并带出最近原因码', async () => {
    const manual = await seedProject(2);
    await seedDecision(manual, 'evt-manual', 'CLASSIFY_BLOCKED');
    await excludeProject(pool!, { projectId: manual, reason: 'manual' });

    await pool!.query(
      `INSERT INTO projects (project_id, project_key, source, pool_state, star, excluded_at, exclusion_reason, excluded_star, excluded_event_count)
       VALUES ('proj-blocked', 'blockedproject', 'natural', 'excluded', 0, now(), 'classification', 1, 4)`
    );

    const rows = await listExcludedProjects(pool!);
    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((row) => [row.projectId, row]));
    expect(byId['proj-action']).toMatchObject({
      exclusionReason: 'manual',
      excludedStar: 2,
      excludedEventCount: 1,
      latestReasonCode: 'CLASSIFY_BLOCKED'
    });
    expect(byId['proj-blocked']).toMatchObject({ exclusionReason: 'classification', excludedEventCount: 4 });
  });

  itDb('没有排除项目时返回空列表', async () => {
    await seedProject();
    expect(await listExcludedProjects(pool!)).toEqual([]);
  });
});
