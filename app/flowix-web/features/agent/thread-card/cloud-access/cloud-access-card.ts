/**
 * In-conversation Cloud access card.
 *
 * Two states share one shell: a signed-out account (sign in to continue) and an
 * exhausted credit balance (buy credits). It is built imperatively because the
 * Thread Card is a ProseMirror NodeView, matching the other composer-adjacent
 * widgets (`queuedMessages`, empty settings) that live outside React.
 */
import type { I18nKey } from '@/lib/i18n';
import type { CloudAccessKind } from '@features/agent/config/cloud-access';

export interface CloudAccessCardOptions {
  t: (key: I18nKey) => string;
  onSignIn: () => void;
  onBuyCredits: () => void;
  onDismiss: () => void;
}

export interface CloudAccessCard {
  el: HTMLElement;
  render: (kind: CloudAccessKind | null) => void;
}

function createAccessIcon(kind: CloudAccessKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-cloud-access__icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    kind === 'signed_out'
      ? 'M8 2.2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-5.2 10.4a5.2 5.2 0 0 1 10.4 0'
      : 'M8 1.8 13 4.3v3.6c0 2.9-2 5.2-5 6.3-3-1.1-5-3.4-5-6.3V4.3L8 1.8Zm0 3.1v4.2m0 2.1v.1',
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export function createCloudAccessCard(
  options: CloudAccessCardOptions,
): CloudAccessCard {
  const el = document.createElement('div');
  el.className = 'agent-cloud-access';
  el.hidden = true;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');

  const iconMount = document.createElement('span');
  iconMount.className = 'agent-cloud-access__icon-mount';
  iconMount.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'agent-cloud-access__body';
  const title = document.createElement('div');
  title.className = 'agent-cloud-access__title';
  const description = document.createElement('div');
  description.className = 'agent-cloud-access__description';
  body.append(title, description);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'agent-cloud-access__action';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'agent-cloud-access__dismiss';
  dismiss.setAttribute('aria-label', options.t('agent.cloudAccess.dismiss'));
  dismiss.title = options.t('agent.cloudAccess.dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onDismiss();
  });

  action.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (el.dataset.kind === 'no_credits') options.onBuyCredits();
    else options.onSignIn();
  });

  // The card sits above the composer, so a click must not steal the caret or
  // bubble into the NodeView's card-level mouse handling.
  el.addEventListener('mousedown', (event) => event.stopPropagation());
  el.addEventListener('pointerdown', (event) => event.stopPropagation());
  el.append(iconMount, body, action, dismiss);

  const render = (kind: CloudAccessKind | null): void => {
    if (!kind) {
      el.hidden = true;
      delete el.dataset.kind;
      return;
    }
    el.dataset.kind = kind;
    el.hidden = false;
    iconMount.replaceChildren(createAccessIcon(kind));
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
