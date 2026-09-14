-- 任务重试预算：失败后进入带退避的等待，而不是每轮都被立刻重新领取。
-- 与租约（lease_*）配合：租约过期 = 执行者失联，可被其他 worker 接管；
-- next_attempt_at = 主动退避，到点前任何 worker 都不应领取。

BEGIN;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
-- 领取候选：等待中的任务到点后才可领取；索引同时覆盖按时间排序的“最久等待”指标。
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (next_attempt_at, created_at) WHERE stage IN ('queued', 'failed');

COMMIT;
