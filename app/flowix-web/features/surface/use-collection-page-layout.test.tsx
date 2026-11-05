import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { getWorkspaceHeaderScrolled } from '@features/workspace/public/header-api';
import { useCollectionPageLayout } from './use-collection-page-layout';

function Collection({ host }: { host: 'column-1' | 'column-2' }) {
  const layout = useCollectionPageLayout(host, true);
  return <div data-scroller={host} ref={layout.setPageScroller} />;
}

it('reports collection overlap independently for both columns and releases it when unmounted', async () => {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<><Collection host="column-1" /><Collection host="column-2" /></>));
    const main = node.querySelector<HTMLElement>('[data-scroller="column-1"]')!;
    const browser = node.querySelector<HTMLElement>('[data-scroller="column-2"]')!;
    await act(async () => {
      browser.scrollTop = 250;
      browser.dispatchEvent(new Event('scroll'));
    });
    expect(getWorkspaceHeaderScrolled('column-2')).toBe(true);
    expect(getWorkspaceHeaderScrolled('column-1')).toBe(false);
    await act(async () => { main.scrollTop = 201; main.dispatchEvent(new Event('scroll')); });
    expect(getWorkspaceHeaderScrolled('column-1')).toBe(true);
    await act(async () => { browser.scrollTop = 200; browser.dispatchEvent(new Event('scroll')); });
    expect(getWorkspaceHeaderScrolled('column-2')).toBe(false);
    expect(getWorkspaceHeaderScrolled('column-1')).toBe(true);
    await act(async () => { browser.scrollTop = 201; browser.dispatchEvent(new Event('scroll')); });
    expect(getWorkspaceHeaderScrolled('column-2')).toBe(true);
    expect(document.documentElement.hasAttribute('data-collection-scrolled')).toBe(false);
    await act(async () => root.render(null));
    expect(getWorkspaceHeaderScrolled('column-1')).toBe(false);
    expect(getWorkspaceHeaderScrolled('column-2')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
