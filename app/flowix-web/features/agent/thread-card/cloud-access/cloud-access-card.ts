/**
 * In-conversation Cloud access card.
 *
 * Two states share one shell: a signed-out account (sign in to continue) and an
 * exhausted credit balance (buy credits). It is built imperatively because the
 * Thread Card is a ProseMirror NodeView, matching the other composer-adjacent
 * widgets (`queuedMessages`, empty settings) that live outside React.
 *
 * The shape follows the list-column guide card a new user sees in the sidebar:
 * a translucent popup-bordered panel with a 15px title, body copy and one
 * primary action. There is no close control — the card leaves on its own when
 * the account signs in, the balance is topped up, or the next send starts.
 */
import type { I18nKey } from '@/lib/i18n';
import type { CloudAccessKind } from '@features/agent/config/cloud-access';

export interface CloudAccessCardOptions {
  t: (key: I18nKey) => string;
  onSignIn: () => void;
  onBuyCredits: () => void;
}

export interface CloudAccessCard {
  el: HTMLElement;
  render: (kind: CloudAccessKind | null) => void;
}

export function createCloudAccessCard(
  options: CloudAccessCardOptions,
): CloudAccessCard {
  const el = document.createElement('div');
  el.className = 'agent-cloud-access';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const title = document.createElement('div');
  title.className = 'agent-cloud-access__title';

  const description = document.createElement('div');
  description.className = 'agent-cloud-access__description';

  const footer = document.createElement('div');
  footer.className = 'agent-cloud-access__footer';
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'agent-cloud-access__action';
  action.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (el.dataset.kind === 'no_credits') options.onBuyCredits();
    else options.onSignIn();
  });
  footer.append(action);

  // The card sits in the message stream, so a click must not steal the caret or
  // bubble into the NodeView's card-level mouse handling.
  el.addEventListener('mousedown', (event) => event.stopPropagation());
  el.addEventListener('pointerdown', (event) => event.stopPropagation());
  el.append(title, description, footer);

  const render = (kind: CloudAccessKind | null): void => {
    if (!kind) {
      el.hidden = true;
      delete el.dataset.kind;
      return;
    }
    el.dataset.kind = kind;
    el.hidden = false;
    title.textContent = options.t(
      kind === 'signed_out'
        ? 'agent.cloudAccess.signedOut.title'
        : 'agent.cloudAccess.noCredits.title',
    );
    description.textContent = options.t(
      kind === 'signed_out'
        ? 'agent.cloudAccess.signedOut.description'
        : 'agent.cloudAccess.noCredits.description',
    );
    action.textContent = options.t(
      kind === 'signed_out'
        ? 'agent.cloudAccess.signedOut.action'
        : 'agent.cloudAccess.noCredits.action',
    );
  };

  return { el, render };
}
