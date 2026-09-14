import { describe, expect, it } from 'vitest';
import {
  computeRpoMs,
  computeRtoMs,
  formatDrillReport,
  verifyBackupFile,
  verifyRestore,
  type BackupManifest,
  type CommandRunner
} from '../src/testing/backup-drill.js';

/**
 * 备份恢复演练（M5、第 10.1 节）纯逻辑测试。
 *
 * 重点：
 * - RPO 按“备份实际覆盖的数据时间点”计算，不用备份完成时间（第 10.1 节的明确要求）；
 * - 恢复核验不只看行数，还要内容指纹与迁移版本；
 * - 少于目标的 RPO/RTO 才算达标，任何核验差异都判未通过。
 */

const manifest: BackupManifest = {
  fileName: 'djk-test.dump.gpg',
  createdAt: '2026-09-14T10:00:00.000Z',
  coveredDataThrough: '2026-09-14T09:30:00.000Z',
  rowCounts: { projects: 3, inbound_events: 100, decisions: 100 },
  contentHash: 'hash-abc',
  encrypted: true,
  schemaMigrationVersions: ['0001', '0002']
};

describe('RPO 计算（第 10.1 节）', () => {
  it('按备份覆盖的数据时间点计算，而不是备份完成时间', () => {
    // 备份 10:00 完成，但只覆盖到 09:30；故障发生在 10:00 → 丢失 30 分钟
    const rpo = computeRpoMs({ coveredDataThrough: manifest.coveredDataThrough, failureAt: new Date('2026-09-14T10:00:00.000Z') });
    expect(rpo).toBe(30 * 60 * 1000);
  });

  it('若用完成时间算会得到 0 分钟，这正是要避免的误判', () => {
    const byCompletion = computeRpoMs({ coveredDataThrough: manifest.createdAt, failureAt: new Date('2026-09-14T10:00:00.000Z') });
    expect(byCompletion).toBe(0);
    const byCoverage = computeRpoMs({
      coveredDataThrough: manifest.coveredDataThrough,
      failureAt: new Date('2026-09-14T10:00:00.000Z')
    });
    expect(byCoverage).not.toBe(byCompletion);
  });

  it('没有数据或时间无效时返回 null，不假装 0', () => {
    expect(computeRpoMs({ coveredDataThrough: null, failureAt: new Date() })).toBeNull();
    expect(computeRpoMs({ coveredDataThrough: 'not-a-date', failureAt: new Date() })).toBeNull();
  });

  it('备份覆盖时间晚于故障时间时不会得到负数', () => {
    const rpo = computeRpoMs({ coveredDataThrough: '2026-09-14T11:00:00.000Z', failureAt: new Date('2026-09-14T10:00:00.000Z') });
    expect(rpo).toBe(0);
  });
});

describe('RTO 计算', () => {
  it('从恢复开始到校验完成', () => {
    const rto = computeRtoMs({
      recoveryStartedAt: new Date('2026-09-14T10:00:00.000Z'),
      verifiedAt: new Date('2026-09-14T10:45:00.000Z')
    });
    expect(rto).toBe(45 * 60 * 1000);
  });

  it('时间倒置时不会返回负数', () => {
    expect(
      computeRtoMs({
        recoveryStartedAt: new Date('2026-09-14T10:00:00.000Z'),
        verifiedAt: new Date('2026-09-14T09:00:00.000Z')
      })
    ).toBe(0);
  });
});

describe('恢复核验', () => {
  it('行数、指纹、迁移版本三者一致才算通过', () => {
    const result = verifyRestore(manifest, {
      rowCounts: { ...manifest.rowCounts },
      contentHash: manifest.contentHash,
      coveredDataThrough: manifest.coveredDataThrough,
      schemaMigrationVersions: [...manifest.schemaMigrationVersions]
    });
    expect(result).toMatchObject({ countsMatch: true, hashMatch: true, migrationsMatch: true });
    expect(result.differences).toEqual([]);
  });

  it('行数一致但内容指纹不同时判为不一致（行数相同不代表数据相同）', () => {
    const result = verifyRestore(manifest, {
      rowCounts: { ...manifest.rowCounts },
      contentHash: 'different-hash',
      coveredDataThrough: manifest.coveredDataThrough,
      schemaMigrationVersions: [...manifest.schemaMigrationVersions]
    });
    expect(result.countsMatch).toBe(true);
    expect(result.hashMatch).toBe(false);
    expect(result.differences.join()).toContain('内容指纹');
  });

  it('缺表或行数不符会列出具体差异', () => {
    const result = verifyRestore(manifest, {
      rowCounts: { projects: 3, inbound_events: 99 },
      contentHash: manifest.contentHash,
      coveredDataThrough: manifest.coveredDataThrough,
      schemaMigrationVersions: [...manifest.schemaMigrationVersions]
    });
    expect(result.countsMatch).toBe(false);
    expect(result.differences.join()).toContain('inbound_events');
    expect(result.differences.join()).toContain('decisions');
  });

  it('迁移版本不同会判为不一致', () => {
    const result = verifyRestore(manifest, {
      rowCounts: { ...manifest.rowCounts },
      contentHash: manifest.contentHash,
      coveredDataThrough: manifest.coveredDataThrough,
      schemaMigrationVersions: ['0001']
    });
    expect(result.migrationsMatch).toBe(false);
    expect(result.differences.join()).toContain('迁移版本');
  });
});

