-- 审计日志:push/pull/billing/gc 摘要,配额追溯与安全审计。可定期 TTL 清理。
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  device_id TEXT,
  action TEXT NOT NULL,            -- push|pull|billing_checkout|billing_portal|gc
  detail TEXT,                     -- JSON 摘要
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_synclog_account ON sync_log(account_id, created_at);
