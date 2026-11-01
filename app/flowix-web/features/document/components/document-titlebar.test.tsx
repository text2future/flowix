import { reportWorkspaceHeaderFullscreen, clearWorkspaceHeaderFullscreen } from '@features/workspace/public/header-api';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentTitlebarMac } from './document-titlebar-mac';
import { DocumentTitlebarWin } from './document-titlebar-win';
import type { DocumentTitlebarProps } from './document-titlebar-model';
import { registerCollectionBannerControl } from '@/lib/collection-banner-visibility';

const mocks = vi.hoisted(() => ({ hideBrowser: vi.fn(), transfer: vi.fn() }));
vi.mock('@features/workspace/public/shell-api', () => ({
  useWorkColumnTransferViewModel: () => ({ canOpenInBrowserColumn: true, openInBrowserColumn: mocks.transfer }),
}));
vi.mock('@features/workspace/public/browser-column-api', () => ({ hideBrowserColumn: mocks.hideBrowser, toggleBrowserColumn: mocks.hideBrowser, useBrowserColumnVisible: () => true }));
vi.mock('@/lib/i18n', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/i18n')>(),
  useI18n: () => ({ t: (key: string) => key, language: 'zh-CN' }),
  translate: (_language: string, key: string) => key,
}));
vi.mock('./use-document-titlebar-actions', () => ({
  useDocumentTitlebarActions: () => ({
    colors: [], changeColors: vi.fn(), fontSwitch: {}, selectedFontSizeMode: null,
    setEditorFontSizeMode: vi.fn(), confirmVersion: null, setConfirmVersion: vi.fn(),
    restoringVersionId: null, versionRefreshKey: 0, archiveVersion: vi.fn(),
    restorePathVersion: vi.fn(), copyFolderPath: vi.fn(), revealFile: vi.fn(),
  }),
}));
vi.mock('@features/collection/public/folder-api', () => ({ FolderCollectionSwitchConfirmDialog: () => null }));
// Agent identity/menu rendering is covered separately; retain the real host-scoped fullscreen hooks here.
vi.mock('@features/agent/components/agent-conversation-identity', () => ({ AgentConversationIdentity: () => <span>agent identity</span> }));
vi.mock('@features/agent/components/agent-conversation-more-menu', () => ({ AgentConversationMoreMenu: () => <button>agent menu</button> }));

let host: HTMLDivElement;
let container: HTMLDivElement;
let root: Root;
let props: DocumentTitlebarProps;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  host.dataset.workspaceHost = 'main-third';
  container = document.createElement('div');
  host.append(container);
  document.body.append(host);
  root = createRoot(container);
  props = {
    document: { target: {
      fileIdentity: { path: '/book/a.md', displayId: 'a' }, scopePath: '/book',
      notebookId: 'book', relativePath: 'a.md', indexable: true, isOutsideCurrentNotebook: false,
    } },
    sidebar: { hidden: true, noteNavigationVisible: false, onToggle: vi.fn() },
    navigation: { title: 'note A', canNavigateBack: true, canNavigateForward: false, onNavigateBack: vi.fn(), onNavigateForward: vi.fn() },
    contentCapabilities: { memoColors: true, copyFullText: true, exportContent: true, saveAsTemplate: true, versionHistory: false },
    actions: { onCopyLink: vi.fn(), onCopyFullText: vi.fn(), onExportMarkdown: vi.fn(), onExportWord: vi.fn(), onExportPdf: vi.fn(), onSaveAsTemplate: vi.fn(), onDeleteExternalFile: vi.fn() },
  };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

