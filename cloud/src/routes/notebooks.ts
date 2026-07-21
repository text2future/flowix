import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { authMiddleware } from "../middleware/auth";
import { nowMs } from "../lib/id";

export const notebookRoutes = new Hono<AppEnv>();
notebookRoutes.use("*", authMiddleware);

notebookRoutes.get("/", async (c) => {
  const accountId = c.get("account_id");
  const rows = await c.env.DB.prepare(
    "SELECT id, name, icon, sort, sync_enabled, created_at, updated_at FROM notebooks WHERE account_id = ? ORDER BY sort ASC"
  )
    .bind(accountId)
    .all();
  return c.json({ notebooks: rows.results });
});

const UpsertSchema = z.object({
  name: z.string().min(1).max(255),
  icon: z.string().nullable().optional(),
  sort: z.number().int().optional(),
  sync_enabled: z.boolean().optional(), // 选择性同步开关
});

notebookRoutes.put("/:id", async (c) => {
  const accountId = c.get("account_id");
  const id = c.req.param("id");
  const parsed = UpsertSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success)
    return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
  const { name, icon, sort, sync_enabled } = parsed.data;
  const now = nowMs();
  const syncFlag = sync_enabled === undefined ? 1 : sync_enabled ? 1 : 0;
  // 所有权:若 notebook 已存在,必须属该账户(防跨账户劫持同 id notebook)
  const existing = await c.env.DB.prepare("SELECT account_id FROM notebooks WHERE id = ?")
    .bind(id)
    .first<{ account_id: string }>();
  if (existing && existing.account_id !== accountId) {
    return c.json({ error: "notebook_owned_by_another" }, 403);
  }
  await c.env.DB.prepare(
    `INSERT INTO notebooks (id, account_id, name, icon, sort, sync_enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       icon=coalesce(excluded.icon, notebooks.icon),
       sort=coalesce(excluded.sort, notebooks.sort),
       sync_enabled=coalesce(excluded.sync_enabled, notebooks.sync_enabled),
       updated_at=excluded.updated_at`
  )
    .bind(id, accountId, name, icon ?? null, sort ?? 0, syncFlag, now, now)
    .run();
  return c.json({ ok: true });
});
