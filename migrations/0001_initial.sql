-- M1 初始 schema：接收记录、判定记录、项目与监控池状态、报告、投递、审计、配置版本。
--
-- 依据：docs/architecture/frontend-migration.md 第 5 节数据模型与建议约束、Q45（逐事件原因码 + 快照，
-- 原始 payload 保留 90 天）、Q50（审计同库长期保留）、Q55（生成与投递分离）、Q96（展示序号与真实发送次数分离）、
-- Q123（CA 链标识 + 地址）、Q132（项目只有监控中/已排除两态）。
--
-- 保留策略：inbound_events 与 decisions 适用 90 天清理；projects / reports / delivery_records /
-- audit_records / config_versions 长期保留，清理不得级联删除它们。

BEGIN;

-- 幂等：重复执行迁移不应报错（迁移器已记录版本，这里再兜一层）。
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- 中缀搜索索引（见 0010 迁移与 M5 压测结论）。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============ 枚举 ============
-- 原因码取值由 shared/domain.ts 的 REASON_CODES 定义，应用层校验；数据库用 CHECK 兜底，避免脏值入库。
CREATE TABLE IF NOT EXISTS config_versions (
  config_version_id text PRIMARY KEY,
  content_hash text NOT NULL,
  effective_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_versions_hash_not_blank CHECK (length(btrim(content_hash)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS config_versions_hash_key ON config_versions (content_hash);

-- ============ 采集 ============
CREATE TABLE IF NOT EXISTS inbound_events (
  event_id text PRIMARY KEY,
  collector_id text NOT NULL,
  ingest_seq bigint NOT NULL,
  received_at timestamptz NOT NULL,
  upstream_push_at_sec bigint,
  raw_payload text NOT NULL,
  channel text,
  title text,
  link text,
  content text,
  common_follow_count integer,
  legacy_dedupe_key text,
  parse_error text,
  -- 判定完成后回填，便于按“是否已判定”巡检与重放。
  processed_at timestamptz,
  CONSTRAINT inbound_events_push_at_sane CHECK (upstream_push_at_sec IS NULL OR upstream_push_at_sec > 0),
  CONSTRAINT inbound_events_count_non_negative CHECK (common_follow_count IS NULL OR common_follow_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_events_collector_seq_key ON inbound_events (collector_id, ingest_seq);
CREATE INDEX IF NOT EXISTS inbound_events_received_at_idx ON inbound_events (received_at DESC);
CREATE INDEX IF NOT EXISTS inbound_events_project_lookup_idx ON inbound_events (link, upstream_push_at_sec);
CREATE INDEX IF NOT EXISTS inbound_events_pending_idx ON inbound_events (received_at) WHERE processed_at IS NULL;

-- ============ 项目与监控池 ============
CREATE TABLE IF NOT EXISTS projects (
  project_id text PRIMARY KEY,
  project_key text NOT NULL,
  display_name text,
  link text,
  source text NOT NULL,
  pool_state text NOT NULL,
  star integer NOT NULL DEFAULT 0,
  -- 频道展示序号；与真实发送次数是两回事（Q96）。
  display_push_count integer NOT NULL DEFAULT 0,
  confirmed_send_count integer NOT NULL DEFAULT 0,
  -- 历史数据缺失时保持 NULL，不得用本地归档时间顶替（Q15、Q45）。
  first_event_at timestamptz,
  last_event_at timestamptz,
  entered_pool_at timestamptz NOT NULL DEFAULT now(),
  excluded_at timestamptz,
  exclusion_reason text,
  excluded_star integer,
  excluded_event_count integer,
  restore_reason text,
  -- 最近一次判定使用的旧去重键原文；用于重复事件回查与跨系统对比（Q31）。
  legacy_dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_source_valid CHECK (source IN ('natural', 'restored', 'history_import')),
  CONSTRAINT projects_pool_state_valid CHECK (pool_state IN ('monitored', 'excluded')),
  -- 排除必须有原因；未排除不得带排除字段（Q132、Q134）。
  CONSTRAINT projects_exclusion_consistent CHECK (
    (pool_state = 'excluded' AND excluded_at IS NOT NULL AND exclusion_reason IN ('classification', 'manual'))
    OR (pool_state = 'monitored' AND exclusion_reason IS NULL)
  ),
  CONSTRAINT projects_star_non_negative CHECK (star >= 0),
  CONSTRAINT projects_counts_non_negative CHECK (display_push_count >= 0 AND confirmed_send_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_project_key_key ON projects (project_key);
CREATE INDEX IF NOT EXISTS projects_pool_state_idx ON projects (pool_state, star DESC);
CREATE INDEX IF NOT EXISTS projects_entered_pool_at_idx ON projects (entered_pool_at DESC);
CREATE INDEX IF NOT EXISTS projects_excluded_at_idx ON projects (excluded_at DESC) WHERE pool_state = 'excluded';
CREATE INDEX IF NOT EXISTS projects_legacy_dedupe_key_idx ON projects (legacy_dedupe_key) WHERE legacy_dedupe_key IS NOT NULL;
-- 账号搜索：中缀匹配也要走索引，否则 10 万项目会退化为全表扫描。
CREATE INDEX IF NOT EXISTS projects_project_key_trgm_idx ON projects USING gin (lower(project_key) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS projects_display_name_trgm_idx ON projects USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);

-- 输入的链接、展示名与账号标识分开保存（第 5 节要求），归一化后的 handle 作为检索键。
CREATE TABLE IF NOT EXISTS project_identifiers (
  project_id text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  kind text NOT NULL,
  normalized_value text NOT NULL,
  raw_value text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind, normalized_value),
  CONSTRAINT project_identifiers_kind_valid CHECK (kind IN ('handle', 'link', 'display_name'))
);
CREATE INDEX IF NOT EXISTS project_identifiers_lookup_idx ON project_identifiers (kind, normalized_value);

-- CA：链标识 + 地址双字段；未通过校验时只留原文片段（Q119、Q123）。
CREATE TABLE IF NOT EXISTS project_contract_addresses (
  project_id text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  chain text NOT NULL,
  address text NOT NULL,
  source text NOT NULL,
  raw_snippet text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, chain, address),
  CONSTRAINT project_ca_source_valid CHECK (source IN ('analysis', 'manual'))
);

-- ============ 判定记录 ============
CREATE TABLE IF NOT EXISTS decisions (
  decision_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES inbound_events (event_id) ON DELETE RESTRICT,
  project_id text REFERENCES projects (project_id) ON DELETE SET NULL,
  project_key text,
  reason_code text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  config_version_id text REFERENCES config_versions (config_version_id) ON DELETE SET NULL,
  star integer,
  previous_star integer,
  max_star integer,
  common_follow_count integer,
  star_levels integer[],
  is_repeat boolean NOT NULL DEFAULT false,
  in_flight boolean NOT NULL DEFAULT false,
  classification_type text,
  classification_confidence numeric(4, 3),
  classification_reason text,
  classification_model text,
  classification_error text,
  CONSTRAINT decisions_reason_code_not_blank CHECK (length(btrim(reason_code)) > 0),
  CONSTRAINT decisions_classification_confidence_range CHECK (
    classification_confidence IS NULL OR (classification_confidence >= 0 AND classification_confidence <= 1)
  ),
  -- 分类失败保守放行时不得伪造类型与置信度（Q38）。
  CONSTRAINT decisions_classification_error_consistent CHECK (
    (classification_error IS NULL OR classification_type IS NULL)
  )
);
-- 每条接收记录最多一条判定：重复判定会破坏“逐事件可解释”。
CREATE UNIQUE INDEX IF NOT EXISTS decisions_event_key ON decisions (event_id);
CREATE INDEX IF NOT EXISTS decisions_project_time_idx ON decisions (project_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS decisions_reason_time_idx ON decisions (reason_code, decided_at DESC);

-- ============ 报告（生成与投递解耦，Q55） ============
CREATE TABLE IF NOT EXISTS reports (
  report_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (project_id) ON DELETE RESTRICT,
  kind text NOT NULL,
  trigger_event_id text REFERENCES inbound_events (event_id) ON DELETE SET NULL,
  model text,
  prompt_version text,
  body text NOT NULL,
  generated_at timestamptz NOT NULL,
  triggered_by text NOT NULL DEFAULT 'natural',
  report_generated_at_missing boolean NOT NULL DEFAULT false,
  response_id text,
  reported_model text,
  input_tokens integer,
  output_tokens integer,
  server_side_tool_calls integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_kind_valid CHECK (kind IN ('standard', 'deep')),
  CONSTRAINT reports_triggered_by_valid CHECK (triggered_by IN ('natural', 'restore')),
  CONSTRAINT reports_usage_non_negative CHECK (
    (input_tokens IS NULL OR input_tokens >= 0)
    AND (output_tokens IS NULL OR output_tokens >= 0)
    AND (server_side_tool_calls IS NULL OR server_side_tool_calls >= 0)
  )
);
-- 每项目每类型只有一份**自然触发**的报告；重试复用同一记录，恢复触发的新建（Q126、Q130）。
CREATE UNIQUE INDEX IF NOT EXISTS reports_project_kind_natural_key ON reports (project_id, kind) WHERE triggered_by = 'natural';
CREATE INDEX IF NOT EXISTS reports_generated_at_idx ON reports (generated_at DESC);

-- ============ 投递（有条件的独立记录） ============
CREATE TABLE IF NOT EXISTS delivery_records (
  delivery_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (project_id) ON DELETE RESTRICT,
  report_id text REFERENCES reports (report_id) ON DELETE SET NULL,
  purpose text NOT NULL,
  target_chat_id text,
  target_thread_message_id bigint,
  shard_index integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  message_id bigint,
  sent_at timestamptz,
  uncertain boolean NOT NULL DEFAULT false,
  -- 预算耗尽后不再自动重试，但保留记录供人工重放（第 8.1 节）。
  abandoned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_purpose_valid CHECK (purpose IN ('channel_main', 'discussion_report', 'discussion_thread')),
  CONSTRAINT delivery_shard_non_negative CHECK (shard_index >= 0),
  CONSTRAINT delivery_attempts_non_negative CHECK (attempts >= 0)
);
-- 投递以“业务目的 + 目标 + 分片号”保证唯一意图（第 5 节）。
CREATE UNIQUE INDEX IF NOT EXISTS delivery_intent_key
  ON delivery_records (
    purpose,
    coalesce(report_id, ''),
    coalesce(target_chat_id, ''),
    coalesce(target_thread_message_id, 0),
    shard_index
  );
CREATE INDEX IF NOT EXISTS delivery_pending_idx ON delivery_records (next_attempt_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS delivery_claimable_idx ON delivery_records (next_attempt_at, created_at) WHERE sent_at IS NULL AND abandoned = false;
CREATE INDEX IF NOT EXISTS delivery_project_idx ON delivery_records (project_id, created_at DESC);

-- ============ 讨论群映射 ============
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

-- ============ 任务与租约 ============

CREATE TABLE IF NOT EXISTS jobs (
  job_id text PRIMARY KEY,
  kind text NOT NULL,
  project_id text REFERENCES projects (project_id) ON DELETE CASCADE,
  trigger_event_id text REFERENCES inbound_events (event_id) ON DELETE SET NULL,
  stage text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  lease_generation integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  triggered_by text NOT NULL DEFAULT 'natural',
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  -- 主动退避：到点前不应被任何 worker 领取（租约过期则属于失联接管）。
  next_attempt_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_kind_valid CHECK (kind IN ('classification', 'standard', 'deep', 'delivery')),
  CONSTRAINT jobs_stage_valid CHECK (
    stage IN ('queued', 'waiting_dependency', 'running', 'succeeded', 'failed', 'dead_letter')
  ),
  CONSTRAINT jobs_triggered_by_valid CHECK (triggered_by IN ('natural', 'restore')),
  CONSTRAINT jobs_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT jobs_lease_generation_non_negative CHECK (lease_generation >= 0)
);
-- 自动首次任务唯一：每项目每类型只有一条自动任务；重试使用原任务 ID（第 5 节）。
CREATE UNIQUE INDEX IF NOT EXISTS jobs_project_kind_auto_key
  ON jobs (project_id, kind) WHERE kind IN ('standard', 'deep') AND triggered_by = 'natural';
CREATE INDEX IF NOT EXISTS jobs_claimable_idx ON jobs (stage, created_at);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (next_attempt_at, created_at) WHERE stage IN ('queued', 'failed');
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_expires_at) WHERE stage = 'running';

-- ============ 审计（不记身份，长期保留） ============
CREATE TABLE IF NOT EXISTS audit_records (
  audit_id text PRIMARY KEY,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  before_summary text,
  after_summary text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_action_not_blank CHECK (length(btrim(action)) > 0)
);
CREATE INDEX IF NOT EXISTS audit_occurred_at_idx ON audit_records (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_target_idx ON audit_records (target_type, target_id);

-- 运行指标的增量计数（M5 实测发现的瓶颈）。
--
-- 现象：`readHealthSnapshot` 用多个 `count(*)` 子查询统计全表；20 万事件/判定时
-- `/api/health` 的 p50 已达 31 ms（比列表查询还慢）。数据量继续增长会成为运行状态页的瓶颈。
--
-- 处理：用**语句级触发器**维护计数器，`/api/health` 只读一行。
-- 之所以用语句级（FOR EACH STATEMENT）而不是行级：批量插入一次 5000 行时，
-- 行级触发器会执行 5000 次；语句级只在批次结束时更新一次。
--
-- 维护范围只覆盖“单调增长且清理会缩减”的两张表（inbound_events、decisions）。
-- 项目/任务/投递的数量仍走实时查询——它们的基数远小于事件表，且状态变化频繁，
-- 用计数器反而容易与真实状态漂移。

-- 运行指标的增量计数（M5 实测发现的瓶颈）。
--
-- 现象：`readHealthSnapshot` 用多个 `count(*)` 子查询统计全表；20 万事件/判定时
-- `/api/health` 的 p50 已达 31 ms（比列表查询还慢）。数据量继续增长会成为运行状态页的瓶颈。
--
-- 处理：用**语句级触发器**维护计数器，`/api/health` 只读一行。
-- 之所以用语句级（FOR EACH STATEMENT）而不是行级：批量插入一次 5000 行时，
-- 行级触发器会执行 5000 次；语句级只在批次结束时更新一次。
-- 注意：PostgreSQL 不允许一条触发器同时为 INSERT 和 DELETE 指定 transition table，
-- 因此每种事件各建一条触发器。
--
-- 维护范围只覆盖“单调增长且清理会缩减”的两张表（inbound_events、decisions）。
-- 项目/任务/投递的数量仍走实时查询——它们基数远小于事件表且状态变化频繁，
-- 用计数器反而容易与真实状态漂移。

CREATE TABLE IF NOT EXISTS runtime_counters (
  counter_key text PRIMARY KEY,
  value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_counters_non_negative CHECK (value >= 0)
);

-- 统一的自增/自减函数：delta 由触发器按语句影响行数传入。
CREATE OR REPLACE FUNCTION bump_runtime_counter(key text, delta bigint)
RETURNS void AS $$
BEGIN
  INSERT INTO runtime_counters (counter_key, value, updated_at)
  VALUES (key, GREATEST(delta, 0), now())
  ON CONFLICT (counter_key) DO UPDATE
    SET value = GREATEST(runtime_counters.value + delta, 0),
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_inbound_events_insert()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('inbound_events', (SELECT count(*) FROM new_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_inbound_events_delete()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('inbound_events', -(SELECT count(*) FROM old_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_decisions_insert()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('decisions', (SELECT count(*) FROM new_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_count_decisions_delete()
RETURNS trigger AS $$
BEGIN
  PERFORM bump_runtime_counter('decisions', -(SELECT count(*) FROM old_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS count_inbound_events_insert ON inbound_events;
CREATE TRIGGER count_inbound_events_insert
  AFTER INSERT ON inbound_events
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_inbound_events_insert();

DROP TRIGGER IF EXISTS count_inbound_events_delete ON inbound_events;
CREATE TRIGGER count_inbound_events_delete
  AFTER DELETE ON inbound_events
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_inbound_events_delete();

DROP TRIGGER IF EXISTS count_decisions_insert ON decisions;
CREATE TRIGGER count_decisions_insert
  AFTER INSERT ON decisions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_decisions_insert();

DROP TRIGGER IF EXISTS count_decisions_delete ON decisions;
CREATE TRIGGER count_decisions_delete
  AFTER DELETE ON decisions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION trg_count_decisions_delete();

-- 首次建立时用现有数据回填（写入绝对值而不是增量，幂等）。
INSERT INTO runtime_counters (counter_key, value, updated_at)
SELECT 'inbound_events', (SELECT count(*) FROM inbound_events), now()
ON CONFLICT (counter_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO runtime_counters (counter_key, value, updated_at)
SELECT 'decisions', (SELECT count(*) FROM decisions), now()
ON CONFLICT (counter_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ============ 推特喊单（Q105、Q108-Q117） ============
CREATE TABLE IF NOT EXISTS tweets (
  tweet_id text PRIMARY KEY,
  author_handle text,
  author_name text,
  author_verified boolean,
  author_followers integer,
  body text NOT NULL,
  posted_at timestamptz,
  like_count integer,
  retweet_count integer,
  reply_count integer,
  view_count integer,
  url text,
  source text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  raw_payload text,
  summary_status text NOT NULL DEFAULT 'pending',
  summary_text text,
  summary_model text,
  summary_updated_at timestamptz,
  summary_attempts integer NOT NULL DEFAULT 0,
  CONSTRAINT tweets_summary_status_valid CHECK (summary_status IN ('pending', 'done', 'failed')),
  CONSTRAINT tweets_counts_non_negative CHECK (
    (like_count IS NULL OR like_count >= 0)
    AND (retweet_count IS NULL OR retweet_count >= 0)
    AND (reply_count IS NULL OR reply_count >= 0)
    AND (view_count IS NULL OR view_count >= 0)
  )
);
CREATE INDEX IF NOT EXISTS tweets_posted_at_idx ON tweets (posted_at DESC NULLS LAST, tweet_id DESC);
CREATE INDEX IF NOT EXISTS tweets_summary_pending_idx ON tweets (summary_status, first_seen_at) WHERE summary_status <> 'done';

CREATE TABLE IF NOT EXISTS tweet_mentions (
  tweet_id text NOT NULL REFERENCES tweets (tweet_id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  project_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tweet_id, project_id)
);
CREATE INDEX IF NOT EXISTS tweet_mentions_project_idx ON tweet_mentions (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tweet_poll_state (
  project_id text PRIMARY KEY REFERENCES projects (project_id) ON DELETE CASCADE,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  CONSTRAINT tweet_poll_failures_non_negative CHECK (consecutive_failures >= 0)
);

-- ============ 会话与凭据（Q78-Q85） ============
CREATE TABLE IF NOT EXISTS sessions (
  session_id text PRIMARY KEY,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  user_agent text,
  CONSTRAINT sessions_role_valid CHECK (role IN ('visitor', 'admin'))
);
CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions (role) WHERE revoked_at IS NULL;

-- 凭据只保存哈希；明文来自环境变量，服务端不落库（Q83）。
CREATE TABLE IF NOT EXISTS access_credentials (
  credential_id text PRIMARY KEY,
  kind text NOT NULL,
  secret_hash text NOT NULL,
  secret_salt text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_credentials_kind_valid CHECK (kind IN ('visitor', 'admin')),
  CONSTRAINT access_credentials_kind_unique UNIQUE (kind)
);

-- ============ 运行指标（业务健康优先，Q101） ============
CREATE TABLE IF NOT EXISTS runtime_metrics (
  metric_key text PRIMARY KEY,
  value jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
