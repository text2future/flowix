// Workers 绑定与 Hono 变量类型。
// 绑定来自 wrangler.jsonc;d1/r2/kv 类型由 @cloudflare/workers-types 提供。

export interface Bindings {
  // bindings
  DB: D1Database;
  BUCKET: R2Bucket;
  KV: KVNamespace;

  // vars (wrangler.jsonc)
  APP_BASE_URL: string;
  STRIPE_PRICE_PRO_MONTH: string;
  STRIPE_PRICE_PRO_YEAR: string;

  // secrets (wrangler secret put / .dev.vars)
  JWT_PRIVATE_KEY: string;
  JWT_PUBLIC_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  TURNSTILE_SECRET_KEY: string; // 可选:未配置则跳过 Turnstile 校验(开发期)
  GC_SECRET: string; // /internal/gc 鉴权
  RATE_LIMIT_DISABLED?: boolean; // 测试用:true 跳过限流(生产不设 = 启用)
}

// authMiddleware 注入:JWT 解出的主体
export interface Variables {
  account_id: string;
  device_id: string;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
