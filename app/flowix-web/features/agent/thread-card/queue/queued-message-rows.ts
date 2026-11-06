import type { AgentTypeKey } from '@/types/agent';
import type { I18nKey } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  canActOnQueuedMessage,
  type PendingSteeringMessage,
} from '@features/agent/store/follow-up-queue-slice';
import { createArrowBendDownRightIcon } from '@features/agent/thread-card/agent-thread-card-icons';

export interface QueuedMessageRowsOptions {
  typeKey: AgentTypeKey;
  threadId: string | null;
  messages: readonly PendingSteeringMessage[];
  t: (key: I18nKey) => string;
}

function queueSoon(text: string): HTMLSpanElement {
  const soon = document.createElement('span');
  soon.className = 'agent-background-terminals__queue-soon';
  soon.setAttribute('role', 'status');
  soon.textContent = text;
  return soon;
}

function queueAction(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'agent-background-terminals__queue-delete';
  button.disabled = disabled;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

/**
 * Follow-up queue rows shown above the composer.
 *
 * Extracted from the Thread Card view (a frozen file): the rows are pure DOM
 * built from one queue entry, and keeping them here lets both the note-embedded
 * card and future surfaces share the exact same action rules.
 */
export function createQueuedMessageRows(
  options: QueuedMessageRowsOptions,
): HTMLElement[] {
  const { typeKey, threadId, messages, t } = options;
  return messages.map((message) => {
    const row = document.createElement('div');
    row.className = 'agent-background-terminals__queue-row';
    const mark = document.createElement('span');
    mark.className = 'agent-background-terminals__queue-mark';
    mark.append(createArrowBendDownRightIcon());
    const text = document.createElement('span');
    text.className = 'agent-background-terminals__queue-text';
    text.textContent = message.content;
    row.append(mark, text);
    if (typeKey !== 'pi' && typeKey !== 'codex') return row;

    const actions = document.createElement('span');
    actions.className = 'agent-background-terminals__queue-actions';
    const actionsDisabled = !canActOnQueuedMessage(message, typeKey);
    if (message.deliveryStatus === 'submitting') {
      actions.append(queueSoon(t('agent.queue.adding')));
    }
    if (message.deliveryStatus === 'starting') {
      actions.append(queueSoon(t('agent.queue.sendingSoon')));
    }
    if (message.canDelete !== false) {
      actions.append(queueAction(
        t('agent.queue.deleteQueued'),
        actionsDisabled,
        () => {
          if (!threadId) return;
          void useAgentSessionStore.getState().deleteQueuedFollowUp(threadId, message.id)
            .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
        },
      ));
    }
    if (message.deliveryStatus !== 'starting' && message.deliveryMode === 'follow_up') {
      const steer = queueAction(t('agent.queue.steerNow'), actionsDisabled, () => {
        if (!threadId) return;
        void useAgentSessionStore.getState().promoteFollowUpToSteer(threadId, message.id)
          .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
      });
      steer.className = 'agent-background-terminals__queue-steer';
      actions.append(steer);
    } else if (message.deliveryMode === 'steer') {
      actions.append(queueSoon(
        message.deliveryStatus === 'cleanup_failed'
          ? t('agent.queue.cleanupFailed')
          : t('agent.queue.sendingSoon'),
      ));
    }
    row.append(actions);
    return row;
  });
}
