import { reportWorkspaceHeaderFullscreen, clearWorkspaceHeaderFullscreen } from '@features/workspace/public/header-api';
import { ensureFileDisplayIdentity } from '@/lib/file-display-registry';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { BrowserColumnEntry } from '@features/workspace/public/browser-column-api';
import { BrowserColumnHeader } from './browser-column-header';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { registerCollectionBannerControl } from '@/lib/collection-banner-visibility';
vi.mock('@/lib/i18n', async (original) => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@features/document/public/shell-api', () => ({
  documentIdentityFromFile: (identity: unknown) => identity,
  useDocumentEditorMode: () => 'rich',
  useDocumentCommands: () => ({}),
  ExternalDocumentActions: ({ capabilities, collectionDisplayIndexPath }: { capabilities: { memoColors: boolean; versionHistory: boolean }; collectionDisplayIndexPath?: string }) => <div data-document-actions data-history={String(capabilities.versionHistory)} data-collection-index={collectionDisplayIndexPath}>
    {capabilities.memoColors && <button aria-label="document.color.button" />}
  </div>,
  AgentThreadCardFullscreenExitButton: () => null,
  AgentThreadCardFullscreenIdentity: () => <span>fullscreen agent</span>,
  AgentThreadCardFullscreenMoreMenu: () => <button data-fullscreen-menu />,
  useFullscreenAgentThreadCardInfo: () => null,
}));
vi.mock('@features/agent/public/shell-api', () => ({ AgentIcon: () => null, useBrowserColumnAgentHeaderModel: () => ({ conversationInstances: {} }), useNewConversationAgentSelection: () => ({ options: [] }) }));
it.each([true, false])('shows the current title, preserves hide and applies the context-menu drag policy (Windows: %s)', async (windows) => {
  const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(windows ? 'Windows' : 'Macintosh');
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue(windows ? 'Win32' : 'MacIntel');
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  useBrowserColumnStore.getState().reset();
  useBrowserColumnStore.getState().openContent({ id: 'a', title: 'Current page', icon: null, target: { kind: 'web', url: 'https://a.example/' } });
  const state = useBrowserColumnStore.getState();
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  const hide = vi.fn();
  try {
    await act(async () => root.render(<BrowserColumnHeader current={state.current} activeSurfaceChrome="document" headerBackgroundColor="rgb(17, 34, 51)" onToggleMemoEditorMode={vi.fn()} onOpenInWorkColumn={vi.fn()} onCloseColumn={hide} isFocused={false} canCreate={false} onCreateNote={vi.fn()} onCreateAgentConversation={vi.fn()} />));
    expect(node.querySelector('[role="tablist"]')).toBeNull();
    const header = node.querySelector('[data-browser-column-header]')!;
    expect((header as HTMLElement).style.backgroundColor).toBe('rgb(17, 34, 51)');
    expect((header as HTMLElement).style.backgroundImage).toBe('var(--titlebar-gradient)');
    expect(header.getAttribute('data-workspace-column-context-menu')).toBe(windows ? 'windows' : null);
    expect(header.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(node.textContent).toContain('Current page');
    expect(node.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.back"]')?.disabled).toBe(true);
    expect(node.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.forward"]')?.disabled).toBe(true);
    await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="tabWindow.closeColumn"]')?.click());
    expect(hide).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); node.remove(); environment.IS_REACT_ACT_ENVIRONMENT = false; userAgent.mockRestore(); platform.mockRestore(); }
});


it.each(['folder', 'table', 'media_library', 'work_documents'] as const)(
  'keeps %s collection identity hidden after tab title updates', async (kind) => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    useBrowserColumnStore.getState().reset();
    ensureFileDisplayIdentity('/book/collection.table.yaml');
    const target: BrowserColumnEntry['target'] = kind === 'folder'
      ? { kind: 'folder-collection', folderPath: '/book/folder', notebookId: 'book', notebookPath: '/book', folderName: 'Collection' }
      : { kind: 'file-browser', activeFilePath: '/book/collection.table.yaml', folderPath: null,
          scopePath: '/book', notebookId: 'book', fileTreeVisible: false, fileTreeWidth: 220,
          collectionType: kind, collectionDisplay: { notebookId: 'book', collectionId: 'collection', viewId: null, displayId: 'display' } };
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    const render = (title: string) => root.render(<BrowserColumnHeader
      current={{ id: 'collection', title, icon: '📚', target }} activeSurfaceChrome="document"
      onToggleMemoEditorMode={vi.fn()} onOpenInWorkColumn={vi.fn()} onCloseColumn={vi.fn()} isFocused={false} canCreate={false}
      onCreateNote={vi.fn()} onCreateAgentConversation={vi.fn()} />);
    try {
      for (const title of ['Collection before tab switch', 'Collection after tab switch']) {
        await act(async () => render(title));
        expect(node.textContent).not.toContain(title);
        expect(node.querySelector(`[title="${title}"]`)).toBeNull();
        expect(node.textContent).not.toContain('📚');
      }
      expect(node.querySelector('[aria-label="document.titlebar.back"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      node.remove();
      environment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  },
);

it('uses the Work collection display menu for folder collections', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const toggleBanner = vi.fn();
  const dispose = registerCollectionBannerControl('/book/folder/.index.yaml', { visible: true, toggle: toggleBanner });
  try {
    await act(async () => root.render(<BrowserColumnHeader
      current={{ id: 'folder', title: 'Folder', icon: null, target: {
        kind: 'folder-collection', folderPath: '/book/folder', notebookId: 'book', notebookPath: '/book', folderName: 'Folder',
      } }} activeSurfaceChrome="document" onToggleMemoEditorMode={vi.fn()} onOpenInWorkColumn={vi.fn()}
      isFocused canCreate onCreateNote={vi.fn()} onCreateAgentConversation={vi.fn()} />));
    const trigger = node.querySelector<HTMLButtonElement>('[aria-label="collection.display.more"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    const menu = document.querySelector('[data-flowix-surface="popover"]');
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll<HTMLButtonElement>('button'));
    expect(items.map((item) => item.textContent)).toEqual(['collection.display.title', 'collection.display.banner']);
    expect(menu!.classList.contains('w-[180px]')).toBe(true);
    await act(async () => items[1].click());
    expect(toggleBanner).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    dispose();
    node.remove();
  }
});


it('hides the underlying note controls only in the fullscreen host, restores them on exit, and follows plugin preview capabilities', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const mainOwner = {}, browserOwner = {};
  const info = { title: 'Fullscreen', typeKey: 'codex' as const, instanceId: 'agent', threadId: null };
  ensureFileDisplayIdentity('/book/note.md');
  const current: BrowserColumnEntry = { id: 'note', title: 'Note', icon: null, target: {
    kind: 'file-browser', activeFilePath: '/book/note.md', folderPath: null, scopePath: '/book',
    notebookId: 'book', fileTreeVisible: false, fileTreeWidth: 220,
  } };
  const render = (preview = false) => root.render(<BrowserColumnHeader current={current}
    activeSurfaceChrome="document" surfaceContentKind={preview ? 'mindmap' : 'file-markdown'}
    surfaceCapabilities={preview ? ['fullscreen'] : ['edit', 'copy-content']}
    onToggleMemoEditorMode={vi.fn()} onOpenInWorkColumn={vi.fn()} isFocused canCreate={false}
    onCreateNote={vi.fn()} onCreateAgentConversation={vi.fn()} />);
  const color = () => node.querySelector('[aria-label="document.color.button"]');
  try {
    await act(async () => render());
    expect(color()).not.toBeNull();
    expect(node.querySelector('[data-history="true"]')).not.toBeNull();
    await act(async () => reportWorkspaceHeaderFullscreen('main-third', mainOwner, info));
    expect(color()).not.toBeNull();
    await act(async () => reportWorkspaceHeaderFullscreen('browser-column', browserOwner, info));
    expect(color()).toBeNull();
    expect(node.querySelector('[data-document-actions]')).toBeNull();
    expect(node.querySelector('[data-fullscreen-menu]')).not.toBeNull();
    const header = node.querySelector<HTMLElement>('[data-browser-column-header]')!;
    expect(header.dataset.headerStyle).toBe('agent');
    await act(async () => clearWorkspaceHeaderFullscreen('main-third', mainOwner));
    expect(header.dataset.headerStyle).toBe('agent');
    await act(async () => clearWorkspaceHeaderFullscreen('browser-column', browserOwner));
    expect(color()).not.toBeNull();
    expect(header.dataset.headerStyle).toBe('document');
    await act(async () => render(true));
    expect(color()).toBeNull();
    expect(node.querySelector('[data-history="false"]')).not.toBeNull();
  } finally {
    await act(async () => {
      clearWorkspaceHeaderFullscreen('main-third', mainOwner);
      clearWorkspaceHeaderFullscreen('browser-column', browserOwner);
      root.unmount();
    });
    node.remove();
  }
});
