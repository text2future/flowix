import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SessionHostProvider, type SessionHostEnvironment } from './session-host-environment';
import { WorkspaceHeaderShell } from './workspace-header-shell';

describe('session Header host adaptation', () => {
  it.each([false, true])('keeps Header state mounted while adapting platform geometry (Windows: %s)', async (windows) => {
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    const environment = (host: SessionHostEnvironment['host']): SessionHostEnvironment => ({
      host, browserVisible: true, sidebarHidden: true, navigationVisible: false, onToggleSidebar: vi.fn(),
    });
    const render = (host: SessionHostEnvironment['host']) => root.render(
      <SessionHostProvider value={environment(host)}>
        <WorkspaceHeaderShell isWindows={windows}><input defaultValue="address" /></WorkspaceHeaderShell>
      </SessionHostProvider>,
    );
    try {
      await act(async () => render('main-third'));
      const header = node.firstElementChild!;
      const field = node.querySelector('input')!;
      field.value = 'draft address';
      expect(header.className.includes('pr-[var(--window-controls-width)]')).toBe(false);
      expect(header.querySelector('[aria-hidden="true"]') !== null).toBe(!windows);
      await act(async () => render('browser-column'));
      expect(node.firstElementChild).toBe(header);
      expect(node.querySelector('input')).toBe(field);
      expect(field.value).toBe('draft address');
      expect(header.className.includes('pr-[var(--window-controls-width)]')).toBe(windows);
      expect(header.querySelector('[aria-hidden="true"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      node.remove();
    }
  });
});
