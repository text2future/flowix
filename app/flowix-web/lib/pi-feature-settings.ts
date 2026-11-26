import { piModels } from '@platform/tauri/client';

export const PI_FEATURES_CHANGED_EVENT = 'flowix:pi-features-changed';

/** Enable Pi web search after a confirmed AI membership purchase. */
export async function enableWebSearchAfterMembershipPurchase(): Promise<boolean> {
  const features = await piModels.getFeatures();
  if (!features.webSearch) {
    await piModels.saveFeatures({ webSearch: true });
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PI_FEATURES_CHANGED_EVENT));
  }
  return !features.webSearch;
}
