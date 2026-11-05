import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EditorImageContext } from '@features/editor/editor-image-source';
import { resolveEditorImageSource } from '@features/editor/editor-image-source';

vi.mock('@features/editor/extensions/attachment-link/utils', () => ({
  assetUrl: (key: string) => `https://asset.localhost/${key}`,
  assetMarkdownUrl: (key: string) => `asset://${key}`,
  decodeStorageKey: (value: string) => value.replace(/^asset:\/\/localhost\//, ''),
  isVideoUrl: (value: string) => value.endsWith('.mp4'),
}));

import { AttachmentLink } from '../index';

const editors: Editor[] = [];
function createEditor(content: string, context: () => EditorImageContext | undefined) {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, AttachmentLink.configure({ getImageContext: context }), Markdown],
    content, contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}
const readImage = vi.fn<EditorImageContext['readImage']>();
let context: EditorImageContext;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('requestIdleCallback', undefined);
  readImage.mockReset().mockResolvedValue('data:image/jpeg;base64,AA==');
  context = { documentPath: '/book/05 我的作品/小红书历史笔记/08 做了一个免费的 ai 写作工具.md', scopePath: '/book', readImage };
});
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('loads the post’s five relative images in the owning notebook and preserves Markdown', async () => {
  const sources = Array.from({ length: 5 }, (_, index) => `配图/XHS_rop_08_0${index + 1}.jpg`);
  const editor = createEditor(sources.map(src => `![配图](${src})`).join('\n\n'), () => context);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage.mock.calls).toEqual(sources.map(src => [`/book/05 我的作品/小红书历史笔记/${src}`, '/book']));
  expect([...editor.view.dom.querySelectorAll('img')].map(img => img.getAttribute('src')))
    .toEqual(sources.map(() => 'data:image/jpeg;base64,AA=='));
  sources.forEach(src => expect(editor.getMarkdown()).toContain(`![配图](${src})`));
  expect(editor.getMarkdown()).not.toContain('data:image');
  editor.storage.image.refreshSources();
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledTimes(5);
});

it('waits until an image approaches the viewport before reading its file', async () => {
  let intersect: IntersectionObserverCallback | undefined;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe() {} disconnect() {}
  });
  createEditor('![photo](配图/a.jpg)', () => context);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).not.toHaveBeenCalled();
  intersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledOnce();
});

it('follows a document move and ignores an earlier file read completing afterwards', async () => {
  let finishOld!: (value: string) => void;
  readImage.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const editor = createEditor('![photo](配图/a.jpg)', () => context);
  await vi.runOnlyPendingTimersAsync();
  context = { ...context, documentPath: '/book/new/note.md' };
  editor.storage.image.refreshSources();
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenLastCalledWith('/book/new/配图/a.jpg', '/book');
  finishOld('data:image/jpeg;base64,OLD');
  await Promise.resolve();
  expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AA==');
  expect(editor.getMarkdown()).toContain('![photo](配图/a.jpg)');
});

it('shows the unavailable state when the scoped native reader denies a path or the file is missing', async () => {
  readImage.mockResolvedValue(null);
  const editor = createEditor('![photo](../../../outside.jpg)', () => context);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledWith('/outside.jpg', '/book');
  expect(editor.view.dom.querySelector('img')?.hasAttribute('src')).toBe(false);
  expect(editor.view.dom.querySelector('.editor-image-attachment')?.classList.contains('is-error')).toBe(true);
  expect(editor.view.dom.querySelector<HTMLElement>('.editor-image-attachment__fallback')?.hidden).toBe(false);
});

it('keeps remote and attachment images on their existing loaders', async () => {
  const editor = createEditor('![remote](https://example.com/a.jpg)\n\n![attachment](asset://localhost/a.jpg)', () => context);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).not.toHaveBeenCalled();
  expect([...editor.view.dom.querySelectorAll('img')].map(img => img.getAttribute('src')))
    .toEqual(['https://example.com/a.jpg', 'https://asset.localhost/a.jpg']);
});

it('requires an authorized scope and decodes paths without applying the web-link heuristics', () => {
  expect(resolveEditorImageSource('配图/图片%20%232.jpg', context))
    .toMatchObject({ kind: 'local', path: '/book/05 我的作品/小红书历史笔记/配图/图片 #2.jpg' });
  expect(resolveEditorImageSource('配图/无扩展名', context)).toMatchObject({ kind: 'local' });
  expect(resolveEditorImageSource('file:///book/a%20b.jpg', context)).toMatchObject({ kind: 'local', path: '/book/a b.jpg' });
  expect(resolveEditorImageSource('配图/a.jpg', { ...context, scopePath: null })).toMatchObject({ kind: 'unavailable' });
  expect(resolveEditorImageSource('javascript:alert(1)', context)).toMatchObject({ kind: 'unavailable' });
});

it('ignores an image read completing after its editor has been destroyed', async () => {
  let finish!: (value: string) => void;
  readImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const editor = createEditor('![photo](配图/a.jpg)', () => context);
  await vi.runOnlyPendingTimersAsync();
  const img = editor.view.dom.querySelector('img')!;
  editor.destroy();
  editors.splice(editors.indexOf(editor), 1);
  finish('data:image/jpeg;base64,LATE');
  await Promise.resolve();
  expect(img.hasAttribute('src')).toBe(false);
});


it('ignores queued callbacks from an old observer without disconnecting the new observer', async () => {
  const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    disconnected = false;
    constructor(public callback: IntersectionObserverCallback) { observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  });
  const editor = createEditor('![photo](配图/a.jpg)', () => context);
  context = { ...context, documentPath: '/book/new/note.md' };
  editor.storage.image.refreshSources();
  const enter = (index: number) => observers[index].callback(
    [{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver,
  );
  enter(0);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).not.toHaveBeenCalled();
  expect(observers[1].disconnected).toBe(false);
  enter(1);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledExactlyOnceWith('/book/new/配图/a.jpg', '/book');
});

it('retains loaded images when only the note filename changes and refreshes without a transaction', async () => {
  const editor = createEditor('![photo](配图/a.jpg)', () => context);
  await vi.runOnlyPendingTimersAsync();
  const onTransaction = vi.fn();
  editor.on('transaction', onTransaction);
  context = { ...context, documentPath: context.documentPath.replace('08 做了一个免费的 ai 写作工具.md', '新标题.md') };
  editor.storage.image.refreshSources();
  expect(editor.view.dom.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AA==');
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledOnce();
  expect(onTransaction).not.toHaveBeenCalled();
});

it('reads the local file without the query string and reloads when its explicit version changes', async () => {
  const editor = createEditor('![photo](配图/a.jpg?v=1)', () => context);
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledExactlyOnceWith('/book/05 我的作品/小红书历史笔记/配图/a.jpg', '/book');
  const image = editor.state.doc.child(0);
  editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...image.attrs, src: '配图/a.jpg?v=2' }));
  await vi.runOnlyPendingTimersAsync();
  expect(readImage).toHaveBeenCalledTimes(2);
  expect(readImage.mock.calls[1]).toEqual(readImage.mock.calls[0]);
  expect(editor.getMarkdown()).toContain('配图/a.jpg?v=2');
});
