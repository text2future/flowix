import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserColumnHeader } from './browser-column-header';
import type { BrowserColumnTab } from '@features/workspace/public/browser-column-api';

const useDocumentEditorModeMock = vi.hoisted(() => vi.fn((): 'rich' | 'source' => 'rich'));

vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('./work-column-titlebar-shell', () => ({ WORK_COLUMN_TITLEBAR_GRADIENT: 'none' }));
vi.mock('@features/document/public/shell-api', () => ({
  AgentThreadCardFullscreenExitButton: () => null,
  useDocumentEditorMode: useDocumentEditorModeMock,
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
    return <BrowserColumnHeader tabs={tabs} activeTabId={activeTabId} activeSurfaceChrome="document" onSelectTab={setActiveTabId}
      onCloseTab={vi.fn()} onCloseOtherTabs={vi.fn()} onCloseTabsToRight={vi.fn()}
      onCloseAllTabs={vi.fn()} onToggleMemoEditorMode={vi.fn()} onOpenTabInWorkColumn={vi.fn()} onReorderTab={vi.fn()}
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

it('hides the browser column from the button before the tab strip', async () => {
  const onCloseColumn = vi.fn();
  await withHeader(vi.fn(), async () => {
    const header = document.querySelector<HTMLElement>('[data-browser-column-header]');
    const closeColumnButton = header?.querySelector<HTMLButtonElement>('button[aria-label="tabWindow.closeColumn"]');
    expect(closeColumnButton).not.toBeNull();
    expect(closeColumnButton?.nextElementSibling?.getAttribute('role')).toBe('tablist');

    await act(async () => closeColumnButton?.click());
    expect(onCloseColumn).toHaveBeenCalledTimes(1);
  }, { onCloseColumn });
});

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

async function withHeader(
  onSelectTab: import('./browser-column-header').BrowserColumnHeaderProps['onSelectTab'],
  check: (buttons: HTMLButtonElement[], outside: HTMLInputElement) => Promise<void>,
  options: {
    tabs?: BrowserColumnTab[];
    onToggleMemoEditorMode?: import('./browser-column-header').BrowserColumnHeaderProps['onToggleMemoEditorMode'];
    onCloseColumn?: import('./browser-column-header').BrowserColumnHeaderProps['onCloseColumn'];
  } = {},
) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  const outside = document.createElement('input');
  document.body.append(element, outside);
  const root = createRoot(element);
  const defaultTabs: BrowserColumnTab[] = ['one', 'two', 'three'].map((id) => ({
    id, title: id, icon: null, target: { kind: 'web', url: `https://${id}.example` },
  }));
  const tabs = options.tabs ?? defaultTabs;
  try {
    await act(async () => root.render(<BrowserColumnHeader tabs={tabs} activeTabId="one" activeSurfaceChrome="document" onSelectTab={onSelectTab}
      onCloseTab={vi.fn()} onCloseOtherTabs={vi.fn()} onCloseTabsToRight={vi.fn()}
      onCloseAllTabs={vi.fn()} onToggleMemoEditorMode={options.onToggleMemoEditorMode ?? vi.fn()} onOpenTabInWorkColumn={vi.fn()} onReorderTab={vi.fn()}
      isTabMenuOpen={false} onTabMenuOpenChange={vi.fn()} onCloseColumn={options.onCloseColumn} onContextMenuOpenChange={vi.fn()}
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

it('uses the Agent surface titlebar skin for an active Agent conversation', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const tab: BrowserColumnTab = {
    id: 'agent-tab',
    title: 'Agent conversation',
    icon: null,
    target: { kind: 'agent_conversation', instanceId: 'agent-1' },
  };
  try {
    await act(async () => root.render(
      <BrowserColumnHeader
        tabs={[tab]}
        activeTabId={tab.id}
        activeSurfaceChrome="agent"
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onCloseOtherTabs={vi.fn()}
        onCloseTabsToRight={vi.fn()}
        onCloseAllTabs={vi.fn()}
        onToggleMemoEditorMode={vi.fn()}
        onOpenTabInWorkColumn={vi.fn()}
        onReorderTab={vi.fn()}
        isTabMenuOpen={false}
        onTabMenuOpenChange={vi.fn()}
        onContextMenuOpenChange={vi.fn()}
        isFocused={false}
      />,
    ));
    const header = element.querySelector<HTMLElement>('[data-browser-column-header]');
    expect(header?.classList.contains('agent-surface-titlebar')).toBe(true);
    // The Agent surface class owns the gradient; the default inline gradient
    // must be absent so CSS can match fullscreen Thread Card chrome exactly.
    expect(header?.style.backgroundImage).toBe('');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
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

it('shows the requested tab as active while content activation is pending', async () => {
  let finish!: (value: boolean) => void;
  await withHeader(() => new Promise<boolean>((resolve) => { finish = resolve; }), async (buttons) => {
    await act(async () => { buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(buttons[0].getAttribute('aria-selected')).toBe('false');
    expect(buttons[1].getAttribute('aria-selected')).toBe('true');
    expect(buttons[1].parentElement?.classList.contains('browser-column-tab-active')).toBe(true);
    expect(buttons[0].parentElement?.classList.contains('browser-column-tab-active')).toBe(false);
    expect(buttons[0].parentElement?.classList.contains('bg-transparent')).toBe(true);
    expect(buttons[0].parentElement?.classList.contains('shadow-none')).toBe(true);

    await act(async () => finish(false));
    expect(buttons[0].getAttribute('aria-selected')).toBe('true');
    expect(buttons[1].getAttribute('aria-selected')).toBe('false');
  });
});

it('commits the requested tab chrome before starting content activation', async () => {
  let renderedButtons: HTMLButtonElement[] = [];
  let selectedWhenActivationStarted: string | null = null;
  await withHeader(() => {
    selectedWhenActivationStarted = renderedButtons.find(
      (button) => button.getAttribute('aria-selected') === 'true',
    )?.textContent ?? null;
    return false;
  }, async (buttons) => {
    renderedButtons = buttons;
    await act(async () => { buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(selectedWhenActivationStarted).toBe('two');
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

it('shows the editor mode entry only for memo tabs and toggles its label', async () => {
  useDocumentEditorModeMock.mockReturnValue('rich');
  const onToggleMemoEditorMode = vi.fn();
  const memoTab: BrowserColumnTab = {
    id: 'memo-tab',
    title: 'Memo',
    icon: null,
    target: {
      kind: 'memo',
      memoId: 'memo-1',
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      filePath: '/notes/memo.md',
    },
  };
  await withHeader(vi.fn(), async () => {
    await act(async () => {
      document.querySelector<HTMLElement>('[role="tab"]')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });
    let modeItem = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'document.action.sourceMode');
    expect(modeItem).not.toBeUndefined();
    await act(async () => { modeItem?.click(); });
    expect(onToggleMemoEditorMode).toHaveBeenCalledWith('memo-tab');

    useDocumentEditorModeMock.mockReturnValue('source');
    await act(async () => {
      document.querySelector<HTMLElement>('[role="tab"]')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });
    modeItem = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === 'document.action.richTextMode');
    expect(modeItem).not.toBeUndefined();
  }, { tabs: [memoTab], onToggleMemoEditorMode });
});

it('does not show the editor mode entry for web tabs', async () => {
  await withHeader(vi.fn(), async () => {
    await act(async () => {
      document.querySelector<HTMLElement>('[role="tab"]')?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
      );
    });
    expect(Array.from(document.querySelectorAll('[role="menuitem"]'))
      .some((item) => item.textContent?.includes('document.action.sourceMode'))).toBe(false);
  });
});
