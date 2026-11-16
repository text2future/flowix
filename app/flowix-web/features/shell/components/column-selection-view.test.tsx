import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ColumnSelectionView } from './column-selection-view';

vi.mock('@features/content/public/content-api', () => ({
  ContentIcon: ({ content }: { content: { kind: string } }) => <svg aria-hidden="true" data-content-kind={content.kind} />,
}));

describe('ColumnSelectionView', () => {
  let host: HTMLDivElement;
  let root: Root;
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

  beforeEach(() => {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('uses catalog types for collection files sharing the index.yaml suffix', async () => {
    const paths = ['/notes/Media.index.yaml', '/notes/Table.index.yaml', '/notes/Resources.index.yaml'];
    await act(async () => root.render(
      <ColumnSelectionView paths={paths} label="3 个文档" contentKinds={new Map([
        [paths[0], 'media-library'], [paths[1], 'multidimensional-table'], [paths[2], 'work-documents'],
      ])} />,
    ));
    expect(Array.from(host.querySelectorAll('[data-content-kind]'), icon => icon.getAttribute('data-content-kind')))
      .toEqual(['media-library', 'multidimensional-table', 'work-documents']);
  });

  it('adds and removes cards without remounting existing cards or restarting their entrance', async () => {
    const first = '/notebook/first.md';
    const second = '/notebook/second.pdf';
    const third = '/notebook/third.index.yaml';
    const render = (paths: string[]) => act(async () => root.render(
      <ColumnSelectionView paths={paths} label={`${paths.length} 个文档`} />,
    ));
    await render([first, second]);
    const initialCards = Array.from(host.querySelectorAll('li'));
    expect(initialCards.map((card) => card.textContent)).toEqual(['first', 'second.pdf']);
    await render([first, second, third]);
    expect(host.querySelectorAll('li')).toHaveLength(3);
    expect(host.querySelectorAll('li')[2].textContent).toBe('third');
    expect(host.querySelectorAll('li')[0]).toBe(initialCards[0]);
    expect(host.querySelectorAll('li')[1]).toBe(initialCards[1]);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('3 个文档');
    await render([second, third]);
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.querySelectorAll('li')[0]).toBe(initialCards[1]);
    expect(host.textContent).not.toContain('first');
  });
});
