'use client';

import { useEffect, useRef } from 'react';

import type { AgentTypeKey } from '@/types/agent';
import { useI18n } from '@/lib/i18n';
import { windows } from '@platform/tauri/client';
import { openPaymentDialog } from '@features/cloud-billing/public/payment-dialog';
import { useAgentCloudAccessStore } from '@features/agent/store/agent-cloud-access-store';
import { useAgentDataStore } from '@features/agent/store/agent-data-store';
import { createCloudAccessCard, type CloudAccessCard } from './cloud-access-card';

export interface CloudAccessNoticeProps {
  /** Store key of the conversation owning the notice. */
  accessKey: string | null;
  agentType: AgentTypeKey;
}

/**
 * React mount of the shared Cloud access card.
 *
 * The markup lives in `createCloudAccessCard` so the note-embedded Thread Card
 * (a ProseMirror NodeView) and this standalone page cannot drift apart.
 */
export function CloudAccessNotice({ accessKey, agentType }: CloudAccessNoticeProps) {
  const { t } = useI18n();
  const entries = useAgentCloudAccessStore((state) => state.entries);
  const authenticated = useAgentDataStore((state) => !!state.piCloudAccountId);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<CloudAccessCard | null>(null);

  const clear = (): void => {
    if (accessKey) useAgentCloudAccessStore.getState().clearAccess(accessKey);
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const card = createCloudAccessCard({
      t: (key) => t(key),
      onSignIn: () => {
        clear();
        void windows.openPreferences('cloudSync');
      },
      onBuyCredits: () => {
        void openPaymentDialog('credits');
      },
      onDismiss: clear,
    });
    cardRef.current = card;
    mount.append(card.el);
    return () => {
      card.el.remove();
      cardRef.current = null;
    };
    // The card re-renders itself through `render` below; only rebuild on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const stored = accessKey ? entries[accessKey] ?? null : null;
  // Signing in resolves the signed-out notice without waiting for a new run.
  const kind = stored === 'signed_out' && authenticated ? null : stored;
  const visible = agentType === 'pi' && kind !== null;

  useEffect(() => {
    cardRef.current?.render(visible ? kind : null);
  }, [kind, visible]);

  return <div ref={mountRef} className="agent-thread-card__cloud-access" hidden={!visible} />;
}
