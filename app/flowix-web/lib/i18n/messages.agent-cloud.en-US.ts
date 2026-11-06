import type zhCN from './messages.agent-cloud.zh-CN';

/**
 * English counterpart of the Cloud access message shard. The type annotation keeps
 * its key set aligned with the zh-CN shard at compile time.
 */
const enUS: Record<keyof typeof zhCN, string> = {
  "agent.cloudAccess.signedOut.title": "Sign in to use cloud models",
  "agent.cloudAccess.signedOut.description": "Cloud models are provided by Flowix and cover mainstream models. Pick one in the composer or the model switcher.",
  "agent.cloudAccess.signedOut.action": "Sign in",
  "agent.cloudAccess.noCredits.title": "Not enough credits",
  "agent.cloudAccess.noCredits.description": "Your credit balance is too low for this model. Add credits to continue.",
  "agent.cloudAccess.noCredits.action": "Buy credits",
  "agent.error.guidance.quota_exhausted": "This account's quota or credits are exhausted. Top up and resend the request.",
  "billing.dialog.title": "Purchase",
  "billing.dialog.tab.membership": "Membership",
  "billing.dialog.tab.credits": "Credits",
  "billing.dialog.close": "Close",
  "billing.dialog.loading": "Loading products…",
  "billing.dialog.error": "Could not load products, try again later",
  "billing.dialog.retry": "Retry",
  "billing.dialog.empty.membership": "No membership plan is available",
  "billing.dialog.empty.credits": "No credit pack is available",
  "billing.dialog.purchase": "Buy now",
  "billing.dialog.pendingOrder": "An order is awaiting payment. Complete or cancel it first.",
  "billing.dialog.creditsAmount": "{value} credits",
  "billing.dialog.creditsNote": "Credits are consumed per model multiplier and deducted as you go.",
  "billing.dialog.membershipNote": "Membership also includes cloud storage; AI usage still draws from your credit balance.",
  "billing.dialog.perYear": "per year",
  "billing.dialog.perOnce": "one-time",
};

export default enUS;
