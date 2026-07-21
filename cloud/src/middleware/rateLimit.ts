import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv } from "../env";

interface RateEntry {
  count: number;
  reset: number; // epoch sec
}

// KV 计数器限流(fixed window,过期自动清)。最终一致,限流略松可接受。
// 用法:app.use("/auth/login", rateLimit({ key: (c) => `login:${clientIp(c)}`, limit: 10, windowSec: 600 }))
export function rateLimit(opts: {
  key: (c: Context<AppEnv>) => string;
  limit: number;
  windowSec: number;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.env.RATE_LIMIT_DISABLED) {
      await next();
      return;
    }
    const k = `rl:${opts.key(c)}`;
    const now = Math.floor(Date.now() / 1000);
    const raw = await c.env.KV.get(k);
    let entry: RateEntry = raw ? (JSON.parse(raw) as RateEntry) : { count: 0, reset: now + opts.windowSec };
    if (now >= entry.reset) entry = { count: 0, reset: now + opts.windowSec };
    entry.count++;
    await c.env.KV.put(k, JSON.stringify(entry), { expirationTtl: opts.windowSec + 60 });
    if (entry.count > opts.limit) {
      c.header("Retry-After", String(Math.max(1, entry.reset - now)));
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  });
}

export function clientIp(c: Context<AppEnv>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown"
  );
}
