-- 记录项目最近一次判定使用的旧去重键原文。
-- 用途：判定落库后，同一去重键再次到达时可快速回查所属项目（重复事件），
-- 同时保留与旧系统的对比锚点（Q31 要求保留 legacy dedupeKey 原文）。
--
-- 说明：0001 基线已包含该列；本迁移用于已在旧基线上运行过的环境（ADD COLUMN IF NOT EXISTS 为幂等）。

BEGIN;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS legacy_dedupe_key text;
CREATE INDEX IF NOT EXISTS projects_legacy_dedupe_key_idx
  ON projects (legacy_dedupe_key) WHERE legacy_dedupe_key IS NOT NULL;

COMMIT;
