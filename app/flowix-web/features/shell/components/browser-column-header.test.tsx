import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserColumnHeader } from './browser-column-header';
import type { BrowserColumnTab } from '@features/workspace/public/browser-column-api';

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('./work-column-titlebar-shell', () => ({ WORK_COLUMN_TITLEBAR_GRADIENT: 'none' }));
vi.mock('@features/document/public/shell-api', () => ({
  AgentThreadCardFullscreenExitButton: () => null,
  useFullscreenAgentThreadCardInfo: () => null,
}));

it('moves actual focus across successive arrow presses and Home/End, and shows type icons', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const tabs: BrowserColumnTab[] = ['one', 'two', 'three'].map((id) => ({
    id, title: id, icon: null, target: { kind: 'web', url: `https://${id}.example` },
  }));
  function Harness() {
    const [activeTabId, setActiveTabId] = useState('one');
    return <BrowserColumnHeader tabs={tabs} activeTabId={activeTabId} onSelectTab={setActiveTabId}
      onCloseTab={vi.fn()} onCloseOtherTabs={vi.fn()} onCloseTabsToRight={vi.fn()}
      onCloseAllTabs={vi.fn()} onOpenTabInWorkColumn={vi.fn()} onReorderTab={vi.fn()}
      isTabMenuOpen={false} onTabMenuOpenChange={vi.fn()} onContextMenuOpenChange={vi.fn()}
      isFocused={false} />;
  }
  try {
    await act(async () => root.render(<Harness />));
    const buttons = element.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(buttons).toHaveLength(3);
    expect(buttons[0].querySelector('svg')).not.toBeNull();
    buttons[0].focus();
    for (const [key, index] of [['ArrowRight', 1], ['ArrowRight', 2], ['Home', 0], ['End', 2], ['ArrowLeft', 1]] as const) {
      await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
      expect(document.activeElement).toBe(buttons[index]);
      expect(buttons[index].getAttribute('aria-selected')).toBe('true');
    }
  } finally {
    await act(async () => root.unmount());
    element.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

async function withHeader(
  onSelectTab: import('./browser-column-header').BrowserColumnHeaderProps['onSelectTab'],
  check: (buttons: HTMLButtonElement[], outside: HTMLInputElement) => Promise<void>,
) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  const outside = document.createElement('input');
  document.body.append(element, outside);
  const root = createRoot(element);
  const tabs: BrowserColumnTab[] = ['one', 'two', 'three'].map((id) => ({
    id, title: id, icon: null, target: { kind: 'web', url: `https://${id}.example` },
  }));
  try {
    await act(async () => root.render(<BrowserColumnHeader tabs={tabs} activeTabId="one" onSelectTab={onSelectTab}
      onCloseTab={vi.fn()} onCloseOtherTabs={vi.fn()} onCloseTabsToRight={vi.fn()}
      onCloseAllTabs={vi.fn()} onOpenTabInWorkColumn={vi.fn()} onReorderTab={vi.fn()}
      isTabMenuOpen={false} onTabMenuOpenChange={vi.fn()} onContextMenuOpenChange={vi.fn()}
      isFocused={false} />));
    await check(Array.from(element.querySelectorAll<HTMLButtonElement>('[role="tab"]')), outside);
  } finally {
    await act(async () => root.unmount());
    element.remove();
    outside.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

it.each([false, null, 'throw'] as const)('restores selected-tab focus when activation fails with %s', async (result) => {
  await withHeader(async () => {
    if (result === 'throw') throw new Error('save failed');
    return result;
  }, async (buttons) => {
    buttons[0].focus();
    await act(async () => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
  });
});

it('does not steal focus from the editor after a delayed save failure', async () => {
  let finish!: (value: boolean) => void;
  await withHeader(() => new Promise<boolean>((resolve) => { finish = resolve; }), async (buttons, outside) => {
    buttons[0].focus();
    await act(async () => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(document.activeElement).toBe(buttons[1]);
    outside.focus();
    await act(async () => finish(false));
    expect(document.activeElement).toBe(outside);
  });
});

it('ignores a stale failure after a newer keyboard selection', async () => {
  const pending: Array<(value: boolean) => void> = [];
  await withHeader(() => new Promise<boolean>((resolve) => pending.push(resolve)), async (buttons) => {
    buttons[0].focus();
    await act(async () => { buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await act(async () => { buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    await act(async () => pending[0](false));
    expect(document.activeElement).toBe(buttons[2]);
    await act(async () => pending[1](false));
    expect(document.activeElement).toBe(buttons[0]);
  });
});

it('shows the reason why a webpage cannot be moved in its context menu', async () => {
  await withHeader(vi.fn(), async (buttons) => {
    await act(async () => { buttons[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 })); });
    const explanation = document.getElementById('move-unavailable-one');
    expect(explanation?.textContent).toBe('tabWindow.context.moveWebUnavailable');
    expect(document.querySelector<HTMLButtonElement>('[aria-describedby="move-unavailable-one"]')?.disabled).toBe(true);
  });
});
