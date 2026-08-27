import { JobStore, type JobRecord, type PostgresDatabase } from '@alpha-research/db';

export type JobHandler = (job: JobRecord) => Promise<void>;

export interface WorkerRunnerOptions {
  workerId: string;
  pollMs?: number;
  lockTimeoutMs?: number;
  concurrency?: number;
  jobTypes?: readonly string[];
  handlers: Readonly<Record<string, JobHandler>>;
}

export class WorkerRunner {
  private stopped = false;
  constructor(private readonly database: PostgresDatabase, private readonly options: WorkerRunnerOptions) {}

  stop(): void { this.stopped = true; }

  async runOnce(): Promise<boolean> {
    const jobs = new JobStore(this.database);
    await jobs.recoverAbandoned({ lockedBefore: new Date(Date.now() - (this.options.lockTimeoutMs ?? 10 * 60 * 1000)) });
    const job = await jobs.claim({ workerId: this.options.workerId, types: this.options.jobTypes });
    if (!job) return false;
    const handler = this.options.handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler registered for job type: ${job.type}`);
      await handler(job);
      await jobs.complete({ jobId: job.id, workerId: this.options.workerId });
    } catch (error) {
      console.error(`[worker] job failed type=${job.type} id=${job.id}`, error);
      await jobs.fail({ jobId: job.id, workerId: this.options.workerId, error: error instanceof Error ? error.message : String(error), retryDelayMs: 30_000 });
    }
    return true;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const worked = await this.runOnce();
      if (!worked) await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 1000));
    }
  }

  async run(): Promise<void> {
    // Multiple loops claim jobs with SELECT ... FOR UPDATE SKIP LOCKED, so
    // concurrency is safe and lets AI-heavy queues drain without changing the
    // exactly-once idempotency semantics of JobStore.
    const concurrency = Math.max(1, Math.min(16, Math.floor(this.options.concurrency ?? 1)));
    await Promise.all(Array.from({ length: concurrency }, () => this.runLoop()));
  }
}
