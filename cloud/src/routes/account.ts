import { Hono } from "hono";
import type { AppEnv } from "../env";
import { authMiddleware } from "../middleware/auth";

export const accountRoutes = new Hono<AppEnv>();
accountRoutes.use("*", authMiddleware);

accountRoutes.get("/", async (c) => {
  const accountId = c.get("account_id");
  const a = await c.env.DB.prepare(
    "SELECT id, email, plan, quota_bytes, used_bytes FROM accounts WHERE id = ?"
  )
    .bind(accountId)
    .first<{ id: string; email: string; plan: string; quota_bytes: number; used_bytes: number }>();
  if (!a) return c.json({ error: "not_found" }, 404);
  return c.json({
    account_id: a.id,
    email: a.email,
    plan: a.plan,
    quota_bytes: a.quota_bytes,
    used_bytes: a.used_bytes,
  });
});

accountRoutes.get("/devices", async (c) => {
  const accountId = c.get("account_id");
  const rows = await c.env.DB.prepare(
    "SELECT id, name, platform, app_version, last_seen_at FROM devices WHERE account_id = ? ORDER BY last_seen_at DESC"
  )
    .bind(accountId)
    .all();
  return c.json({ devices: rows.results });
});

accountRoutes.delete("/devices/:id", async (c) => {
  const accountId = c.get("account_id");
  const deviceId = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM devices WHERE id = ? AND account_id = ?").bind(deviceId, accountId),
    c.env.DB.prepare(
      "UPDATE sessions SET revoked = 1 WHERE device_id = ? AND account_id = ?"
    ).bind(deviceId, accountId),
  ]);
  return c.json({ ok: true });
});
