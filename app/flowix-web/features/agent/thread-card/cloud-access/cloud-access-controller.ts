import type { AgentTypeKey } from '@/types/agent';
import type { I18nKey } from '@/lib/i18n';
import { windows } from '@platform/tauri/client';
import { openPaymentDialog } from '@features/cloud-billing/public/payment-dialog';
import {
  deriveCloudAccess,
  signedOutAccessFor,
  type CloudAccessKind,
  type CloudAccessMessageLike,
} from '@features/agent/config/cloud-access';
import { useAgentCloudAccessStore } from '@features/agent/store/agent-cloud-access-store';
import { createCloudAccessCard, type CloudAccessCard } from './cloud-access-card';

export interface CloudAccessControllerOptions {
  /** Container created by the Thread Card DOM factory. */
  mount: HTMLElement;
  t: (key: I18nKey) => string;
  getTypeKey: () => AgentTypeKey;
  /** Durable conversation identity, falling back to a per-card key. */
  getAccessKey: () => string;
  getProviderId: () => string | undefined;
  isAuthenticated: () => boolean;
}

/**
 * Owns the Cloud access notice for one conversation surface.
 *
 * Kept out of the Thread Card view because that file is frozen: rendering the
 * card, deriving the state from failed turns and clearing it on sign-in are one
 * concern, not part of the view's layout work.
 */
export class CloudAccessController {
  private readonly mount: HTMLElement;
  private readonly card: CloudAccessCard;
  private readonly getTypeKey: () => AgentTypeKey;
  private readonly getAccessKey: () => string;
  private readonly getProviderId: () => string | undefined;
  private readonly isAuthenticated: () => boolean;
  private lastFailureMessageId: string | null = null;
  // Identity before the first run binds a thread id.
  private readonly fallbackKey = `card-${Math.random().toString(36).slice(2, 10)}`;

  constructor(options: CloudAccessControllerOptions) {
    this.mount = options.mount;
    this.getTypeKey = options.getTypeKey;
    this.getAccessKey = options.getAccessKey;
    this.getProviderId = options.getProviderId;
    this.isAuthenticated = options.isAuthenticated;
    this.card = createCloudAccessCard({
      t: options.t,
      onSignIn: () => {
        this.clear();
        void windows.openPreferences('cloudSync');
      },
      onBuyCredits: () => {
        void openPaymentDialog('credits');
      },
      onDismiss: () => this.clear(),
    });
    this.mount.append(this.card.el);
  }

  /** Recompute from the newest failed turn; an unchanged row keeps a dismissal. */
  sync(messages: readonly CloudAccessMessageLike[]): void {
    if (this.getTypeKey() !== 'pi') {
      this.render();
      return;
    }
    const derived = deriveCloudAccess(messages, {
      providerId: this.getProviderId(),
      authenticated: this.isAuthenticated(),
    });
    if (!derived) {
      if (this.lastFailureMessageId !== null) {
        this.lastFailureMessageId = null;
        this.clearStore();
      }
      this.render();
      return;
    }
    if (derived.messageId === this.lastFailureMessageId) {
      this.render();
      return;
    }
    this.lastFailureMessageId = derived.messageId;
    useAgentCloudAccessStore.getState().setAccess(this.accessKey(), derived.kind);
    this.render();
  }

  /** Block a submission that cannot run: a signed-out account has no credential. */
  blockSubmission(): CloudAccessKind | null {
    if (this.getTypeKey() !== 'pi') return null;
    const kind = signedOutAccessFor(this.getProviderId(), this.isAuthenticated());
    if (kind) this.show(kind);
    return kind;
  }

  /** Show a state directly, e.g. when the picker rejects a preview model. */
  show(kind: CloudAccessKind): void {
    useAgentCloudAccessStore.getState().setAccess(this.accessKey(), kind);
    this.render();
  }

  render(): void {
    const stored = useAgentCloudAccessStore.getState().entries[this.accessKey()];
    // Signing in resolves the signed-out notice without waiting for a new run.
    const kind = stored === 'signed_out' && this.isAuthenticated() ? null : stored ?? null;
    const visible = this.getTypeKey() === 'pi' && kind !== null;
    this.card.render(kind);
    this.mount.hidden = !visible;
  }

  private accessKey(): string {
    return this.getAccessKey() || this.fallbackKey;
  }

  dispose(): void {
    this.clearStore();
    this.card.el.remove();
  }

  private clear(): void {
    this.clearStore();
    // Keep the failing row id: the same failed turn must not reopen the notice
    // on the next render, only a newer failure may.
    this.render();
  }

  private clearStore(): void {
    useAgentCloudAccessStore.getState().clearAccess(this.accessKey());
  }
}
