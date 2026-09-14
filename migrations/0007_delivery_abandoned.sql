-- 投递预算耗尽（第 8.1 节：单条可恢复故障最多 20 次自动尝试，之后告警并保留待处理记录）。
-- 与“已送达”（sent_at 非空）区分：abandoned 表示不再自动重试，但记录仍保留供人工重放。

BEGIN;

ALTER TABLE delivery_records ADD COLUMN IF NOT EXISTS abandoned boolean NOT NULL DEFAULT false;
-- 待处理候选：未送达且未放弃，且退避到点。
CREATE INDEX IF NOT EXISTS delivery_claimable_idx
  ON delivery_records (next_attempt_at, created_at)
  WHERE sent_at IS NULL AND abandoned = false;

COMMIT;
