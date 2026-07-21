import { Hono } from "hono";
import type { AppEnv } from "../env";
import { runGc } from "../lib/gc";
import { audit } from "../lib/audit";
import { nowMs } from "../lib/id";

// 内部运维路由:靠 GC_SECRET header 鉴权,不挂 authMiddleware。
export const internalRoutes = new Hono<AppEnv>();

// 手动触发 GC(Cron 之外的补充)。Cron 失败或需要立即回收时用。
internalRoutes.post("/gc", async (c) => {
  const provided = c.req.header("x-internal-secret");
  if (!c.env.GC_SECRET || provided !== c.env.GC_SECRET)
    return c.json({ error: "unauthorized" }, 401);
  const result = await runGc(c.env);
  await audit(c.env, "system", null, "gc", { ...result }, 0);
  return c.json({ ok: true, ...result, ts: nowMs() });
});
