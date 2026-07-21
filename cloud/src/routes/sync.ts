import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { authMiddleware } from "../middleware/auth";
import { nowMs } from "../lib/id";
import { base64url, base64urlDecode } from "../lib/crypto";
import { audit } from "../lib/audit";
import {
  PushRequestSchema,
  PullRequestSchema,
  type PushItemResult,
  type PullItem,
} from "../protocol";

export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use("*", authMiddleware);

function r2Key(accountId: string, memoId: string, revision: number): string {
  return `accounts/${accountId}/memos/${memoId}/r${revision}.md`;
}

const MAX_INLINE_BODY = 256 * 1024; // 单条 memo 正文内联上限
const MAX_PUSH_BODY = 50 * 1024 * 1024; // 单次 push 请求体上限

// --- 上行:客户端推本地变更 ---
syncRoutes.post("/push", async (c) => {
  const accountId = c.get("account_id");
  const deviceId = c.get("device_id");

  const cl = Number(c.req.header("content-length") ?? "0");
  if (cl > MAX_PUSH_BODY) return c.json({ error: "payload_too_large" }, 413);

  const parsed = PushRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  const { changes } = parsed.data;

  const acct = await c.env.DB.prepare(
    "SELECT quota_bytes, used_bytes FROM accounts WHERE id = ?"
  )
    .bind(accountId)
    .first<{ quota_bytes: number; used_bytes: number }>();
  if (!acct) return c.json({ error: "not_found" }, 404);
  let used = acct.used_bytes;

  const results: PushItemResult[] = [];

  for (const change of changes) {
    // 强制:notebook 必须属于该账户且 sync_enabled=1(防伪造范围)
    const nb = await c.env.DB.prepare(
      "SELECT id FROM notebooks WHERE id = ? AND account_id = ? AND sync_enabled = 1"
    )
      .bind(change.notebook_id, accountId)
      .first();
    if (!nb) {
      results.push({ id: change.id, status: "conflict", server_revision: 0, server_hash: null });
      continue;
    }

    // 实际字节:有正文用解码长度(不信客户端 size_bytes);删除=0;纯元数据沿用客户端值
    const actualSize =
      !change.deleted && change.content_b64
        ? base64urlDecode(change.content_b64).byteLength
        : change.deleted
        ? 0
        : change.size_bytes;

    const row = await c.env.DB.prepare(
      "SELECT revision, content_hash, size_bytes FROM memos WHERE account_id = ? AND id = ?"
    )
      .bind(accountId, change.id)
      .first<{ revision: number; content_hash: string | null; size_bytes: number }>();

    if (row) {
      // 冲突检测:base_revision 必须等于服务端当前 revision(乐观锁)
      if (change.base_revision !== row.revision) {
        results.push({
          id: change.id,
          status: "conflict",
          server_revision: row.revision,
          server_hash: row.content_hash,
        });
        continue;
      }
      const newRev = row.revision + 1;
      const delta = actualSize - row.size_bytes;
      if (delta > 0 && used + delta > acct.quota_bytes) {
        results.push({ id: change.id, status: "quota_exceeded" });
        continue;
      }
      if (change.content_b64 && !change.deleted && actualSize <= MAX_INLINE_BODY) {
        await c.env.BUCKET.put(r2Key(accountId, change.id, newRev), base64urlDecode(change.content_b64));
      }
      await c.env.DB.prepare(
        `UPDATE memos SET notebook_id=?, filename=?, content_hash=?, size_bytes=?, revision=?, updated_at=?, deleted=?, deleted_at=? WHERE account_id=? AND id=?`
      )
        .bind(
          change.notebook_id,
          change.filename,
          change.content_hash,
          actualSize,
          newRev,
          change.updated_at,
          change.deleted ? 1 : 0,
          change.deleted ? change.updated_at : null,
          accountId,
          change.id
        )
        .run();
      used += delta;
      results.push({ id: change.id, status: "accepted", revision: newRev });
    } else {
      // 新建
      if (actualSize > 0 && used + actualSize > acct.quota_bytes) {
        results.push({ id: change.id, status: "quota_exceeded" });
        continue;
      }
      const newRev = 1;
      if (change.content_b64 && !change.deleted && actualSize <= MAX_INLINE_BODY) {
        await c.env.BUCKET.put(r2Key(accountId, change.id, newRev), base64urlDecode(change.content_b64));
      }
      await c.env.DB.prepare(
        `INSERT INTO memos (account_id, id, notebook_id, filename, content_hash, size_bytes, revision, updated_at, deleted, deleted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          accountId,
          change.id,
          change.notebook_id,
          change.filename,
          change.content_hash,
          actualSize,
          newRev,
          change.updated_at,
          change.deleted ? 1 : 0,
          change.deleted ? change.updated_at : null,
          change.updated_at
        )
        .run();
      used += actualSize;
      results.push({ id: change.id, status: "accepted", revision: newRev });
    }
  }

  if (used !== acct.used_bytes) {
    await c.env.DB.prepare("UPDATE accounts SET used_bytes = ?, updated_at = ? WHERE id = ?")
      .bind(used, nowMs(), accountId)
      .run();
  }

  const summary = {
    total: changes.length,
    accepted: results.filter((r) => r.status === "accepted").length,
    conflict: results.filter((r) => r.status === "conflict").length,
    quota_exceeded: results.filter((r) => r.status === "quota_exceeded").length,
  };
  await audit(c.env, accountId, deviceId, "push", summary, used - acct.used_bytes);

  return c.json({ results, used_bytes: used, quota_bytes: acct.quota_bytes });
});

// --- 下行:客户端拉服务端变更 ---
syncRoutes.post("/pull", async (c) => {
  const accountId = c.get("account_id");
  const deviceId = c.get("device_id");
  const parsed = PullRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  const { since, notebooks: requestedNbs } = parsed.data;

  const enabledRows = await c.env.DB.prepare(
    "SELECT id FROM notebooks WHERE account_id = ? AND sync_enabled = 1"
  )
    .bind(accountId)
    .all<{ id: string }>();
  const enabled = enabledRows.results.map((r) => r.id);
  const allowed =
    requestedNbs && requestedNbs.length > 0
      ? enabled.filter((id) => requestedNbs.includes(id))
      : enabled;
  if (allowed.length === 0) {
    await audit(c.env, accountId, deviceId, "pull", { since, returned: 0, latest: since }, 0);
    return c.json({ changes: [], latest_revision: since });
  }

  const placeholders = allowed.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(
    `SELECT id, notebook_id, filename, content_hash, size_bytes, revision, updated_at, deleted
     FROM memos WHERE account_id = ? AND revision > ? AND notebook_id IN (${placeholders})
     ORDER BY revision ASC LIMIT 1000`
  )
    .bind(accountId, since, ...allowed)
    .all<{
      id: string;
      notebook_id: string;
      filename: string;
      content_hash: string | null;
      size_bytes: number;
      revision: number;
      updated_at: number;
      deleted: number;
    }>();

  const changes: PullItem[] = [];
  let latest = since;
  for (const r of rows.results) {
    latest = Math.max(latest, r.revision);
    const item: PullItem = {
      id: r.id,
      notebook_id: r.notebook_id,
      filename: r.filename,
      content_hash: r.content_hash,
      size_bytes: r.size_bytes,
      revision: r.revision,
      updated_at: r.updated_at,
      deleted: r.deleted === 1,
    };
    if (!item.deleted && r.size_bytes > 0 && r.size_bytes <= MAX_INLINE_BODY) {
      const obj = await c.env.BUCKET.get(r2Key(accountId, r.id, r.revision));
      if (obj) {
        const buf = new Uint8Array(await obj.arrayBuffer());
        item.content_b64 = base64url(buf);
      }
    }
    changes.push(item);
  }

  await c.env.DB.prepare(
    `INSERT INTO device_cursors (device_id, account_id, last_pull_revision, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(device_id) DO UPDATE SET last_pull_revision = excluded.last_pull_revision, updated_at = excluded.updated_at`
  )
    .bind(deviceId, accountId, latest, nowMs())
    .run();

  await audit(c.env, accountId, deviceId, "pull", { since, returned: changes.length, latest }, 0);
  return c.json({ changes, latest_revision: latest });
});

const AckSchema = z.object({ last_pull_revision: z.number().int().nonnegative() });

syncRoutes.post("/ack", async (c) => {
  const accountId = c.get("account_id");
  const deviceId = c.get("device_id");
  const parsed = AckSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO device_cursors (device_id, account_id, last_pull_revision, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(device_id) DO UPDATE SET last_pull_revision = excluded.last_pull_revision, updated_at = excluded.updated_at`
  )
    .bind(deviceId, accountId, parsed.data.last_pull_revision, nowMs())
    .run();
  return c.json({ ok: true });
});
