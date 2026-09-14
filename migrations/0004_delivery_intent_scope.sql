-- 修正投递意图唯一键：必须包含 report_id。
-- 原键 (purpose, target_chat_id, target_thread_message_id, shard_index) 会让“同项目不同报告发往同一目标”
-- 被误判为同一意图，导致后一份报告的投递记录被静默丢弃（第 5 节要求投递以业务目的 + 目标 + 分片保证唯一，
-- 但报告维度是意图的一部分：标准报告与恢复后的新报告是两次不同的投递）。

BEGIN;

DROP INDEX IF EXISTS delivery_intent_key;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_intent_key
  ON delivery_records (
    purpose,
    coalesce(report_id, ''),
    coalesce(target_chat_id, ''),
    coalesce(target_thread_message_id, 0),
    shard_index
  );

COMMIT;
