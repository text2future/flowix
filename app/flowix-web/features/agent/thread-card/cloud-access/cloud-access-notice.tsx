'use client';

import { useEffect, useMemo, useRef } from 'react';

import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { windows } from '@platform/tauri/client';
import { openPaymentDialog } from '@features/cloud-billing/public/payment-dialog';
import { useAgentCloudAccessStore } from '@features/agent/store/agent-cloud-access-store';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import { createCloudAccessCard, type CloudAccessCard } from './cloud-access-card';
import {
  hideEmptyState,
  observeMessageStream,
  revealInMessageStream,
} from './message-stream-slot';

export interface CloudAccessNoticeProps {
  /** Store key of the conversation owning the notice. */
  accessKey: string | null;
  agentType: AgentTypeKey;
  /**
   * Scrolling message stream. The card becomes the last conversation row (right
   * above the thinking row), so a send that could not run reads as part of the
   * transcript instead of a dialog over the composer. Nothing renders in the
   * React tree.
   */
  mount: HTMLElement | null;
}

/**
 * React mount of the shared Cloud access card.
 *
 * The markup lives in `createCloudAccessCard` so the note-embedded Thread Card
 * (a ProseMirror NodeView) and this standalone page cannot drift apart. The
 * prompt that could not run is already a normal message row, so this component
 * only owns the card that answers it.
 */
export function CloudAccessNotice({ accessKey, agentType, mount }: CloudAccessNoticeProps) {
  const { t } = useI18n();
  const entries = useAgentCloudAccessStore((state) => state.entries);
  const authenticated = useAgentDataStore((state) => !!state.piCloudAccountId);
  const accessKeyRef = useRef<string | null>(accessKey);
  accessKeyRef.current = accessKey;

  const clear = (): void => {
    const key = accessKeyRef.current;
    if (key) useAgentCloudAccessStore.getState().clearAccess(key);
  };

  const parts = useMemo(() => {
    const wrapper = document.createElement('div');
    wrapper.className = 'agent-thread-card__cloud-access';
    wrapper.hidden = true;
    const card: CloudAccessCard = createCloudAccessCard({
      t: (key) => t(key),
      onSignIn: () => {
        clear();
        void windows.openPreferences('cloudSync');
      },
      onBuyCredits: () => {
        void openPaymentDialog('credits');
      },
    });
    wrapper.append(card.el);
    return { wrapper, card };
  }, [t]);

  const stored = accessKey ? entries[accessKey] ?? null : null;
  // Signing in resolves the signed-out notice without waiting for a new run.
  const kind = stored === 'signed_out' && authenticated ? null : stored;
  const visible = agentType === 'pi' && kind !== null;

  useEffect(() => {
    parts.card.render(visible ? kind : null);
    parts.wrapper.hidden = !visible;
    // A visible notice is message state: the welcome block of an empty
    // conversation gives way while the card is on screen.
    hideEmptyState(mount, visible);
  }, [kind, mount, parts, visible]);

  useEffect(() => {
    if (!mount) return undefined;
    // The message renderer owns the stream and restructures it on every render,
    // so follow it instead of attaching once. A blocked send runs nothing, so
    // reveal the card explicitly instead of waiting for a scroll.
    const detach = observeMessageStream(parts.wrapper, mount, (stream) => {
      hideEmptyState(stream, visible);
    });
    if (visible) revealInMessageStream(parts.wrapper, mount);
    return detach;
  }, [mount, parts, visible]);

  useEffect(() => () => parts.wrapper.remove(), [parts]);

  return null;
}
