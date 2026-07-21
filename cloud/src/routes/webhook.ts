import Stripe from "stripe";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../env";
import { QUOTA_BYTES } from "../protocol";
import { nowMs } from "../lib/id";

// Stripe Webhook:不挂 authMiddleware,靠验签 + 幂等。
export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.post("/stripe", async (c) => {
  const sig = c.req.header("stripe-signature");
  if (!sig) return c.json({ error: "missing_signature" }, 400);
  const raw = await c.req.text();
  const s = new Stripe(c.env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(raw, sig, c.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return c.json({ error: "invalid_signature" }, 400);
  }

  // 幂等:按 event id 去重
  const seen = await c.env.DB.prepare("SELECT id FROM webhook_events WHERE id = ?")
    .bind(event.id)
    .first();
  if (seen) return c.json({ ok: true, deduplicated: true });
  await c.env.DB.prepare("INSERT INTO webhook_events (id, processed_at) VALUES (?,?)")
    .bind(event.id, nowMs())
    .run();

  switch (event.type) {
    case "checkout.session.completed": {
      const sess = event.data.object as Stripe.Checkout.Session;
      const accountId = sess.metadata?.account_id ?? sess.client_reference_id ?? null;
      if (accountId) {
        await c.env.DB.prepare(
          `INSERT INTO subscriptions (account_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at)
           VALUES (?,?,?,?, 'active', ?)
           ON CONFLICT(account_id) DO UPDATE SET
             stripe_customer_id = coalesce(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
             stripe_subscription_id = excluded.stripe_subscription_id,
             status = 'active', updated_at = excluded.updated_at`
        )
          .bind(accountId, sess.customer as string, sess.subscription as string, "pro", nowMs())
          .run();
        await upgradeToPro(c.env, accountId);
      }
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const row = await c.env.DB.prepare(
        "SELECT account_id FROM subscriptions WHERE stripe_customer_id = ?"
      )
        .bind(inv.customer as string)
        .first<{ account_id: string }>();
      if (row) {
        await c.env.DB.prepare(
          "UPDATE subscriptions SET status = 'active', current_period_end = ?, updated_at = ? WHERE account_id = ?"
        )
          .bind(inv.period_end ?? null, nowMs(), row.account_id)
          .run();
        await upgradeToPro(c.env, row.account_id);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const row = await c.env.DB.prepare(
        "SELECT account_id FROM subscriptions WHERE stripe_customer_id = ?"
      )
        .bind(sub.customer as string)
        .first<{ account_id: string }>();
      if (row) {
        const status = sub.status;
        await c.env.DB.prepare(
          "UPDATE subscriptions SET status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ? WHERE account_id = ?"
        )
          .bind(
            status,
            sub.current_period_end ?? null,
            sub.cancel_at_period_end ? 1 : 0,
            nowMs(),
            row.account_id
          )
          .run();
        // 取消/失效/未支付 -> 降级 free(数据保留,超配走只读)
        const inactive =
          ["canceled", "unpaid", "incomplete_expired"].includes(status) ||
          sub.ended_at !== null;
        if (inactive) await downgradeToFree(c.env, row.account_id);
      }
      break;
    }
    default:
      break;
  }

  return c.json({ ok: true });
});

async function upgradeToPro(env: Bindings, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET plan = ?, quota_bytes = ?, updated_at = ? WHERE id = ?")
    .bind("pro", QUOTA_BYTES.pro, nowMs(), accountId)
    .run();
}

async function downgradeToFree(env: Bindings, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET plan = ?, quota_bytes = ?, updated_at = ? WHERE id = ?")
    .bind("free", QUOTA_BYTES.free, nowMs(), accountId)
    .run();
}
