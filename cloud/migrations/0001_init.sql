-- Flowix Cloud 初始 schema。对应 src/db/schema.ts。
-- 幂等建表(IF NOT EXISTS),可重复 apply。

-- 账户
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                  -- scrypt(scheme:scrypt:N:r:p$salt$hash)
  plan TEXT NOT NULL DEFAULT 'free',            -- free | pro
  quota_bytes INTEGER NOT NULL DEFAULT 524288000,  -- free=500MB
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 设备(复用客户端 device_id, UUID v4)
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT,
  platform TEXT,
  app_version TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);

-- 会话(opaque refresh token 的哈希)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                          -- sha256(refresh_token)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  rotated_from TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

-- 笔记本逻辑身份(不含 path:path 各设备本地维护)
CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,                          -- = 客户端 notebook id (nb_xxx)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  sync_enabled INTEGER NOT NULL DEFAULT 1,      -- 选择性同步开关
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notebooks_account ON notebooks(account_id);

-- memo 元数据索引(与客户端 ~/.flowix/index.db 的 memos 表对齐 + 同步字段)
CREATE TABLE IF NOT EXISTS memos (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,                             -- 客户端 memo id(全局唯一,8位)
  notebook_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_hash TEXT,                            -- sha256(body)
  size_bytes INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,          -- 单调递增,冲突检测
  updated_at INTEGER NOT NULL,                  -- epoch ms
  deleted INTEGER NOT NULL DEFAULT 0,           -- tombstone
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_memos_revision ON memos(account_id, revision);
CREATE INDEX IF NOT EXISTS idx_memos_updated ON memos(account_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_memos_notebook ON memos(account_id, notebook_id);

-- 每设备拉取游标
CREATE TABLE IF NOT EXISTS device_cursors (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  last_pull_revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 订阅
CREATE TABLE IF NOT EXISTS subscriptions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,                           -- pro
  interval TEXT,                                -- month | year
  status TEXT NOT NULL,                         -- trialing|active|past_due|canceled|expired
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- webhook 幂等(按 stripe event id 去重)
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
