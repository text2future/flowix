import Stripe from "stripe";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Bindings } from "../env";
import { authMiddleware } from "../middleware/auth";
import { nowMs } from "../lib/id";

export const billingRoutes = new Hono<AppEnv>();
billingRoutes.use("*", authMiddleware);

function stripe(env: Bindings): Stripe {
  // Workers 无 Node http,用 fetch-based httpClient
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

const CheckoutSchema = z.object({
  interval: z.enum(["month", "year"]),
});

// 创建 Stripe Checkout(订阅 Pro)。自动创建/复用 customer。
billingRoutes.post("/checkout", async (c) => {
  const accountId = c.get("account_id");
  const parsed = CheckoutSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request" }, 400);
  const priceId =
    parsed.data.interval === "month"
      ? c.env.STRIPE_PRICE_PRO_MONTH
      : c.env.STRIPE_PRICE_PRO_YEAR;
  if (!priceId || priceId.startsWith("REPLACE_"))
    return c.json({ error: "price_not_configured" }, 500);

  const existing = await c.env.DB.prepare(
    "SELECT stripe_customer_id FROM subscriptions WHERE account_id = ?"
  )
    .bind(accountId)
    .first<{ stripe_customer_id: string | null }>();

  const s = stripe(c.env);
  let customerId = existing?.stripe_customer_id ?? null;
  if (!customerId) {
    const acct = await c.env.DB.prepare("SELECT email FROM accounts WHERE id = ?")
      .bind(accountId)
      .first<{ email: string }>();
    const customer = await s.customers.create({
      email: acct?.email,
      metadata: { account_id: accountId },
    });
    customerId = customer.id;
    await c.env.DB.prepare(
      `INSERT INTO subscriptions (account_id, stripe_customer_id, plan, status, updated_at)
       VALUES (?,?, 'pro', 'inactive', ?)
       ON CONFLICT(account_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id`
    )
      .bind(accountId, customerId, nowMs())
      .run();
  }

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: accountId,
    metadata: { account_id: accountId },
    success_url: `${c.env.APP_BASE_URL}/settings/sync?checkout=success`,
    cancel_url: `${c.env.APP_BASE_URL}/settings/sync?checkout=cancel`,
  });
  return c.json({ url: session.url });
});

// Stripe Customer Portal:用户自助管理/取消/换周期
billingRoutes.post("/portal", async (c) => {
  const accountId = c.get("account_id");
  const row = await c.env.DB.prepare(
    "SELECT stripe_customer_id FROM subscriptions WHERE account_id = ?"
  )
    .bind(accountId)
    .first<{ stripe_customer_id: string | null }>();
  if (!row?.stripe_customer_id) return c.json({ error: "no_subscription" }, 400);
  const session = await stripe(c.env).billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${c.env.APP_BASE_URL}/settings/sync`,
  });
  return c.json({ url: session.url });
});
