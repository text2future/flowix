import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceHeader } from './workspace-header';
import { ColumnProvider } from './column-environment';
import { clearWorkspaceHeaderFullscreen, reportWorkspaceHeaderFullscreen } from '@features/workspace/public/header-api';
import type { WorkspaceColumnId } from '@features/workspace/public/surface-api';

vi.mock('./workspace-column-context-menu', () => ({ WorkspaceColumnContextMenu: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@features/workspace/public/browser-column-api', () => ({ hideBrowserColumn: vi.fn(), toggleBrowserColumn: vi.fn(), useBrowserColumnVisible: () => false }));
vi.mock('@features/document/public/header-api', () => ({
  SurfaceHeaderIcon: () => null,
  AgentThreadCardFullscreenIdentity: ({ host }: { host: string }) => <span>fullscreen:{host}</span>,
  AgentThreadCardFullscreenExitButton: () => null,
  AgentThreadCardFullscreenMoreMenu: () => null,
}));
vi.mock('@/lib/i18n', async (original) => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }) }));
let root: Root;
let node: HTMLDivElement;
const back = vi.fn(); const sidebar = vi.fn(); const close = vi.fn();
const owners: Array<{ host: WorkspaceColumnId; owner: object }> = [];
beforeEach(() => { node = document.createElement('div'); document.body.append(node); root = createRoot(node); });
afterEach(async () => {
  await act(async () => { for (const { host, owner } of owners) clearWorkspaceHeaderFullscreen(host, owner); root.unmount(); });
  owners.length = 0; node.remove(); vi.clearAllMocks();
});
const button = (label: string) => node.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
function Header({ physicalHost }: { physicalHost: WorkspaceColumnId }) {
  return <ColumnProvider value={{ index: physicalHost === 'column-1' ? 0 : 1, browserVisible: true, sidebarHidden: true, navigationVisible: false, onToggleSidebar: sidebar }}>
    <WorkspaceHeader columnId="column-1" isWindows presentation={{ identity: { title: 'Same document' } }}
      sidebar={{ hidden: true, noteNavigationVisible: false, onToggle: sidebar }}
      navigation={{ canNavigateBack: true, canNavigateForward: false, onNavigateBack: back, onNavigateForward: vi.fn() }}
      onCloseColumn={close} actions={() => <button>document commands</button>} />
  </ColumnProvider>;
}

it('placement changes column controls and window spacing while preserving content and navigation', async () => {
  await act(async () => root.render(<Header physicalHost="column-2" />));
  expect(button('tabWindow.closeColumn')).not.toBeNull();
  expect(button('document.titlebar.showSidebar')).toBeNull();
  expect(node.querySelector('header')!.className).toContain('pr-[var(--window-controls-width)]');
  await act(async () => button('tabWindow.closeColumn')!.click()); expect(close).toHaveBeenCalledOnce();
  await act(async () => root.render(<Header physicalHost="column-1" />));
  expect(button('tabWindow.closeColumn')).toBeNull();
  expect(button('document.titlebar.showSidebar')).not.toBeNull();
  expect(node.querySelector('header')!.className).toContain('pr-0');
  expect(node.textContent).toContain('Same document'); expect(node.textContent).toContain('document commands');
  await act(async () => button('document.titlebar.back')!.click()); expect(back).toHaveBeenCalledOnce();
});

it('fullscreen remains scoped to the owning runtime after its physical placement changes', async () => {
  await act(async () => root.render(<Header physicalHost="column-2" />));
  const other = {}; owners.push({ host: 'column-2', owner: other });
  await act(async () => reportWorkspaceHeaderFullscreen('column-2', other, { title: 'Other', typeKey: 'codex', instanceId: null, threadId: null }));
  expect(node.textContent).toContain('document commands');
  const own = {}; owners.push({ host: 'column-1', owner: own });
  await act(async () => reportWorkspaceHeaderFullscreen('column-1', own, { title: 'Own', typeKey: 'codex', instanceId: null, threadId: null }));
  expect(node.textContent).toContain('fullscreen:column-1');
  expect(node.textContent).not.toContain('document commands');
  await act(async () => clearWorkspaceHeaderFullscreen('column-1', own));
  expect(node.textContent).toContain('document commands');
});
