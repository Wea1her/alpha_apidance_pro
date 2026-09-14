-- 会话与服务端凭据（Q78-Q85）。
--
-- 访问模型最终形态：
-- - 共享访问密钥：打开网页用，验证通过后签发长期、自动续期的 HttpOnly Cookie；
-- - 管理员密码：写操作才需要，未通过者访问写路由返回 403；
-- - 环境变量保存恢复密码，忘记密码时重置（Q72）；
-- - 审计不记录操作者身份（Q75、Q85），因此会话表只服务鉴权，不用于追踪人。

BEGIN;

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

COMMIT;
