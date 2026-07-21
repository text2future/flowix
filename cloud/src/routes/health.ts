import { Hono } from "hono";
import type { AppEnv } from "../env";

export const healthRoutes = new Hono<AppEnv>();

// 轻量健康检查(供高频探活 / LB)
healthRoutes.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// 深度探活:检查 D1 + R2 binding 连通性。低频调用(监控用)。
healthRoutes.get("/health/deep", async (c) => {
  const checks: Record<string, boolean> = {};
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.d1 = true;
  } catch {
    checks.d1 = false;
  }
  try {
    await c.env.BUCKET.head("__healthcheck__");
    checks.r2 = true;
  } catch {
    checks.r2 = false;
  }
  const ok = checks.d1 && checks.r2;
  return c.json({ ok, checks, ts: Date.now() }, ok ? 200 : 503);
});
