import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@shared/ui/popover', () => ({
  Popover: ({ children, open, onOpenChange }: { children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void }) => <div><button data-toggle onClick={() => onOpenChange(!open)}>toggle</button>{open ? children : null}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@features/editor/public/mention-data-api', () => ({ queryMentionTags: vi.fn() }));
import { queryMentionTags } from '@features/editor/public/mention-data-api';
import { TableTagValueInput } from './table-tag-value-input';

let root: Root;
let container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.resetAllMocks(); });
async function setup(isNoteTags = true) {
  vi.mocked(queryMentionTags).mockImplementation(async (query) => [
    { id: '1', name: '项目/开发', create: false },
    { id: '2', name: '项目/设计', create: false },
    { id: '3', name: '已有', create: false },
    { id: '4', name: query, create: true },
  ].filter((item) => !query || item.name.includes(query.replace(/^#/, ''))));
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  const onChange = vi.fn();
  await act(async () => root.render(<TableTagValueInput value={['已有']} isNoteTags={isNoteTags} onChange={onChange} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-toggle]')?.click());
  return { input: container.querySelector('input')!, onChange };
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function key(input: HTMLInputElement, key: string, options = {}) {
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options })));
}
it('searches historical tags, excludes selected tags, and commits a keyboard selection', async () => {
  const { input, onChange } = await setup();
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  await type(input, '#项目');
  expect(queryMentionTags).toHaveBeenLastCalledWith('#项目');
  await key(input, 'ArrowDown');
  await key(input, 'Enter');
  await key(input, 'Enter', { ctrlKey: true });
  expect(onChange).toHaveBeenCalledWith(['已有', '项目/设计']);
});
it('selects a historical tag with the mouse and saves on close', async () => {
  const { input, onChange } = await setup();
  await type(input, '项目');
  await act(async () => container.querySelector<HTMLButtonElement>('[role="option"]')?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-toggle]')?.click());
  expect(onChange).toHaveBeenCalledWith(['已有', '项目/开发']);
});
it('allows a new tag and cancels edits with Escape', async () => {
  const { input, onChange } = await setup();
  await type(input, '#新标签');
  expect(container.querySelector('[role="option"]')).toBeNull();
  await key(input, 'Enter');
  await key(input, 'Escape');
  expect(onChange).not.toHaveBeenCalled();
});
it('preserves free-form tags without fetching note history', async () => {
  const { input, onChange } = await setup(false);
  await type(input, '普通标签');
  await key(input, 'Enter');
  await key(input, 'Enter', { ctrlKey: true });
  expect(queryMentionTags).not.toHaveBeenCalled();
  expect(onChange).toHaveBeenCalledWith(['已有', '普通标签']);
});

it('keeps IME confirmation Enter from selecting a suggestion after compositionend', async () => {
  const { input, onChange } = await setup();
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await type(input, '项目');
  expect(queryMentionTags).not.toHaveBeenCalled();
  await key(input, 'Enter', { isComposing: true });
  expect(input.value).toBe('项目');
  await act(async () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
  await key(input, 'Enter', { keyCode: 229 });
  expect(input.value).toBe('项目');
  expect(onChange).not.toHaveBeenCalled();
  await key(input, 'Enter');
  await key(input, 'Enter', { ctrlKey: true });
  expect(onChange).toHaveBeenCalledWith(['已有', '项目/开发']);
});

it('keeps IME confirmation Enter from committing a free-form tag', async () => {
  const { input, onChange } = await setup(false);
  await type(input, '新标签');
  await key(input, 'Enter', { keyCode: 229, ctrlKey: true });
  expect(input.value).toBe('新标签');
  expect(onChange).not.toHaveBeenCalled();
  await key(input, 'Enter');
  await key(input, 'Enter', { ctrlKey: true });
  expect(onChange).toHaveBeenCalledWith(['已有', '新标签']);
});
