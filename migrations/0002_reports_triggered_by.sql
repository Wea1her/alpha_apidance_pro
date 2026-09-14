-- 修正 reports 的唯一性语义：恢复后新建的标准分析报告必须能与原报告并存（Q126）。
-- 原 0001 的 reports_project_kind_key 会阻止这一点；改为只约束“自然触发”的报告。
--
-- 兼容策略：如果 0001 已经在既有环境应用过，这里用条件 DDL 迁移；
-- 全新环境先执行 0001 再执行本文件，结果一致。

BEGIN;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS triggered_by text NOT NULL DEFAULT 'natural';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_triggered_by_valid'
  ) THEN
    ALTER TABLE reports
      ADD CONSTRAINT reports_triggered_by_valid CHECK (triggered_by IN ('natural', 'restore'));
  END IF;
END $$;

-- 丢弃旧的“每项目每类型唯一”，替换为仅约束自然报告的部分唯一索引。
DROP INDEX IF EXISTS reports_project_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS reports_project_kind_natural_key
  ON reports (project_id, kind) WHERE triggered_by = 'natural';
CREATE INDEX IF NOT EXISTS reports_triggered_by_idx ON reports (triggered_by, generated_at DESC);

COMMIT;
