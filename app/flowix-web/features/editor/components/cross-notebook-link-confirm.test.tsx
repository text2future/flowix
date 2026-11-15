import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { confirmCrossNotebookLink, CrossNotebookLinkConfirmHost } from './cross-notebook-link-confirm';
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<CrossNotebookLinkConfirmHost />); });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });
it('opens same-notebook targets without a dialog', async () => {
  await expect(confirmCrossNotebookLink('book', { id: 'book', name: 'Book' })).resolves.toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it.each([['取消', false], ['前往', true]] as const)('resolves the cross-notebook choice: %s', async (label, accepted) => {
  let result!: Promise<boolean>;
  await act(async () => { result = confirmCrossNotebookLink('book', { id: 'other', name: '其他笔记本' }); });
  expect(document.body.textContent).toContain('其他笔记本');
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === label)!;
  await act(async () => { button.click(); });
  await expect(result).resolves.toBe(accepted);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('cancels an older click instead of reusing its consent', async () => {
  let older!: Promise<boolean>;
  let latest!: Promise<boolean>;
  await act(async () => {
    older = confirmCrossNotebookLink('book', { id: 'other', name: 'Other' });
    latest = confirmCrossNotebookLink('book', { id: 'other', name: 'Other' });
  });
  await expect(older).resolves.toBe(false);
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '前往')!.click(); });
  await expect(latest).resolves.toBe(true);
});
it('cancels pending navigation when the host unmounts', async () => {
  let result!: Promise<boolean>;
  await act(async () => { result = confirmCrossNotebookLink('book', { id: 'other', name: 'Other' }); });
  await act(async () => { root.render(null); });
  await expect(result).resolves.toBe(false);
});
