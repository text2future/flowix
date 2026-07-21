import type { Bindings } from "../env";
import { nowMs } from "./id";

// 审计日志:push/pull/billing/gc 摘要,用于配额追溯与安全审计。
// sync_log 表见 migrations/0002_audit_log.sql。定期 TTL 清理(可由 GC 顺带)。
export async function audit(
  env: Bindings,
  accountId: string,
  deviceId: string | null,
  action: string,
  detail: Record<string, unknown> | null,
  sizeBytes = 0
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sync_log (account_id, device_id, action, detail, size_bytes, created_at) VALUES (?,?,?,?,?,?)"
  )
    .bind(accountId, deviceId, action, detail ? JSON.stringify(detail) : null, sizeBytes, nowMs())
    .run();
}
