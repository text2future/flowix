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

function mountController(options: {
  typeKey?: AgentTypeKey;
  providerId?: string;
  authenticated?: boolean;
} = {}) {
  const mount = document.createElement('div');
  document.body.append(mount);
  let authenticated = options.authenticated ?? true;
  const controller = new CloudAccessController({
    mount,
    t,
    getTypeKey: () => options.typeKey ?? 'pi',
    getAccessKey: () => 'thread-1',
    getProviderId: () => options.providerId ?? 'flowix-cloud-member',
    isAuthenticated: () => authenticated,
  });
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

  it('keeps a dismissed notice dismissed until a different turn fails', () => {
    const { controller, mount } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    mount.querySelector<HTMLButtonElement>('.agent-cloud-access__dismiss')!.click();
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

  it('blocks a signed-out submission and offers sign-in', () => {
    const { controller, mount } = mountController({ authenticated: false });
    expect(controller.blockSubmission()).toBe('signed_out');
    expect(mount.hidden).toBe(false);
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
    controller.blockSubmission();
    expect(mount.hidden).toBe(false);
    signIn();
    controller.render();
    expect(mount.hidden).toBe(true);
  });

  it('never shows on non-Pi agents', () => {
    const { controller, mount } = mountController({ typeKey: 'codex' });
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    expect(controller.blockSubmission()).toBeNull();
    expect(mount.hidden).toBe(true);
  });

  it('clears its store entry on dispose', () => {
    const { controller } = mountController();
    controller.sync([failed('a1', 'quota_exhausted')] as never);
    controller.dispose();
    expect(useAgentCloudAccessStore.getState().entries['thread-1']).toBeUndefined();
  });
});
