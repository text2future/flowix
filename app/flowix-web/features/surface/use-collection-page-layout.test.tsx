import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { getWorkspaceHeaderScrolled } from '@features/workspace/public/header-api';
import { useCollectionPageLayout } from './use-collection-page-layout';

function Collection({ host }: { host: 'main-third' | 'browser-column' }) {
  const layout = useCollectionPageLayout(host, true);
  return <div data-scroller={host} ref={layout.setPageScroller} />;
}

it('reports only Work collection overlap and releases the header backing when unmounted', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<><Collection host="main-third" /><Collection host="browser-column" /></>));
    const main = node.querySelector<HTMLElement>('[data-scroller="main-third"]')!;
    const browser = node.querySelector<HTMLElement>('[data-scroller="browser-column"]')!;
    await act(async () => {
      browser.scrollTop = 250;
      browser.dispatchEvent(new Event('scroll'));
    });
    expect(getWorkspaceHeaderScrolled('browser-column')).toBe(false);
    expect(getWorkspaceHeaderScrolled('main-third')).toBe(false);
    await act(async () => { main.scrollTop = 201; main.dispatchEvent(new Event('scroll')); });
    expect(getWorkspaceHeaderScrolled('main-third')).toBe(true);
    expect(document.documentElement.hasAttribute('data-collection-scrolled')).toBe(false);
    await act(async () => root.render(null));
    expect(getWorkspaceHeaderScrolled('main-third')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
