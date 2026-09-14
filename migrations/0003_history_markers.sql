-- 历史导入所需的两项结构：
-- 1) discussion_mappings：现存 8 条频道↔讨论群映射需要随历史事实一起迁移（Q15、Q47）。
-- 2) reports.report_generated_at_missing：归档记录里若无法解析生成时间，如实标记“时间缺失”，
--    不得用导入时间冒充当时的生成时间（第 10 节、Q15）。

BEGIN;

CREATE TABLE IF NOT EXISTS discussion_mappings (
  mapping_id text PRIMARY KEY,
  channel_chat_id text NOT NULL,
  channel_message_id bigint NOT NULL,
  discussion_chat_id text NOT NULL,
  discussion_message_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discussion_mappings_channel_key
  ON discussion_mappings (channel_chat_id, channel_message_id);

ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_generated_at_missing boolean NOT NULL DEFAULT false;

COMMIT;
