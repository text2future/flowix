import type { Root } from 'react-dom/client';

import type { BillingTab } from '../model/billing-products';
export type { BillingTab };

/**
 * Mount the shared payment dialog on demand.
 *
 * The dialog is a React tree on `document.body` so it can be opened from either
 * imperative surfaces (Thread Card cards) or React screens without duplicating
 * markup. It is loaded lazily: nothing here is part of the startup bundle.
 */
interface MountedPaymentDialog {
  container: HTMLElement;
  root: Root;
  render: (tab: BillingTab) => void;
}

let mounted: MountedPaymentDialog | null = null;

export async function openPaymentDialog(tab: BillingTab = 'membership'): Promise<void> {
  if (typeof document === 'undefined') return;
  if (mounted) {
    mounted.render(tab);
    return;
  }
  const [{ createRoot }, React, { PaymentDialog }] = await Promise.all([
    import('react-dom/client'),
    import('react'),
    import('../components/payment-dialog'),
  ]);
  const container = document.createElement('div');
  container.className = 'payment-dialog-root';
  document.body.append(container);
  const root = createRoot(container);
  const close = () => {
    if (!mounted) return;
    mounted = null;
    root.unmount();
    container.remove();
  };
  const render = (nextTab: BillingTab) => {
    // `key` keeps the tab prop authoritative when the dialog is already open.
    root.render(React.createElement(PaymentDialog, {
      key: nextTab,
      initialTab: nextTab,
      onClose: close,
    }));
  };
  mounted = { container, root, render };
  render(tab);
}

/** Test seam: true while the dialog is mounted. */
export function isPaymentDialogOpen(): boolean {
  return mounted !== null;
}