describe('演练报告', () => {
  const verification = verifyRestore(manifest, {
    rowCounts: { ...manifest.rowCounts },
    contentHash: manifest.contentHash,
    coveredDataThrough: manifest.coveredDataThrough,
    schemaMigrationVersions: [...manifest.schemaMigrationVersions]
  });

  it('RPO 与 RTO 都达标且核验通过时结论为通过', () => {
    const report = formatDrillReport({
      manifest,
      verification,
      rpoMs: 30 * 60 * 1000,
      rtoMs: 45 * 60 * 1000,
      backupBytes: 10 * 1024 * 1024
    });
    expect(report).toContain('**通过**');
    expect(report).toContain('30.0 分钟');
    expect(report).toContain('45.0 分钟');
    expect(report).toContain('RPO 按备份实际覆盖的数据时间点计算');
  });

  it('RPO 超 1 小时判未达标', () => {
    const report = formatDrillReport({
      manifest,
      verification,
      rpoMs: 90 * 60 * 1000,
      rtoMs: 10 * 60 * 1000,
      backupBytes: 1024
    });
    expect(report).toContain('**未通过**');
    expect(report).toMatch(/RPO.*未达标/);
  });

  it('核验有差异时即使 RPO/RTO 达标也判未通过', () => {
    const failed = verifyRestore(manifest, {
      rowCounts: { projects: 1 },
      contentHash: 'x',
      coveredDataThrough: null,
      schemaMigrationVersions: []
    });
    const report = formatDrillReport({
      manifest,
      verification: failed,
      rpoMs: 1000,
      rtoMs: 1000,
      backupBytes: 1024
    });
    expect(report).toContain('**未通过**');
    expect(report).toContain('行数一致：否');
  });

  it('没有数据可覆盖时 RPO 显示为无法计算，而不是 0', () => {
    const emptyManifest: BackupManifest = { ...manifest, coveredDataThrough: null, rowCounts: {} };
    const report = formatDrillReport({
      manifest: emptyManifest,
      verification: verifyRestore(emptyManifest, {
        rowCounts: {},
        contentHash: emptyManifest.contentHash,
        coveredDataThrough: null,
        schemaMigrationVersions: emptyManifest.schemaMigrationVersions
      }),
      rpoMs: computeRpoMs({ coveredDataThrough: null, failureAt: new Date() }),
      rtoMs: 1000,
      backupBytes: 1024
    });
    expect(report).toContain('无法计算');
    expect(report).toContain('未达标');
  });
});

describe('备份文件校验', () => {
  it('文件不存在或为空时抛错（不算合格备份）', async () => {
    await expect(verifyBackupFile('/tmp/definitely-missing-backup.dump')).rejects.toThrow();
  });

  it('正常文件返回大小与 sha256', async () => {
    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'djk-backup-'));
    const file = join(directory, 'sample.dump');
    await writeFile(file, 'fake-dump-content', 'utf8');
    const result = await verifyBackupFile(file);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toHaveLength(64);
  });
});

describe('备份命令编排（用假 runner 验证参数与流程）', () => {
  it('先 dump 再加密，且把“覆盖数据时间点”写进 manifest', async () => {
    const { createBackup } = await import('../src/testing/backup-drill.js');
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      // 模拟 pg_dump / gpg 生成文件
      if (command === 'pg_dump') {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(args[args.indexOf('--file') + 1]!, 'dump');
      }
      if (command === 'gpg') {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(args[args.indexOf('--output') + 1]!, 'encrypted');
      }
      return { stdout: '', stderr: '' };
    };

    const fakePool = {
      query: async (sql: string) => {
        if (sql.includes('count(*)')) return { rows: [{ c: 7 }], rowCount: 1 };
        if (sql.includes('max(received_at)')) {
          return { rows: [{ latest: new Date('2026-09-14T09:00:00.000Z') }], rowCount: 1 };
        }
        if (sql.includes('string_agg')) return { rows: [{ hash: 'h1' }], rowCount: 1 };
        return { rows: [{ version: '0001' }], rowCount: 1 };
      },
      transaction: async () => {
        throw new Error('未使用');
      },
      close: async () => undefined
    } as unknown as Parameters<typeof createBackup>[0];

    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'djk-backup-orchestration-'));

    const result = await createBackup(fakePool, {
      connectionString: 'postgres://example/db',
      outputDirectory: directory,
      now: new Date('2026-09-14T10:00:00.000Z'),
      passphrase: 'secret',
      runner
    });

    expect(calls.map((call) => call.command)).toEqual(['pg_dump', 'gpg']);
    expect(calls[0]?.args).toContain('--format=custom');
    expect(calls[1]?.args).toContain('--symmetric');
    expect(result.manifest).toMatchObject({
      encrypted: true,
      coveredDataThrough: '2026-09-14T09:00:00.000Z',
      contentHash: 'h1',
      schemaMigrationVersions: ['0001']
    });
    expect(result.manifest.fileName.endsWith('.dump.gpg')).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });
});
