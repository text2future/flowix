import type { Bindings } from "../env";
import { nowMs } from "./id";

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // tombstone 保留 30 天
const GC_BATCH = 200;

export interface GcResult {
  reclaimed_bytes: number;
  deleted_memos: number;
  deleted_objects: number;
}

// 清理过期 tombstone + 对应 R2 对象 + 回收配额。
// 由 Cron Trigger 定时触发,或 /internal/gc 手动触发。幂等。
export async function runGc(env: Bindings): Promise<GcResult> {
  const cutoff = nowMs() - TOMBSTONE_TTL_MS;

  // 1. 查待删 memos(限批量,避免单次超时)
  const rows = await env.DB.prepare(
    "SELECT account_id, id FROM memos WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?"
  )
    .bind(cutoff, GC_BATCH)
    .all<{ account_id: string; id: string }>();

  let deletedObjects = 0;
  for (const r of rows.results) {
    deletedObjects += await deleteMemoObjects(env, r.account_id, r.id);
  }

  // 2. 按 account 聚合待回收配额
  const agg = await env.DB.prepare(
    "SELECT account_id, COALESCE(SUM(size_bytes),0) AS s FROM memos WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ? GROUP BY account_id"
  )
    .bind(cutoff)
    .all<{ account_id: string; s: number }>();

  // 3. 删 D1 行 + 回收配额(单事务)
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      "DELETE FROM memos WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < ?"
    ).bind(cutoff),
    ...agg.results.map((a) =>
      env.DB.prepare(
        "UPDATE accounts SET used_bytes = MAX(0, used_bytes - ?), updated_at = ? WHERE id = ?"
      ).bind(a.s, nowMs(), a.account_id)
    ),
  ];
  await env.DB.batch(stmts);

  const reclaimed = agg.results.reduce((sum, a) => sum + a.s, 0);
  return {
    reclaimed_bytes: reclaimed,
    deleted_memos: rows.results.length,
    deleted_objects: deletedObjects,
  };
}

// 删某 memo 在 R2 的所有 revision 对象
async function deleteMemoObjects(env: Bindings, accountId: string, memoId: string): Promise<number> {
  const prefix = `accounts/${accountId}/memos/${memoId}/`;
  let count = 0;
  let cursor: string | undefined = undefined;
  do {
    const listed = await env.BUCKET.list({ prefix, cursor, limit: 500 });
    for (const obj of listed.objects) {
      await env.BUCKET.delete(obj.key);
      count++;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return count;
}
