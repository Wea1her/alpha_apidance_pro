import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoragePool } from '../src/storage/client.js';
import { openTestDatabase, resetSchemaAndMigrate } from './helpers/test-database.js';
import { previewDelivery, replayDelivery } from '../src/storage/delivery-replay.js';

/**
 * 投递重放（Q53、Q59）集成测试：需要真实 PostgreSQL；不可用时跳过。
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
  await pool!.query('TRUNCATE delivery_records, reports, projects, audit_records RESTART IDENTITY CASCADE');
  await pool!.query(
    `INSERT INTO projects (project_id, project_key, source, pool_state, star)
     VALUES ('proj-dlv', 'dlvproject', 'natural', 'monitored', 2)`
  );
  await pool!.query(
    `INSERT INTO reports (report_id, project_id, kind, body, generated_at)
     VALUES ('rep-dlv', 'proj-dlv', 'standard', '这是已保存的报告正文，重放时必须原样使用。', now())`
  );
});

afterAll(async () => {
  if (pool) await pool.close();
});

async function seedDelivery(options: { sent?: boolean; attempts?: number; updatedAt?: string } = {}): Promise<void> {
  const sentAt = options.sent ? '2026-09-14T00:00:00.000Z' : null;
  await pool!.query(
    `INSERT INTO delivery_records (delivery_id, project_id, report_id, purpose, target_chat_id, target_thread_message_id,
                                   shard_index, attempts, last_error, message_id, sent_at, updated_at)
     VALUES ('dlv-1', 'proj-dlv', 'rep-dlv', 'discussion_report', '-100999', 555, 1, $1, $2, $3, $4::timestamptz, $5::timestamptz)`,
    [
      options.attempts ?? 3,
      options.sent ? null : '讨论映射缺失',
      options.sent ? 4242 : null,
      sentAt,
      options.updatedAt ?? '2026-09-14T00:00:00.000Z'
    ]
  );
}

describe('投递预览', () => {
  itDb('给出目标、分片、正文摘要与历史尝试，可用于二次确认', async () => {
    await seedDelivery();
    const preview = await previewDelivery(pool!, {
      deliveryId: 'dlv-1',
      now: new Date('2026-09-14T01:00:00.000Z'),
      cooldownMs: 60_000
    });

    expect(preview).not.toBeNull();
    expect(preview).toMatchObject({
      deliveryId: 'dlv-1',
      reportId: 'rep-dlv',
      purpose: 'discussion_report',
      targetChatId: '-100999',
      targetThreadMessageId: 555,
      shardIndex: 1,
      attempts: 3,
      lastError: '讨论映射缺失',
      replayable: true,
      blockedBy: null
    });
    expect(preview?.bodyExcerpt).toContain('已保存的报告正文');
    expect(preview?.bodyLength).toBeGreaterThan(10);
  });

  itDb('不存在的投递返回 null', async () => {
    expect(await previewDelivery(pool!, { deliveryId: 'missing' })).toBeNull();
  });

  itDb('已确认送达的投递不可重放，并提示会产生重复', async () => {
    await seedDelivery({ sent: true });
    const preview = await previewDelivery(pool!, { deliveryId: 'dlv-1' });
    expect(preview).toMatchObject({ replayable: false, blockedBy: 'already_sent', alreadySent: true, messageId: 4242 });
  });

  itDb('冷却期内的投递不可重放，并给出可重放时间', async () => {
    await seedDelivery({ updatedAt: '2026-09-14T01:00:00.000Z' });
    const preview = await previewDelivery(pool!, {
      deliveryId: 'dlv-1',
      now: new Date('2026-09-14T01:01:00.000Z'),
      cooldownMs: 5 * 60_000
    });
    expect(preview).toMatchObject({ replayable: false, blockedBy: 'cooldown' });
    expect(preview?.cooldownEndsAt).toBe('2026-09-14T01:05:00.000Z');
  });
});

describe('投递重放', () => {
  itDb('必填原因：未提供理由时拒绝', async () => {
    await seedDelivery();
    const result = await replayDelivery(pool!, { deliveryId: 'dlv-1', reason: '   ' });
    expect(result).toMatchObject({ applied: false, rejection: 'reason_required' });
    const audits = await pool!.query(`SELECT count(*)::int AS c FROM audit_records`);
    expect(audits.rows[0]?.c).toBe(0);
  });

  itDb('重放把投递放回待处理并写审计，保留原意图与分片', async () => {
    await seedDelivery();
    const result = await replayDelivery(pool!, {
      deliveryId: 'dlv-1',
      reason: '讨论映射已修复',
      now: new Date('2026-09-14T02:00:00.000Z'),
      cooldownMs: 60_000
    });
    expect(result.applied).toBe(true);
    expect(result.auditId).not.toBeNull();

    const row = await pool!.query(
      `SELECT purpose, target_chat_id, target_thread_message_id, shard_index, next_attempt_at, uncertain, updated_at
       FROM delivery_records WHERE delivery_id = 'dlv-1'`
    );
    expect(row.rows[0]).toMatchObject({
      purpose: 'discussion_report',
      target_chat_id: '-100999',
      target_thread_message_id: '555',
      shard_index: 1,
      uncertain: true
    });
    expect(row.rows[0]?.next_attempt_at).not.toBeNull();

    const audit = await pool!.query(`SELECT action, target_id, after_summary FROM audit_records`);
    expect(audit.rows[0]).toMatchObject({ action: 'delivery.replay', target_id: 'dlv-1' });
    expect(String(audit.rows[0]?.after_summary)).toContain('讨论映射已修复');
  });

  itDb('冷却期内连点只生效一次（幂等）', async () => {
    await seedDelivery();
    const now = new Date('2026-09-14T03:00:00.000Z');
    const first = await replayDelivery(pool!, { deliveryId: 'dlv-1', reason: '第一次', now, cooldownMs: 5 * 60_000 });
    const second = await replayDelivery(pool!, {
      deliveryId: 'dlv-1',
      reason: '连点第二次',
      now: new Date(now.getTime() + 10_000),
      cooldownMs: 5 * 60_000
    });

    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, rejection: 'cooldown' });
    expect(second.cooldownEndsAt).toBe('2026-09-14T03:05:00.000Z');

    const audits = await pool!.query(`SELECT count(*)::int AS c FROM audit_records WHERE action = 'delivery.replay'`);
    expect(audits.rows[0]?.c).toBe(1);
  });

  itDb('冷却结束后可以再次重放，并记录历史次数', async () => {
    await seedDelivery();
    const first = new Date('2026-09-14T04:00:00.000Z');
    await replayDelivery(pool!, { deliveryId: 'dlv-1', reason: '第一次', now: first, cooldownMs: 60_000 });
    const second = await replayDelivery(pool!, {
      deliveryId: 'dlv-1',
      reason: '第二次',
      now: new Date(first.getTime() + 120_000),
      cooldownMs: 60_000
    });
    expect(second.applied).toBe(true);

    const preview = await previewDelivery(pool!, {
      deliveryId: 'dlv-1',
      now: new Date(first.getTime() + 120_000),
      cooldownMs: 60_000
    });
    expect(preview?.historyCount).toBe(2);
  });

  itDb('已确认送达的投递拒绝重放', async () => {
    await seedDelivery({ sent: true });
    const result = await replayDelivery(pool!, { deliveryId: 'dlv-1', reason: '想再发一次' });
    expect(result).toMatchObject({ applied: false, rejection: 'already_sent' });
  });

  itDb('不存在的投递拒绝重放', async () => {
    const result = await replayDelivery(pool!, { deliveryId: 'dlv-missing', reason: '随便' });
    expect(result).toMatchObject({ applied: false, rejection: 'not_found' });
  });
});
