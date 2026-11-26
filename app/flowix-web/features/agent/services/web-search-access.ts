import { cloud } from '@platform/tauri/client';

export { enableWebSearchAfterMembershipPurchase, PI_FEATURES_CHANGED_EVENT } from '@/lib/pi-feature-settings';

export type WebSearchAccessResult =
  | { allowed: true }
  | { allowed: false; reason: 'signed_out' | 'no_credits' };

/** Check the account and current credit balance before enabling web search. */
export async function checkWebSearchAccess(): Promise<WebSearchAccessResult> {
  // Pi's account id is synchronized from cloud-state events and may not have
  // been initialized yet when settings are opened. Read the authoritative
  // account snapshot so a signed-in user is not mistaken for a guest.
  const cloudState = await cloud.getState();
  if (!cloudState.authenticated) {
    return { allowed: false, reason: 'signed_out' };
  }

  const balance = await cloud.getAiCreditBalance();
  return balance.balanceMicrocredits > 0
    ? { allowed: true }
    : { allowed: false, reason: 'no_credits' };
}
