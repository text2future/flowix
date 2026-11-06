'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';

import { cloud, type CloudProduct } from '@platform/tauri/client';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import {
  BILLING_TABS,
  creditsOf,
  formatBillingPrice,
  groupBillingProducts,
  type BillingTab,
} from '../model/billing-products';

export interface PaymentDialogProps {
  initialTab: BillingTab;
  onClose: () => void;
}

function cycleLabelKey(product: CloudProduct): 'billing.dialog.perYear' | 'billing.dialog.perOnce' | null {
  if (product.billingType === 'one_time') return 'billing.dialog.perOnce';
  const duration = product.entitlement?.duration;
  if (duration?.unit === 'year') return 'billing.dialog.perYear';
  return null;
}

/**
 * The single purchase surface for Cloud billing: membership plans and credit
 * packs side by side. Both shelves read the same catalog and the same checkout
 * command, so a new pack or plan never needs a bespoke screen.
 */
export function PaymentDialog({ initialTab, onClose }: PaymentDialogProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<BillingTab>(initialTab);
  const [products, setProducts] = useState<CloudProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const buyingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setProducts(null);
    try {
      setProducts(await cloud.listProducts());
    } catch (value) {
      setError(cloudSyncErrorMessage(value, t, 'errors.friendly.checkout'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !buyingRef.current) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('[data-payment-initial-focus]')?.focus();
  }, []);

  const groups = useMemo(
    () => groupBillingProducts(products ?? []),
    [products],
  );
  const activeProducts = tab === 'credits' ? groups.credits : groups.membership;

  const buy = async (product: CloudProduct) => {
    if (buyingRef.current) return;
    buyingRef.current = true;
    setBuyingId(product.id);
    try {
      const checkout = await cloud.createCheckout(product.id);
      if (checkout.checkoutUrl) await openUrl(checkout.checkoutUrl);
      onClose();
    } catch (value) {
      setError(cloudSyncErrorMessage(value, t, 'errors.friendly.checkout'));
    } finally {
      buyingRef.current = false;
      setBuyingId(null);
    }
  };

  return (
    <div
      className="payment-dialog__overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !buyingRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="payment-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('billing.dialog.title')}
      >
        <header className="payment-dialog__header">
          <div className="payment-dialog__title">{t('billing.dialog.title')}</div>
          <button
            type="button"
            className="payment-dialog__close"
            aria-label={t('billing.dialog.close')}
            title={t('billing.dialog.close')}
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="payment-dialog__tabs" role="tablist" aria-label={t('billing.dialog.title')}>
          {BILLING_TABS.map((value) => {
            const label = value === 'credits'
              ? t('billing.dialog.tab.credits')
              : t('billing.dialog.tab.membership');
            return (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                data-payment-initial-focus={tab === value ? '' : undefined}
                className={cn('payment-dialog__tab', tab === value && 'is-active')}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="payment-dialog__body" role="tabpanel">
          {products === null && !error && (
            <div className="payment-dialog__state">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>{t('billing.dialog.loading')}</span>
            </div>
          )}

          {error && (
            <div className="payment-dialog__state payment-dialog__state--error">
              <span>{error}</span>
              <Button type="button" variant="ghost" className="h-8" onClick={() => void load()}>
                {t('billing.dialog.retry')}
              </Button>
            </div>
          )}

          {products !== null && activeProducts.length === 0 && (
            <div className="payment-dialog__state">
              {t(tab === 'credits' ? 'billing.dialog.empty.credits' : 'billing.dialog.empty.membership')}
            </div>
          )}

          {activeProducts.length > 0 && (
            <ul className="payment-dialog__list">
              {activeProducts.map((product) => {
                const credits = creditsOf(product);
                const cycle = cycleLabelKey(product);
                return (
                  <li key={product.id} className="payment-dialog__product">
                    <div className="payment-dialog__product-main">
                      <div className="payment-dialog__product-name">
                        {credits === null
                          ? product.name
                          : t('billing.dialog.creditsAmount', { value: credits.toLocaleString() })}
                      </div>
                      {product.description && (
                        <div className="payment-dialog__product-description">{product.description}</div>
                      )}
                      <div className="payment-dialog__product-price">
                        <span className="payment-dialog__amount">{formatBillingPrice(product.price)}</span>
                        {cycle && <span className="payment-dialog__cycle">{t(cycle)}</span>}
                      </div>
                    </div>
                    <Button
                      type="button"
                      className="h-9 shrink-0 rounded-lg"
                      disabled={buyingId !== null}
                      onClick={() => void buy(product)}
                    >
                      {buyingId === product.id && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                      {t('billing.dialog.purchase')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="payment-dialog__footer">
          {t(tab === 'credits' ? 'billing.dialog.creditsNote' : 'billing.dialog.membershipNote')}
        </footer>
      </div>
    </div>
  );
}
