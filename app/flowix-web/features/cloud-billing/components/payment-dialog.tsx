'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';

import { cloud, type CloudProduct } from '@platform/tauri/client';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@shared/ui/dialog';
import {
  DIALOG_SURFACE_CLASS,
  dialogActionClasses,
} from '@shared/ui/dialog-styles';
import {
  creditsOf,
  formatBillingPrice,
  groupBillingProducts,
  isMembershipProduct,
  type BillingTab,
} from '../model/billing-products';
import { getImmediateBillingProducts, loadBillingProducts } from '../public/product-catalog';

export interface PaymentDialogProps {
  initialTab: BillingTab;
  onClose: () => void;
}

/**
 * Shell classes follow the standard dialog spec (the create-notebook dialog is
 * the reference): same surface, overlay, heading scale and close-button
 * placement. Sizing lives in `.payment-dialog` (payment-dialog.css) so it does
 * not depend on JIT-generated utilities.
 */
const PAYMENT_DIALOG_CONTENT_CLASS = cn(
  'payment-dialog',
  DIALOG_SURFACE_CLASS,
  'p-0',
);

const PURCHASE_ACTION_CLASS = dialogActionClasses('brand');
const SECONDARY_ACTION_CLASS = dialogActionClasses('secondary');

function cycleLabelKey(product: CloudProduct): 'billing.dialog.perYear' | 'billing.dialog.perMonth' | 'billing.dialog.perOnce' | null {
  if (product.billingType === 'one_time') return 'billing.dialog.perOnce';
  const duration = product.entitlement?.duration;
  if (duration?.unit === 'year') return 'billing.dialog.perYear';
  if (duration?.unit === 'month') return 'billing.dialog.perMonth';
  return null;
}

function formatStorageCapacity(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let capacity = value;
  let unitIndex = 0;
  while (capacity >= 1024 && unitIndex < units.length - 1) {
    capacity /= 1024;
    unitIndex += 1;
  }
  const formatted = Number.isInteger(capacity) ? String(capacity) : capacity.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}

/**
 * The single purchase surface for Cloud billing: membership plans and credit
 * packs side by side. Both shelves read the same catalog and the same checkout
 * command, so a new pack or plan never needs a bespoke screen.
 */
