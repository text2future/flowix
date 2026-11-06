/**
 * Cloud model access messages (in-conversation cards + the shared payment dialog),
 * split out of the frozen main table.
 *
 * The main `messages.*` tables are frozen at a hard line limit; new copy for the
 * Cloud access cards and the billing dialog lives here so adding a message never
 * grows them.
 */
const zhCN = {
  "agent.cloudAccess.signedOut.title": "登录后继续使用该模型",
  "agent.cloudAccess.signedOut.description": "该模型由 Flowix Cloud 提供，登录账号后即可继续对话。",
  "agent.cloudAccess.signedOut.action": "登录",
  "agent.cloudAccess.noCredits.title": "点数不足",
  "agent.cloudAccess.noCredits.description": "当前模型的点数余额不足，购买点数后可继续对话。",
  "agent.cloudAccess.noCredits.action": "购买点数",
  "agent.cloudAccess.dismiss": "关闭提示",
  "agent.error.guidance.quota_exhausted": "当前账户的额度或点数已用尽，补充后可重新发送本次请求。",
  "billing.dialog.title": "购买",
  "billing.dialog.tab.membership": "会员",
  "billing.dialog.tab.credits": "点数",
  "billing.dialog.close": "关闭",
  "billing.dialog.loading": "正在加载商品…",
  "billing.dialog.error": "商品加载失败，请稍后重试",
  "billing.dialog.retry": "重试",
  "billing.dialog.empty.membership": "暂无可购买的会员方案",
  "billing.dialog.empty.credits": "暂无可购买的点数包",
  "billing.dialog.purchase": "立即购买",
  "billing.dialog.pendingOrder": "有订单待支付，请先完成或取消该订单",
  "billing.dialog.creditsAmount": "{value} 点数",
  "billing.dialog.creditsNote": "点数按模型倍率消耗，余额随用随扣。",
  "billing.dialog.membershipNote": "会员同时包含云存储额度，AI 使用仍按点数余额扣减。",
  "billing.dialog.perYear": "每年",
  "billing.dialog.perOnce": "一次性",
} as const;

export default zhCN;
