import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { generateKeyPairSync } from "node:crypto";

// 测试用 RSA 密钥对(进程级生成,非生产密钥)
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const JWT_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }) as string;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["DB"],
        r2Buckets: ["BUCKET"],
        kvNamespaces: ["KV"],
        bindings: {
          JWT_PRIVATE_KEY,
          JWT_PUBLIC_KEY,
          TURNSTILE_SECRET_KEY: "", // 空 = 跳过 Turnstile 校验
          GC_SECRET: "test-gc-secret",
          STRIPE_SECRET_KEY: "sk_test_unused",
          STRIPE_WEBHOOK_SECRET: "whsec_unused",
          STRIPE_PRICE_PRO_MONTH: "price_test_month",
          STRIPE_PRICE_PRO_YEAR: "price_test_year",
          APP_BASE_URL: "http://localhost:1420",
          RATE_LIMIT_DISABLED: true,
        },
      },
    }),
  ],
});
