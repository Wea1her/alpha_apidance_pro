import { Pool, type PoolClient, type PoolConfig } from 'pg';

/**
 * PostgreSQL 连接与事务工具。
 *
 * 约束（第 5 节、第 8 节）：
 * - API 与 worker 通过数据库共享状态，不各自维护内存副本。
 * - 网络请求不占用长事务；事务只在业务写入与约束校验期间持有。
 * - 连接串来自环境变量，代码里不硬编码凭证。
 */

export interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

export interface StoragePool extends Queryable {
  /** 在单个事务中执行；抛错自动回滚。 */
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreatePoolOptions {
  connectionString?: string;
  max?: number;
  applicationName?: string;
  /** 允许测试注入自定义 Pool 配置。 */
  poolConfig?: PoolConfig;
}

const DEFAULT_APPLICATION_NAME = 'daxinjiankong';

export function createStoragePool(options: CreatePoolOptions = {}): StoragePool {
  const pool = new Pool({
    ...(options.poolConfig ?? {}),
    ...(options.connectionString ? { connectionString: options.connectionString } : {}),
    max: options.max ?? 10,
    application_name: options.applicationName ?? DEFAULT_APPLICATION_NAME,
  });

  const wrap = (source: Pool | PoolClient): Queryable => ({
    async query(sql: string, params?: readonly unknown[]) {
      const result = await source.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount };
    },
  });

  return {
    ...wrap(pool),
    async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // 回滚失败不应掩盖原始错误。
        }
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/** 从环境变量解析连接串；未配置时返回 null，由调用方决定是否降级或报错。 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.DATABASE_URL?.trim();
  return value && value.length > 0 ? value : null;
}
