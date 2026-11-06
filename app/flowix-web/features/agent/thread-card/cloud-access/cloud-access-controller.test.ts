// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { I18nKey } from '@/lib/i18n';

const { openPreferences, openPaymentDialog } = vi.hoisted(() => ({
  openPreferences: vi.fn(async () => undefined),
  openPaymentDialog: vi.fn(async () => undefined),
}));

vi.mock('@platform/tauri/client', () => ({ windows: { openPreferences } }));
vi.mock('@features/cloud-billing/public/payment-dialog', () => ({ openPaymentDialog }));

import { useAgentCloudAccessStore } from '@features/agent/store/agent-cloud-access-store';
import type { AgentTypeKey } from '@/types/agent';
import { CloudAccessController } from './cloud-access-controller';

const t = ((key: I18nKey) => key) as (key: I18nKey) => string;
const mounted: CloudAccessController[] = [];

function mountController(options: {
  typeKey?: AgentTypeKey;
  providerId?: string;
  authenticated?: boolean;
  stream?: HTMLElement;
} = {}) {
  const mount = document.createElement('div');
  // The controller captures its stream from the mount's parent, so build the
  // stream first when a test needs one.
  (options.stream ?? document.body).append(mount);
  let authenticated = options.authenticated ?? true;
  const controller = new CloudAccessController({
    mount,
    t,
    getTypeKey: () => options.typeKey ?? 'pi',
    getAccessKey: () => 'thread-1',
    getProviderId: () => options.providerId ?? 'flowix-cloud-member',
    isAuthenticated: () => authenticated,
  });
  mounted.push(controller);
  return {
    controller,
    mount,
    signIn: () => { authenticated = true; },
  };
}

const failed = (id: string, category: string) => ({
  id,
  role: 'assistant',
  content: 'failed',
  errorDetails: { category },
});

beforeEach(() => {
  vi.clearAllMocks();
  useAgentCloudAccessStore.setState({ entries: {} });
  document.body.replaceChildren();
});

afterEach(() => {
  // Disposing stops the stream observer, so one test cannot re-append its notice
  // into the next test's document.
  for (const controller of mounted.splice(0)) controller.dispose();
  document.body.replaceChildren();
});

describe('CloudAccessController', () => {
  it('shows the credit notice for an exhausted Cloud balance', () => {
    const { controller, mount } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    expect(mount.hidden).toBe(false);
    expect(mount.querySelector('.agent-cloud-access')?.getAttribute('data-kind')).toBe('no_credits');
    expect(useAgentCloudAccessStore.getState().entries['thread-1']).toBe('no_credits');
  });

  it('keeps a cleared failure cleared until a different turn fails', () => {
    const { controller, mount } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    // Clearing without a new failure (sign-in resolved it, a send restarted)
    // must not let the same turn reopen the notice.
    useAgentCloudAccessStore.getState().clearAccess('thread-1');
    controller.render();
    expect(mount.hidden).toBe(true);

    controller.sync([failed('a1', 'quota_exhausted')] as never);
    expect(mount.hidden).toBe(true);

    controller.sync([
      failed('a1', 'quota_exhausted'),
      failed('a2', 'quota_exhausted'),
    ] as never);
    expect(mount.hidden).toBe(false);
  });

  it('clears the notice when the conversation recovers', () => {
    const { controller, mount } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    controller.sync([{ id: 'a2', role: 'assistant', content: 'ok' }] as never);
    expect(mount.hidden).toBe(true);
    expect(useAgentCloudAccessStore.getState().entries['thread-1']).toBeUndefined();
  });

  it('ignores failures from user-owned providers', () => {
    const { controller, mount } = mountController({ providerId: 'deepseek' });
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    expect(mount.hidden).toBe(true);
  });

  it('renders the sign-in notice a blocked send stored, without a failed turn', () => {
    const { controller, mount } = mountController({ authenticated: false });
    // The send preflight writes the entry from the message pipeline; the
    // controller only has to draw it as the turn's reply.
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.sync([{ id: 'u1', role: 'user', content: '总结这篇笔记' }] as never);
    expect(mount.hidden).toBe(false);
    expect(mount.querySelector('.agent-cloud-access')?.getAttribute('data-kind')).toBe('signed_out');
  });

  it('offers sign-in from a blocked send and opens the account tab', () => {
    const { controller, mount } = mountController({ authenticated: false });
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.render();
    mount.querySelector<HTMLButtonElement>('.agent-cloud-access__action')!.click();
    expect(openPreferences).toHaveBeenCalledWith('cloudSync');
    expect(mount.hidden).toBe(true);
  });

  it('opens the credit tab from the purchase action', () => {
    const { controller, mount } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    mount.querySelector<HTMLButtonElement>('.agent-cloud-access__action')!.click();
    expect(openPaymentDialog).toHaveBeenCalledWith('credits');
  });

  it('hides a signed-out notice once the account signs in', () => {
    const { controller, mount, signIn } = mountController({ authenticated: false });
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.render();
    expect(mount.hidden).toBe(false);
    signIn();
    controller.render();
    expect(mount.hidden).toBe(true);
  });

  it('re-attaches the card after the message stream is cleared', () => {
    const { controller, mount } = mountController({ authenticated: false });
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.render();
    // The message renderer drops every row when the card is hidden or collapses.
    document.body.replaceChildren();
    controller.render();
    expect(document.body.contains(mount)).toBe(true);
    expect(mount.hidden).toBe(false);
  });

  it('replaces the welcome block while visible and restores it when resolved', () => {
    const stream = document.createElement('div');
    const empty = document.createElement('div');
    empty.className = 'agent-thread-card__empty agent-thread-card__empty--expanded';
    const indicator = document.createElement('div');
    indicator.className = 'agent-thread-card__loading-indicator';
    stream.append(empty, indicator);
    document.body.append(stream);

    const { controller, mount, signIn } = mountController({ authenticated: false, stream });
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.render();
    // The card is the turn's reply: it stands as its own stream row and the
    // welcome block stands down for as long as the reply is on screen.
    expect(empty.hasAttribute('hidden')).toBe(true);
    expect(Array.from(stream.children)).toEqual([empty, mount, indicator]);

    // Signing in resolves the reply; the welcome block comes back.
    signIn();
    controller.render();
    expect(empty.hasAttribute('hidden')).toBe(false);
  });

  it('never shows on non-Pi agents', () => {
    const { controller, mount } = mountController({ typeKey: 'codex' });
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.render();
    expect(mount.hidden).toBe(true);
  });

  it('leaves the transcript rows to the message pipeline', () => {
    const { controller, mount } = mountController({ authenticated: false });
    useAgentCloudAccessStore.getState().setAccess('thread-1', 'signed_out');
    controller.render();
    // The prompt is a real message row; the notice must not echo a copy.
    expect(mount.querySelector('.agent-thread-card__message--user')).toBeNull();
    expect(Array.from(mount.children)).toEqual([mount.querySelector('.agent-cloud-access')]);
  });

  it('clears its store entry on dispose', () => {
    const { controller } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    controller.dispose();
    expect(useAgentCloudAccessStore.getState().entries['thread-1']).toBeUndefined();
  });
});
