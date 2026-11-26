'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cloud, type CloudMembership } from '@platform/tauri/client';

export function useWechatPaymentStatus(orderId: string | undefined, onConfirmed?: (membership: CloudMembership | null) => void) {
  const [status, setStatus] = useState<'waiting' | 'checking' | 'pending' | 'paid' | 'paidRefreshFailed' | 'checkFailed'>('waiting');
  const confirmed = useRef(onConfirmed);
  const currentOrder = useRef(orderId);
  const checkingOrder = useRef<string | null>(null);
  currentOrder.current = orderId;
  confirmed.current = onConfirmed;

  useEffect(() => { setStatus('waiting'); }, [orderId]);

  const refresh = useCallback(async () => {
    if (!orderId || checkingOrder.current === orderId) return;
    checkingOrder.current = orderId;
    setStatus('checking');
    try {
      const orders = await cloud.listBillingOrders();
      if (currentOrder.current !== orderId) return;
      const order = orders.find((item) => item.id === orderId);
      if (!order) { setStatus('checkFailed'); return; }
      if (order.status !== 'paid') { setStatus('pending'); return; }
      void cloud.getAiCreditBalance().catch(() => {});
      let membership: CloudMembership | null = null;
      try { membership = await cloud.refreshMembership(); } catch { /* The payment still succeeded. */ }
      if (currentOrder.current === orderId) {
        setStatus(membership ? 'paid' : 'paidRefreshFailed');
        confirmed.current?.(membership);
      }
    } catch {
      if (currentOrder.current === orderId) setStatus('checkFailed');
    } finally {
      if (checkingOrder.current === orderId) checkingOrder.current = null;
    }
  }, [orderId]);

  useEffect(() => {
    if (!orderId || status === 'paid' || status === 'paidRefreshFailed') return;
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [orderId, refresh, status]);

  return { status, refresh };
}