export function PaymentDialog({ initialTab, onClose }: PaymentDialogProps) {
  const { t } = useI18n();
  const [products, setProducts] = useState<CloudProduct[] | null>(() => getImmediateBillingProducts());
  const [error, setError] = useState<string | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [activeSubscriptionIds, setActiveSubscriptionIds] = useState<Set<string>>(() => new Set());
  const [activeMembership, setActiveMembership] = useState<Awaited<ReturnType<typeof cloud.refreshMembership>> | null>(null);
  const buyingRef = useRef(false);
  const bodyRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (force = false) => {
    setError(null);
    try {
      await loadBillingProducts(setProducts, force);
    } catch (value) {
      setError(cloudSyncErrorMessage(value, t, 'errors.friendly.checkout'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (typeof cloud.refreshMembership !== 'function' || typeof cloud.listSubscriptions !== 'function') return;
    let mounted = true;
    void Promise.all([cloud.refreshMembership(), cloud.listSubscriptions()])
      .then(([membership, subscriptions]) => {
        if (!mounted) return;
        setActiveMembership(membership);
        setActiveSubscriptionIds(new Set(subscriptions
          .filter((subscription) => subscription.currentPeriodEnd != null
            ? subscription.currentPeriodEnd > Date.now()
            : ['active', 'trialing', 'past_due'].includes(subscription.status))
          .map((subscription) => subscription.productId)
          .filter((productId): productId is string => Boolean(productId))));
      })
      .catch(() => {
        // Keep purchase options available if the account state cannot be refreshed.
      });
    return () => { mounted = false; };
  }, []);

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
    bodyRef.current?.querySelector<HTMLElement>('[data-payment-initial-focus]')?.focus();
  }, []);

  const groups = useMemo(
    () => groupBillingProducts(products ?? []),
    [products],
  );
  const displayProducts = useMemo(() => [
    ...groups.credits,
    ...groups.membership.filter((product) => product.entitlement?.features?.lifetime !== true),
    ...groups.membership.filter((product) => product.entitlement?.features?.lifetime === true),
  ], [groups]);
  const initialFocusProductId = (initialTab === 'credits' ? groups.credits[0] : groups.membership[0])?.id
    ?? displayProducts[0]?.id;

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
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-labelledby="flowix-payment-dialog-title"
        className={PAYMENT_DIALOG_CONTENT_CLASS}
        closeDisabled={buyingId !== null}
      >
        <main ref={bodyRef} className="relative z-[1] w-full px-5 py-6">
          <DialogTitle id="flowix-payment-dialog-title" className="mb-3">
            {t('billing.dialog.title')}
          </DialogTitle>

          <div className="payment-dialog__body">
            {products === null && !error && (
              <div className="payment-dialog__state">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>{t('billing.dialog.loading')}</span>
              </div>
            )}

            {error && (
              <div className="payment-dialog__state payment-dialog__state--error">
                <span>{error}</span>
                <button
                  type="button"
                  className={cn(SECONDARY_ACTION_CLASS, 'h-8 min-h-0 px-3 text-xs')}
                  onClick={() => void load(true)}
                >
                  {t('billing.dialog.retry')}
                </button>
              </div>
            )}

            {products !== null && displayProducts.length === 0 && (
              <div className="payment-dialog__state">
                {t('billing.dialog.empty.all')}
              </div>
            )}

            {displayProducts.length > 0 && (
              <div className="payment-dialog__list-container">
                <ul className="payment-dialog__list">
                  {displayProducts.map((product) => {
                  const credits = creditsOf(product);
                  const cycle = cycleLabelKey(product);
                  const features = product.entitlement?.features ?? {};
                  // Classification comes from the catalog's entitlementKind
                  // (with a legacy feature fallback), never from the credit
                  // denomination alone. `credits` is only a display amount.
                  const isStoragePlan = isMembershipProduct(product);
                  const isAiPlan = !isStoragePlan;
                  const isCurrent = activeSubscriptionIds.has(product.id)
                    || (isStoragePlan
                      && features.lifetime === true
                      && activeMembership?.active === true
                      && activeMembership.features?.lifetime === true);
                  const isCoveredByLifetime = isStoragePlan
                    && features.lifetime !== true
                    && activeMembership?.active === true
                    && activeMembership.features?.lifetime === true
                    && !activeSubscriptionIds.has(product.id);
                  const productTitle = isAiPlan
                    ? t('billing.dialog.product.aiMembership')
                    : features.lifetime === true
                      ? t('billing.dialog.product.storageLifetime')
                      : t('billing.dialog.product.storageExperience');
                  const productDescription = isAiPlan
                    ? t('billing.dialog.product.aiMembershipDescription')
                    : features.lifetime === true
                      ? t('billing.dialog.product.storageLifetimeDescription')
                      : t('billing.dialog.product.storageExperienceDescription');
                  const storageCapacity = formatStorageCapacity(product.entitlement?.storageBytes ?? 0);
                  const benefits = isAiPlan
                    ? [
                      ...(credits !== null
                        ? [t('billing.dialog.aiBenefit.credits', { value: credits.toLocaleString() })]
                        : []),
                      t('billing.dialog.aiBenefit.models'),
                    ]
                    : [
                      // 组合商品：云存储主类型同时赠送点数，两条都列出来，别让它看起来只是存储包。
                      ...(credits !== null
                        ? [t('billing.dialog.aiBenefit.credits', { value: credits.toLocaleString() })]
                        : []),
                      t('preferences.cloud.totalStorage', { capacity: storageCapacity }),
                      t('preferences.cloud.unlimitedSyncedNotebooks'),
                      t('preferences.cloud.maximumFileSize', {
                        size: features.lifetime === true ? '100 MB' : '5 MB',
                      }),
                      ...(['memberThemes'] as const)
                        .map((benefit) => t(`preferences.cloud.plan.benefit.${benefit}`)),
                      t('billing.dialog.storageBenefit.localAi'),
                      ...(['mcpCli', 'earlyAccess'] as const)
                        .map((benefit) => t(`preferences.cloud.plan.benefit.${benefit}`)),
                      t('billing.dialog.storageBenefit.futureFeatures'),
                      t('billing.dialog.storageBenefit.permanentData'),
                    ];
                  return (
                    <li
                      key={product.id}
                      className={cn(
                        'payment-dialog__product',
                        isAiPlan && 'payment-dialog__product--ai',
                        isStoragePlan && 'payment-dialog__product--storage',
                      )}
                    >
                      <div className="payment-dialog__product-main">
                        <div className="payment-dialog__product-name">
                          {productTitle}
                        </div>
                        <div className="payment-dialog__product-description">
                          {productDescription}
                        </div>
                        <div className="payment-dialog__product-price">
                          <span className="payment-dialog__amount">{formatBillingPrice(product.price)}</span>
                          {cycle && <span className="payment-dialog__cycle">{t(cycle)}</span>}
                        </div>
                        <button
                          type="button"
                          className={cn(
                            PURCHASE_ACTION_CLASS,
                            'payment-dialog__purchase relative mt-4 flex w-full items-center justify-center',
                            isStoragePlan && features.lifetime !== true && 'payment-dialog__purchase--white',
                            isStoragePlan && features.lifetime === true && 'payment-dialog__purchase--storage-long-term',
                            (isCurrent || isCoveredByLifetime) && 'payment-dialog__purchase--current',
                          )}
                          data-payment-initial-focus={product.id === initialFocusProductId ? '' : undefined}
                          disabled={isCurrent || isCoveredByLifetime || buyingId !== null || product.marketRegion === 'mainland'}
                          onClick={() => void buy(product)}
                        >
                          {buyingId === product.id && <Loader2 className="absolute right-3 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                          {t(isCurrent
                            ? 'billing.dialog.currentlyActive'
                            : isCoveredByLifetime
                              ? 'billing.dialog.downgradeUnsupported'
                              : product.marketRegion === 'mainland'
                                ? 'billing.dialog.wechatPending'
                                : 'billing.dialog.purchase')}
                        </button>
                        <div className="payment-dialog__benefits-title">
                          {t('preferences.cloud.plan.includes')}
                        </div>
                        <ul className="payment-dialog__benefits">
                          {benefits.map((benefit) => (
                            <li key={benefit}>
                              <Check aria-hidden="true" />
                              <span>{benefit}</span>
                            </li>
                          ))}
                        </ul>
                        {isAiPlan && (
                          <p className="payment-dialog__ai-note">
                            {t('billing.dialog.allProductsNote')}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                  })}
                </ul>
              </div>
            )}
          </div>

          <section className="payment-dialog__faq" aria-labelledby="payment-dialog-faq-title">
            <h3 id="payment-dialog-faq-title" className="payment-dialog__faq-title">
              {t('billing.dialog.faq.title')}
            </h3>
            <details className="payment-dialog__faq-item">
              <summary className="payment-dialog__faq-question">
                <span>{t('billing.dialog.faq.chooseVersion.question')}</span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <p className="payment-dialog__faq-answer">
                {t('billing.dialog.faq.chooseVersion.answer')}
              </p>
            </details>
            <details className="payment-dialog__faq-item">
              <summary className="payment-dialog__faq-question">
                <span>{t('billing.dialog.faq.credits.question')}</span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <p className="payment-dialog__faq-answer">
                {t('billing.dialog.faq.credits.answer')}
              </p>
            </details>
            <details className="payment-dialog__faq-item">
              <summary className="payment-dialog__faq-question">
                <span>{t('billing.dialog.faq.renewal.question')}</span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <p className="payment-dialog__faq-answer">
                {t('billing.dialog.faq.renewal.answer')}
              </p>
            </details>
          </section>

        </main>
      </DialogContent>
    </Dialog>
  );
}
