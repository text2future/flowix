'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cloud, type CloudMembership } from '@platform/tauri/client';

export function useWechatPaymentStatus(orderId: string | undefined, onConfirmed?: (membership: CloudMembership | null) => void) {
  const [status, setStatus] = useState<'waiting' | 'checking' | 'pending' | 'paid' | 'paidRefreshFailed' | 'checkFailed'>('waiting');
  const confirmed = useRef(onConfirmed);
  const currentOrder = useRef(orderId);
  currentOrder.current = orderId;
  confirmed.current = onConfirmed;

  useEffect(() => { setStatus('waiting'); }, [orderId]);

  const refresh = useCallback(async () => {
    if (!orderId || status === 'checking') return;
    setStatus('checking');
    try {
      const orders = await cloud.listBillingOrders();
      if (currentOrder.current !== orderId) return;
      const order = orders.find((item) => item.id === orderId);
      if (!order) { setStatus('checkFailed'); return; }
      if (order.status !== 'paid') { setStatus('pending'); return; }
      let membership: CloudMembership | null = null;
      try { membership = await cloud.refreshMembership(); } catch { /* The payment still succeeded. */ }
      if (currentOrder.current === orderId) {
        setStatus(membership ? 'paid' : 'paidRefreshFailed');
        confirmed.current?.(membership);
      }
    } catch {
      if (currentOrder.current === orderId) setStatus('checkFailed');
    }
  }, [orderId, status]);

  return { status, refresh };
}
