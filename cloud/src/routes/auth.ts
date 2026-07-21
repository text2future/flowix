import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../env";
import { PLAN, QUOTA_BYTES } from "../protocol";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from "../lib/crypto";
import { uuid, nowMs, REFRESH_TTL_MS } from "../lib/id";
import { verifyTurnstile } from "../lib/turnstile";
import { audit } from "../lib/audit";
import { rateLimit, clientIp } from "../middleware/rateLimit";

export const authRoutes = new Hono<AppEnv>();

const MAX_DEVICES = 10;

const SignupSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  device_id: z.string().min(1).max(64),
  device_name: z.string().optional(),
  platform: z.string().optional(),
  app_version: z.string().optional(),
  turnstile_token: z.string().optional(),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  device_id: z.string().min(1),
  device_name: z.string().optional(),
  platform: z.string().optional(),
  app_version: z.string().optional(),
});

const RefreshSchema = z.object({ refresh_token: z.string() });

async function issueSession(env: Bindings, accountId: string, deviceId: string) {
  const access = await signAccessToken(env.JWT_PRIVATE_KEY, accountId, deviceId);
  const refresh = generateRefreshToken();
  const refreshId = hashRefreshToken(refresh);
  const now = nowMs();
  await env.DB.prepare(
    "INSERT INTO sessions (id, account_id, device_id, expires_at, revoked, created_at) VALUES (?,?,?,?,0,?)"
  )
    .bind(refreshId, accountId, deviceId, now + REFRESH_TTL_MS, now)
    .run();
  return { access_token: access, refresh_token: refresh, expires_in: 900 };
}

// 注册:限流 + Turnstile + 建账户/设备
authRoutes.post(
  "/signup",
  rateLimit({ key: (c) => `signup:${clientIp(c)}`, limit: 10, windowSec: 3600 }),
  async (c) => {
    const parsed = SignupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return c.json({ error: "bad_request", issues: parsed.error.issues }, 400);
    const { email, password, device_id, device_name, platform, app_version, turnstile_token } =
      parsed.data;

    if (!(await verifyTurnstile(turnstile_token, c.env.TURNSTILE_SECRET_KEY, clientIp(c))))
      return c.json({ error: "turnstile_failed" }, 400);

    const existing = await c.env.DB.prepare("SELECT id FROM accounts WHERE email = ?")
      .bind(email)
      .first();
    if (existing) return c.json({ error: "email_taken" }, 409);

    const accountId = uuid();
    const now = nowMs();
    const passwordHash = await hashPassword(password);
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO accounts (id, email, password_hash, plan, quota_bytes, used_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(accountId, email, passwordHash, PLAN.FREE, QUOTA_BYTES.free, 0, now, now),
      c.env.DB.prepare(
        "INSERT INTO devices (id, account_id, name, platform, app_version, last_seen_at, created_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(device_id, accountId, device_name ?? null, platform ?? null, app_version ?? null, now, now),
    ]);

    const session = await issueSession(c.env, accountId, device_id);
    await audit(c.env, accountId, device_id, "signup", { email }, 0);
    return c.json({ account_id: accountId, ...session }, 201);
  }
);

// 登录:限流(防爆破)+ 设备数上限 + upsert device
authRoutes.post(
  "/login",
  rateLimit({ key: (c) => `login:${clientIp(c)}`, limit: 10, windowSec: 600 }),
  async (c) => {
    const parsed = LoginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad_request" }, 400);
    const { email, password, device_id, device_name, platform, app_version } = parsed.data;

    const account = await c.env.DB.prepare(
      "SELECT id, password_hash FROM accounts WHERE email = ?"
    )
      .bind(email)
      .first<{ id: string; password_hash: string }>();
    if (!account) return c.json({ error: "invalid_credentials" }, 401);
    const ok = await verifyPassword(password, account.password_hash);
    if (!ok) return c.json({ error: "invalid_credentials" }, 401);

    const now = nowMs();
    const devExists = await c.env.DB.prepare("SELECT id FROM devices WHERE id = ?")
      .bind(device_id)
      .first();
    if (!devExists) {
      const cnt = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM devices WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ n: number }>();
      if (cnt && cnt.n >= MAX_DEVICES) return c.json({ error: "too_many_devices" }, 403);
    }

    await c.env.DB.prepare(
      `INSERT INTO devices (id, account_id, name, platform, app_version, last_seen_at, created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         account_id=excluded.account_id,
         name=coalesce(excluded.name, devices.name),
         platform=coalesce(excluded.platform, devices.platform),
         app_version=coalesce(excluded.app_version, devices.app_version),
         last_seen_at=excluded.last_seen_at`
    )
      .bind(device_id, account.id, device_name ?? null, platform ?? null, app_version ?? null, now, now)
      .run();

    const session = await issueSession(c.env, account.id, device_id);
    await audit(c.env, account.id, device_id, "login", { new_device: !devExists }, 0);
    return c.json({ account_id: account.id, ...session });
  }
);

authRoutes.post("/refresh", async (c) => {
  const parsed = RefreshSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request" }, 400);
  const token = parsed.data.refresh_token;
  const tokenHash = hashRefreshToken(token);
  const row = await c.env.DB.prepare(
    "SELECT account_id, device_id, expires_at, revoked FROM sessions WHERE id = ?"
  )
    .bind(tokenHash)
    .first<{ account_id: string; device_id: string; expires_at: number; revoked: number }>();
  if (!row || row.revoked === 1 || row.expires_at < nowMs())
    return c.json({ error: "invalid_refresh" }, 401);

  // rotation:旧 token 吊销 + 新 token
  const now = nowMs();
  const newRefresh = generateRefreshToken();
  const newHash = hashRefreshToken(newRefresh);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").bind(tokenHash),
    c.env.DB.prepare(
      "INSERT INTO sessions (id, account_id, device_id, expires_at, revoked, rotated_from, created_at) VALUES (?,?,?,?,0,?,?)"
    ).bind(newHash, row.account_id, row.device_id, now + REFRESH_TTL_MS, tokenHash, now),
  ]);

  const access = await signAccessToken(c.env.JWT_PRIVATE_KEY, row.account_id, row.device_id);
  return c.json({ access_token: access, refresh_token: newRefresh, expires_in: 900 });
});

authRoutes.post("/logout", async (c) => {
  const parsed = RefreshSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: true }); // 幂等
  const tokenHash = hashRefreshToken(parsed.data.refresh_token);
  await c.env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?")
    .bind(tokenHash)
    .run();
  return c.json({ ok: true });
});
