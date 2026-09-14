-- 账号搜索的索引（M5 压测发现的问题）。
--
-- 现象：`lower(project_key) LIKE '%关键词%'` 这类前置通配符无法使用 B-tree 索引，
-- 在 10 万项目的合成数据上退化为全表扫描（实测单次约 32ms），
-- 10 个并发会话的混合查询把列表 p95 推到 832ms，逼近 1 秒目标。
--
-- 处理：启用 pg_trgm 并对归一化账号与展示名建 GIN 索引，让中缀匹配可走索引。
-- 备选方案是把搜索语义收紧为前缀匹配（`LIKE '关键词%'`），但那会改变用户可感知的搜索行为，
-- 属于产品决策而非实现细节，因此这里选择不改变语义的索引方案。

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS projects_project_key_trgm_idx
  ON projects USING gin (lower(project_key) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS projects_display_name_trgm_idx
  ON projects USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);

COMMIT;
