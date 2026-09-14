-- 推特喊单（Q105、Q108-Q117）。
--
-- 设计要点：
-- - 推文入库去重：以“推文 ID”为唯一键，轮询重复抓取不会重复展示（Q112）；
-- - 关联到监控池账号：一条推文可能提及多个账号，用关联表表达多对多（Q120 双向可达）；
-- - 中文摘要是可选加工：失败时仍展示原文与互动数，不能因为摘要失败丢内容（Q117）；
-- - 数据新鲜度：记录每个账号维度的最后成功检索时间，页面据此显示“最后检索时间”（Q116）。
--
-- 依赖说明：本表不存储任何供应商密钥；数据源由部署者自行配置（Q108/Q129）。

BEGIN;

CREATE TABLE IF NOT EXISTS tweets (
  tweet_id text PRIMARY KEY,
  author_handle text,
  author_name text,
  author_verified boolean,
  author_followers integer,
  body text NOT NULL,
  posted_at timestamptz,
  -- 互动数允许缺失：数据源不提供时保持 NULL，不填 0 冒充（Q117）。
  like_count integer,
  retweet_count integer,
  reply_count integer,
  view_count integer,
  url text,
  source text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  raw_payload text,
  -- 摘要加工状态：待处理 / 已完成 / 失败（失败保留原文，页面显示“摘要不可用”）。
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

-- 推文与监控池项目的关联（一条推文可提及多个账号）。
CREATE TABLE IF NOT EXISTS tweet_mentions (
  tweet_id text NOT NULL REFERENCES tweets (tweet_id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects (project_id) ON DELETE CASCADE,
  project_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tweet_id, project_id)
);
CREATE INDEX IF NOT EXISTS tweet_mentions_project_idx ON tweet_mentions (project_id, created_at DESC);

-- 检索游标：每个核心池账号的最后成功检索时间与最近错误（Q116、Q121）。
CREATE TABLE IF NOT EXISTS tweet_poll_state (
  project_id text PRIMARY KEY REFERENCES projects (project_id) ON DELETE CASCADE,
  last_success_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  CONSTRAINT tweet_poll_failures_non_negative CHECK (consecutive_failures >= 0)
);

COMMIT;
