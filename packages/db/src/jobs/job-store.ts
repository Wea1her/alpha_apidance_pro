export interface JobDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface EnqueueJobInput {
  type: string;
  idempotencyKey: string;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
}

export interface JobRecord {
  id: string;
  type: string;
  priority: number;
  status: 'queued' | 'running' | 'retry' | 'succeeded' | 'dead';
  idempotencyKey: string;
  payload: unknown;
}

export interface ClaimJobInput {
  workerId: string;
  now?: Date;
  types?: readonly string[];
}

export interface FailJobInput {
  jobId: string;
  workerId: string;
  error: string;
  retryDelayMs: number;
  now?: Date;
}

export interface CompleteJobInput {
  jobId: string;
  workerId: string;
  now?: Date;
}

export interface RecoverAbandonedJobsInput {
  lockedBefore: Date;
  now?: Date;
}

interface JobRow {
  id: string;
  type: string;
  priority: number;
  status: JobRecord['status'];
  idempotency_key: string;
  payload: unknown;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    priority: row.priority,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    payload: row.payload
  };
}

export class JobStore {
  constructor(private readonly database: JobDatabase) {}

  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const inserted = await this.database.query<JobRow>(
      `insert into jobs (
         type, priority, idempotency_key, payload, max_attempts, run_after
       ) values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (idempotency_key) do nothing
       returning id, type, priority, status, idempotency_key, payload`,
      [
        input.type,
        input.priority ?? 100,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        input.maxAttempts ?? 10,
        input.runAfter ?? new Date()
      ]
    );

    if (inserted.rows[0]) return toJobRecord(inserted.rows[0]);

    const existing = await this.database.query<JobRow>(
      `select id, type, priority, status, idempotency_key, payload
       from jobs
       where idempotency_key = $1`,
      [input.idempotencyKey]
    );
    if (!existing.rows[0]) {
      throw new Error(`Job disappeared after idempotent enqueue: ${input.idempotencyKey}`);
    }
    return toJobRecord(existing.rows[0]);
  }

  async claim(input: ClaimJobInput): Promise<JobRecord | null> {
    const now = input.now ?? new Date();
    const typeClause = input.types?.length ? 'and type = any($3::text[])' : '';
    const params: unknown[] = input.types?.length ? [now, input.workerId, [...input.types]] : [now, input.workerId];
    const claimed = await this.database.query<JobRow>(
      `with next_job as (
         select id
         from jobs
         where status in ('queued', 'retry')
           and run_after <= $1
           ${typeClause}
       -- Keep fresh account screening close to real time even while an older
       -- backlog is draining. Other job types retain FIFO ordering.
       order by priority asc,
                case when type = 'screen_account' and created_at > ($1::timestamptz - interval '10 minutes') then 0 else 1 end asc,
                case when type = 'screen_account' then created_at end desc nulls last,
                created_at asc
         for update skip locked
         limit 1
       )
       update jobs
       set status = 'running',
           attempts = attempts + 1,
           locked_at = $1,
           locked_by = $2,
           updated_at = $1
       from next_job
       where jobs.id = next_job.id
       returning jobs.id, jobs.type, jobs.priority, jobs.status,
                 jobs.idempotency_key, jobs.payload`,
      params
    );
    return claimed.rows[0] ? toJobRecord(claimed.rows[0]) : null;
  }

  async fail(input: FailJobInput): Promise<JobRecord> {
    const now = input.now ?? new Date();
    const failed = await this.database.query<JobRow>(
      `update jobs
       set status = case when attempts >= max_attempts then 'dead' else 'retry' end,
           run_after = case
             when attempts >= max_attempts then run_after
             else $1::timestamptz + ($4::integer * interval '1 millisecond')
           end,
           locked_at = null,
           locked_by = null,
           last_error = $3,
           updated_at = $1
       where id = $2
         and status = 'running'
         and locked_by = $5
       returning id, type, priority, status, idempotency_key, payload`,
      [now, input.jobId, input.error, input.retryDelayMs, input.workerId]
    );
    if (!failed.rows[0]) {
      throw new Error(`Running job is not owned by worker: ${input.jobId}`);
    }
    return toJobRecord(failed.rows[0]);
  }

  async complete(input: CompleteJobInput): Promise<void> {
    const completed = await this.database.query<{ id: string }>(
      `update jobs
       set status = 'succeeded',
           locked_at = null,
           locked_by = null,
           last_error = null,
           updated_at = $1
       where id = $2
         and status = 'running'
         and locked_by = $3
       returning id`,
      [input.now ?? new Date(), input.jobId, input.workerId]
    );
    if (!completed.rows[0]) {
      throw new Error(`Running job is not owned by worker: ${input.jobId}`);
    }
  }

  async recoverAbandoned(input: RecoverAbandonedJobsInput): Promise<number> {
    const recovered = await this.database.query<{ id: string }>(
      `update jobs
       set status = 'retry',
           run_after = $1,
           locked_at = null,
           locked_by = null,
           last_error = 'worker lock expired',
           updated_at = $1
       where status = 'running'
         and locked_at < $2
       returning id`,
      [input.now ?? new Date(), input.lockedBefore]
    );
    return recovered.rows.length;
  }
}
