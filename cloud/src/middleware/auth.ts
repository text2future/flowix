// JWT 验证中间件:解析 Bearer token -> 注入 account_id / device_id 到 c.var。
// 所有需登录的路由挂在子 app 上:subApp.use("*", authMiddleware)。
import { createMiddleware } from "hono/factory";
import { importSPKI, jwtVerify } from "jose";
import type { AppEnv } from "../env";

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "missing_token" }, 401);
  try {
    const pub = await importSPKI(c.env.JWT_PUBLIC_KEY, "RS256");
    const { payload } = await jwtVerify(token, pub, { algorithms: ["RS256"] });
    const accountId = payload.account_id;
    const deviceId = payload.device_id;
    if (typeof accountId !== "string" || typeof deviceId !== "string") {
      return c.json({ error: "invalid_token" }, 401);
    }
    c.set("account_id", accountId);
    c.set("device_id", deviceId);
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
  await next();
});
