import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv, Bindings } from "./env";
import { HttpError } from "./lib/errors";
import { runGc } from "./lib/gc";
import { audit } from "./lib/audit";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { accountRoutes } from "./routes/account";
import { notebookRoutes } from "./routes/notebooks";
import { syncRoutes } from "./routes/sync";
import { billingRoutes } from "./routes/billing";
import { webhookRoutes } from "./routes/webhook";
import { internalRoutes } from "./routes/internal";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.use(
  "*",
  cors({
    // 桌面端:tauri://localhost(macOS/Linux)、https://tauri.localhost(Windows);前端 dev:1420
    origin: ["http://localhost:1420", "tauri://localhost", "https://tauri.localhost"],
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// 统一错误:HttpError -> 标准化 {error, message};其它 -> 500 internal
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { error: err.code, message: err.message },
      err.status as ContentfulStatusCode
    );
  }
  console.error("unhandled error:", err);
  return c.json({ error: "internal" }, 500);
});

app.route("/", healthRoutes);
app.route("/auth", authRoutes);
app.route("/account", accountRoutes);
app.route("/notebooks", notebookRoutes);
app.route("/sync", syncRoutes);
app.route("/billing", billingRoutes);
app.route("/webhooks", webhookRoutes);
app.route("/internal", internalRoutes);

// Workers 入口:fetch(HTTP)+ scheduled(Cron GC)
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    try {
      const result = await runGc(env);
      await audit(env, "system", null, "gc", { ...result, source: "cron" }, 0);
    } catch (e) {
      console.error("gc failed:", e);
    }
  },
};
