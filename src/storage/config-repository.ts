import type { StoragePool } from './client.js';
import {
  buildConfigVersionSnapshot,
  configSnapshotsEqual,
  hashConfigSnapshot,
  type ConfigVersionInput,
} from '../../shared/config-version.js';
import type { ConfigVersionSnapshot } from '../../shared/domain.js';

/**
 * 配置版本仓储：把“当时生效的参数”固化下来，供判定记录引用与页面展示。
 *
 * 依据：
 * - 第 3 节结论：本地阈值与代码默认不一致，只展示默认值会误导排查；
 * - 第 5 节“配置版本”实体：生效的非敏感配置快照 + 生效时间，凭证只保留服务端引用；
 * - Q38：每条判定都必须能回答“当时用的是哪套规则”；
 * - Q102：页面需要配置变更时间线 + 前后对比。
 *
 * 约束：快照只包含 shared/config-version.ts 白名单里的字段，写库前不再补任何凭证。
 */

export interface ConfigVersionRow {
  configVersionId: string;
  hash: string;
  effectiveAt: string;
  snapshot: ConfigVersionSnapshot;
  changedFields: string[];
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/** 比较两个快照的差异字段，用于页面“前后对比”。 */
export function diffSnapshots(previous: ConfigVersionSnapshot | null, next: ConfigVersionSnapshot): string[] {
  if (!previous) return ['（首次记录）'];
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof ConfigVersionSnapshot>;
  const changed: string[] = [];
  for (const key of keys) {
    const before = JSON.stringify(previous[key] ?? null);
    const after = JSON.stringify(next[key] ?? null);
    if (before !== after) changed.push(String(key));
  }
  return changed;
}

/**
 * 记录配置版本。配置未变化时不产生新版本，返回既有版本（幂等）。
 *
 * `input` 来自调用方解析后的配置；本函数不读取环境变量。
 */
export async function recordConfigVersion(
  pool: StoragePool,
  input: { config: ConfigVersionInput; effectiveAt?: Date }
): Promise<{ record: ConfigVersionRow; created: boolean }> {
  const snapshot = buildConfigVersionSnapshot(input.config);
  const hash = hashConfigSnapshot(snapshot);
  const effectiveAt = (input.effectiveAt ?? new Date()).toISOString();

  return pool.transaction(async (client) => {
    const existing = await client.query(
      `SELECT config_version_id, content_hash, effective_at, snapshot FROM config_versions
        WHERE content_hash = $1 LIMIT 1`,
      [hash]
    );
    const row = existing.rows[0];
    if (row) {
      return {
        record: {
          configVersionId: String(row.config_version_id),
          hash: String(row.content_hash),
          effectiveAt: toIso(row.effective_at) ?? effectiveAt,
          snapshot: row.snapshot as ConfigVersionSnapshot,
          changedFields: [],
        },
        created: false,
      };
    }

    const previous = await client.query(
      `SELECT snapshot FROM config_versions ORDER BY effective_at DESC, config_version_id DESC LIMIT 1`
    );
    const previousSnapshot = (previous.rows[0]?.snapshot as ConfigVersionSnapshot | undefined) ?? null;
    const configVersionId = `cfg_${hash}`;

    await client.query(
      `INSERT INTO config_versions (config_version_id, content_hash, effective_at, snapshot)
       VALUES ($1, $2, $3::timestamptz, $4::jsonb)
       ON CONFLICT (content_hash) DO NOTHING`,
      [configVersionId, hash, effectiveAt, JSON.stringify(snapshot)]
    );

    return {
      record: {
        configVersionId,
        hash,
        effectiveAt,
        snapshot,
        changedFields: diffSnapshots(previousSnapshot, snapshot),
      },
      created: true,
    };
  });
}

/** 配置变更时间线（Q102）：按生效时间倒序，带前后差异字段。 */
export async function listConfigVersions(pool: StoragePool, limit = 50): Promise<ConfigVersionRow[]> {
  const result = await pool.query(
    `SELECT config_version_id, content_hash, effective_at, snapshot
       FROM config_versions ORDER BY effective_at DESC, config_version_id DESC LIMIT $1`,
    [limit]
  );
  const rows = result.rows;
  // 时间线是倒序的：第 i 条的前一版是 i+1 条（更早）。
  return rows.map((row, index) => {
    const previous = (rows[index + 1]?.snapshot as ConfigVersionSnapshot | undefined) ?? null;
    const snapshot = row.snapshot as ConfigVersionSnapshot;
    return {
      configVersionId: String(row.config_version_id),
      hash: String(row.content_hash),
      effectiveAt: toIso(row.effective_at) ?? '',
      snapshot,
      // 最新一条比较的是“当前”，差异应显示为 0；这里如实计算相邻版本差异。
      changedFields: diffSnapshots(previous, snapshot),
    };
  });
}

/** 当前生效版本（最近一次记录）。 */
export async function readCurrentConfigVersion(pool: StoragePool): Promise<ConfigVersionRow | null> {
  const rows = await listConfigVersions(pool, 1);
  return rows[0] ?? null;
}

export { configSnapshotsEqual };
