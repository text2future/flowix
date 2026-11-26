import { cloud } from '@platform/tauri/client';
import { enableWebSearchAfterMembershipPurchase } from '@/lib/pi-feature-settings';

const STORAGE_KEY = 'flowix.ai-membership-pending-order.v1';
const POLL_MS = 15_000;
const ORDER_CHECK_MS = 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingPurchase {
  orderId: string;
  userId: string;
  createdAt: number;
  hosted: boolean;
}

let stopCurrentWatch: (() => void) | null = null;

function readPending(): PendingPurchase | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as PendingPurchase | null;
    if (value && typeof value.orderId === 'string' && typeof value.userId === 'string'
      && typeof value.createdAt === 'number' && typeof value.hosted === 'boolean'
      && Date.now() - value.createdAt < MAX_AGE_MS) return value;
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* Storage is unavailable or the entry is invalid. */ }
  return null;
}

function track(pending: PendingPurchase, onEnabled?: () => void): () => void {
  stopCurrentWatch?.();
  let active = true;
  let checking = false;
  let lastOrderCheck = 0;
  let timer: number | undefined;

  const stop = (clear = false) => {
    active = false;
    if (timer !== undefined) window.clearTimeout(timer);
    window.removeEventListener('focus', onFocus);
    if (clear) {
      try {
        if (readPending()?.orderId === pending.orderId) localStorage.removeItem(STORAGE_KEY);
      } catch { /* Storage is unavailable. */ }
    }
    if (stopCurrentWatch === cancel) stopCurrentWatch = null;
  };
  const cancel = () => stop(true);

  const check = async () => {
    if (!active || checking) return;
    checking = true;
    try {
      const state = await cloud.getState();
      if (!active || !state.authenticated || state.account?.user.id !== pending.userId) return;
      const orders = await cloud.listBillingOrders();
      if (!active) return;
      const order = orders.find((item) => item.id === pending.orderId);
      if (!order) return;
      if (['closed', 'expired', 'refunded'].includes(order.status)) {
        stop(true);
        return;
      }
      let paid = order.status === 'paid';
      if (!paid && pending.hosted && Date.now() - lastOrderCheck >= ORDER_CHECK_MS) {
        lastOrderCheck = Date.now();
        paid = (await cloud.checkBillingOrder(pending.orderId)).confirmed;
      }
      if (!active || !paid) return;
      void cloud.getAiCreditBalance().catch(() => {});
      const membership = await cloud.refreshMembership();
      const latest = await cloud.getState();
      if (!active || latest.account?.user.id !== pending.userId || !latest.authenticated
        || membership.aiActive !== true) return;
      const enabled = await enableWebSearchAfterMembershipPurchase();
      if (!active) return;
      stop(true);
      if (enabled) onEnabled?.();
    } catch {
      // Leave the order pending and retry when connectivity returns.
    } finally {
      checking = false;
      if (active) timer = window.setTimeout(() => void check(), POLL_MS);
    }
  };
  function onFocus() {
    if (timer !== undefined) window.clearTimeout(timer);
    void check();
  }
  window.addEventListener('focus', onFocus);
  stopCurrentWatch = cancel;
  void check();
  return cancel;
}

/** Track a checkout across dialog closure and application restarts. */
export async function watchAiMembershipPurchase(
  orderId: string,
  hosted: boolean,
  onEnabled?: () => void,
): Promise<() => void> {
  const state = await cloud.getState();
  const userId = state.authenticated ? state.account?.user.id : undefined;
  if (!userId) throw new Error('Cloud account is unavailable');
  const pending = { orderId, userId, hosted, createdAt: Date.now() };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pending)); } catch { /* Track this session in memory. */ }
  return track(pending, onEnabled);
}

/** Resume an unfinished checkout when the main window starts. */
export function resumeAiMembershipPurchase(onEnabled?: () => void): () => void {
  const pending = readPending();
  if (!pending || stopCurrentWatch) return () => {};
  const cancel = track(pending, onEnabled);
  return () => {
    // Unmounting stops polling but keeps the order for the next startup.
    if (stopCurrentWatch === cancel) {
      const entry = readPending();
      cancel();
      if (entry) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entry)); } catch { /* Unavailable. */ }
      }
    }
  };
}