for (const [platform, Titlebar] of [['mac', DocumentTitlebarMac], ['windows', DocumentTitlebarWin]] as const) {
  describe(`${platform} document titlebar`, () => {
    it('layers the preview color under the existing gradient and clears it on navigation', async () => {
      props.headerBackgroundColor = 'rgb(17, 34, 51)';
      await act(async () => root.render(<Titlebar {...props} />));
      const header = container.querySelector<HTMLElement>('.work-column-titlebar')!;
      expect(header.style.backgroundColor).toBe('rgb(17, 34, 51)');
      expect(header.style.backgroundImage).toBe('var(--titlebar-gradient)');
      props.headerBackgroundColor = null;
      await act(async () => root.render(<Titlebar {...props} />));
      expect(header.style.backgroundColor).toBe('');
      expect(header.style.backgroundImage).toBe('var(--titlebar-gradient)');
    });

    it('keeps collection identity out of the header after runtime title updates', async () => {
      props.collectionDisplay = { indexPath: '/book/.index.yaml' };
      props.navigation.title = 'Collection before tab switch';
      props.navigation.icon = '📚';
      await act(async () => root.render(<Titlebar {...props} />));
      expect(container.textContent).not.toContain('Collection before tab switch');
      expect(container.textContent).not.toContain('📚');
      props.navigation.title = 'Collection after tab switch';
      await act(async () => root.render(<Titlebar {...props} />));
      expect(container.textContent).not.toContain('Collection after tab switch');
    });

    it('keeps a web icon visible when the favicon fails to load', async () => {
      props.document.target = null;
      props.navigation.title = '技能市场';
      props.navigation.icon = 'https://skills.flowix.cc/favicon.ico';
      props.onToggleWebAddressBar = vi.fn();
      await act(async () => root.render(<Titlebar {...props} />));
      const image = container.querySelector<HTMLImageElement>('img[src="https://skills.flowix.cc/favicon.ico"]')!;
      expect(image).not.toBeNull();
      expect(image.parentElement!.querySelector('svg')).not.toBeNull();
      await act(async () => image.dispatchEvent(new Event('error')));
      expect(image.style.display).toBe('none');
      expect(image.parentElement!.querySelector('svg')).not.toBeNull();
    });

    it.each(['table', 'media_library'] as const)('renders the selected %s folder preference without crashing', async (current) => {
      props.folderCollectionViewType = {
        current, onSelect: vi.fn(), isDefaultFolder: false, onToggleDefaultFolder: vi.fn(),
      };
      await act(async () => root.render(<Titlebar {...props} />));
      expect(container.querySelector('[aria-label="document.titlebar.moreTooltip"]')).not.toBeNull();
    });

    it.each([
      ['a.md', 'document.action.richTextMode'],
      ['index.html', 'htmlResource.previewMode'],
    ])('switches %s modes through the existing More menu', async (filename, richLabel) => {
      props.document.target!.fileIdentity = { path: `/book/${filename}`, displayId: filename };
      props.showEditorModeToggle = true;
      props.editorMode = 'source';
      props.onSetEditorMode = vi.fn();
      await act(async () => root.render(<Titlebar {...props} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.moreTooltip"]')!.click());
      const toggle = [...document.querySelectorAll<HTMLElement>('button')]
        .find((item) => item.textContent?.includes(richLabel));
      expect(toggle).toBeDefined();
      await act(async () => toggle!.click());
      expect(props.onSetEditorMode).toHaveBeenCalledWith('rich');
      props.editorMode = 'rich';
      await act(async () => root.render(<Titlebar {...props} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.moreTooltip"]')!.click());
      expect([...document.querySelectorAll<HTMLElement>('button')]
        .some((item) => item.textContent?.includes('document.action.sourceMode'))).toBe(true);
    });

    it('hides document controls during Agent fullscreen and restores them on exit', async () => {
      await act(async () => root.render(<Titlebar {...props} />));
      const color = () => container.querySelector('[aria-label="document.color.button"]');
      expect(color()).not.toBeNull();
      const card = document.createElement('div');
      card.className = 'agent-thread-card--fullscreen';
      card.dataset.agentType = 'codex';
      card.dataset.instanceId = 'agent-instance';
      host.append(card);
      await act(async () => reportWorkspaceHeaderFullscreen('main-third', card, { title: 'agent title', typeKey: 'codex', instanceId: 'agent-instance', threadId: null }));
      expect(color()).toBeNull();
      expect(container.querySelector('[aria-label="document.titlebar.moreTooltip"]')).toBeNull();
      expect(container.textContent).not.toContain('note A');
      card.remove();
      await act(async () => clearWorkspaceHeaderFullscreen('main-third', card));
      expect(color()).not.toBeNull();
      expect(container.textContent).toContain('note A');
    });

    it('renders the collection display menu with title/cover toggles', async () => {
      // 文件夹入口的集合没有文档 target，header 右侧只剩「打开右栏」，
      // 显示开关就挂在它右边。
      props.document.target = null;
      props.collectionDisplay = { indexPath: '/book/客户周报/.index.yaml' };
      await act(async () => root.render(<Titlebar {...props} />));

      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="collection.display.more"]')!;
      expect(trigger).not.toBeNull();
      // 此时还没有集合外壳登记头图写入口：只出现「显示标题」。
      await act(async () => trigger.click());
      const labels = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button')]
        .map((item) => item.textContent ?? '');
      expect(labels().some((text) => text.includes('collection.display.title'))).toBe(true);
      expect(labels().some((text) => text.includes('collection.display.banner'))).toBe(false);

      // 外壳登记后「显示头图」出现，点击交给它写属性。
      const toggle = vi.fn();
      let dispose = () => {};
      await act(async () => { dispose = registerCollectionBannerControl('/book/客户周报/.index.yaml', { visible: true, toggle }); });
      const bannerItem = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.textContent?.includes('collection.display.banner'))!;
      expect(bannerItem).toBeDefined();
      await act(async () => bannerItem.click());
      expect(toggle).toHaveBeenCalledOnce();
      await act(async () => dispose());
    });

    it('toggles the collection title visibility from the display menu', async () => {
      props.document.target = null;
      props.collectionDisplay = { indexPath: '/book/客户周报/.index.yaml' };
      window.localStorage.removeItem('flowix:multidimensional-table:title-visible');
      await act(async () => root.render(<Titlebar {...props} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="collection.display.more"]')!.click());

      const titleItem = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.textContent?.includes('collection.display.title'))!;
      await act(async () => titleItem.click());
      // 与 tab 条「···」同一条偏好：写完广播，两个入口一起变。
      expect(window.localStorage.getItem('flowix:multidimensional-table:title-visible')).toBe('false');
      window.localStorage.removeItem('flowix:multidimensional-table:title-visible');
    });

    it('combines collection file display preferences into the document More menu', async () => {
      props.document.target!.fileIdentity = {
        path: '/book/客户周报/.index.yaml', displayId: '客户周报-index',
      };
      props.collectionDisplay = { indexPath: '/book/客户周报/.index.yaml' };
      const toggleBanner = vi.fn();
      let dispose = () => {};
      await act(async () => {
        dispose = registerCollectionBannerControl('/book/客户周报/.index.yaml', { visible: true, toggle: toggleBanner });
      });
      await act(async () => root.render(<Titlebar {...props} />));

      expect(container.querySelectorAll('[aria-label="document.titlebar.moreTooltip"]')).toHaveLength(1);
      expect(container.querySelector('[aria-label="collection.display.more"]')).toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.moreTooltip"]')!.click());

      const menuItem = (key: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.textContent?.includes(key));
      expect(menuItem('collection.display.title')).toBeDefined();
      const bannerItem = menuItem('collection.display.banner');
      expect(bannerItem).toBeDefined();
      await act(async () => bannerItem!.click());
      expect(toggleBanner).toHaveBeenCalledOnce();
      await act(async () => dispose());
    });

    it('combines collection display preferences into the media More menu', async () => {
      props.surfaceChrome = 'media';
      props.collectionDisplay = { indexPath: '/book/图片.lib.yaml' };
      props.mediaActions = {
        onCopyLink: vi.fn(), onRevealInFileManager: vi.fn(), onRequestDelete: vi.fn(),
      };
      await act(async () => root.render(<Titlebar {...props} />));

      expect(container.querySelectorAll('[aria-label="media.action.other"]')).toHaveLength(1);
      expect(container.querySelector('[aria-label="collection.display.more"]')).toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="media.action.other"]')!.click());
      expect([...document.querySelectorAll<HTMLButtonElement>('button')]
        .some((item) => item.textContent?.includes('collection.display.title'))).toBe(true);
      expect([...document.querySelectorAll<HTMLButtonElement>('button')]
        .some((item) => item.textContent?.includes('document.action.copyLink'))).toBe(true);
    });

    it('preserves navigation callbacks and the host context menu through the shared frame', async () => {
      await act(async () => root.render(<Titlebar {...props} />));
      const back = container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.back"]')!;
      const forward = container.querySelector<HTMLButtonElement>('[aria-label="document.titlebar.forward"]')!;
      expect(forward.disabled).toBe(true);
      await act(async () => back.click());
      expect(props.navigation.onNavigateBack).toHaveBeenCalledOnce();
      const frame = container.querySelector('[data-tauri-drag-region]')!;
      await act(async () => frame.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      const closeBrowser = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('tabWindow.closeColumn'))!;
      expect(closeBrowser).toBeDefined();
      await act(async () => closeBrowser.click());
      expect(mocks.hideBrowser).toHaveBeenCalledOnce();
    });
  });
}
