import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import { resolveVideo } from './resolve';
import { VideoEmbed } from './node';
import { parseVideoUrl, videoEmbedUrl } from './providers';
import { pasteVideoLink } from './paste';
import { pasteClipboardSnapshot } from '../paste-rules';
import { createMarkdownEditorExtensions } from '../../markdown-editor-extensions';
import { createMarkdownParserExtensions } from '../../markdown-parser-extensions';

vi.mock('./resolve', async importOriginal => ({
  ...await importOriginal<typeof import('./resolve')>(),
  resolveVideo: vi.fn(() => new Promise(() => {})),
}));
beforeEach(() => { vi.mocked(resolveVideo).mockImplementation(() => new Promise(() => {})); });
const url = 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&share_source=copy';
const localizedUrl = 'https://www.bilibili.com/zh-Hans/video/BV1TGnP6VE2f/?trackid=web_pegasus_0.router-web-pegasus-2479516-gfll4.1792597429421.974&amp;spm_id_from=333.1007.tianma.3-2-10.click';
const editors: Editor[] = [];
function editor() {
  const instance = new Editor({ extensions: [StarterKit, VideoEmbed, Markdown], content: '<p></p>' });
  vi.spyOn(instance.view, 'coordsAtPos').mockReturnValue({ top: 100, bottom: 120, left: 50, right: 150 });
  editors.push(instance);
  return instance;
}
afterEach(() => { editors.splice(0).forEach(e => e.destroy()); vi.clearAllMocks(); });

describe('video providers', () => {
  it.each(['zh-Hans', 'zh-Hant', 'en', 'en-US'])('accepts a localized video path: %s', locale => {
    expect(parseVideoUrl(localizedUrl.replace('zh-Hans', locale))).toEqual({
      provider: 'bilibili', videoId: 'BV1TGnP6VE2f', page: 1,
      sourceUrl: 'https://www.bilibili.com/video/BV1TGnP6VE2f',
    });
  });
  it('canonicalizes Bilibili IDs, pages, and tracking parameters', () => {
    const video = parseVideoUrl(url)!;
    expect(video).toEqual({ provider: 'bilibili', videoId: 'BV1xx411c7mD', page: 2, sourceUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' });
    expect(videoEmbedUrl(video)).toBe('https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&page=2&autoplay=0');
    expect(parseVideoUrl('http://m.bilibili.com/video/av123')?.videoId).toBe('av123');
    expect(parseVideoUrl(url.replace('p=2', 'p=-1'))).toMatchObject({ provider: 'bilibili', page: 1 });
  });
  it.each(['https://bilibili.com.evil.org/video/BV1xx411c7mD', 'javascript:alert(1)', 'https://b23.tv/abc', 'https://www.bilibili.com/video/invalid', 'https://user:pass@www.bilibili.com/video/BV1xx411c7mD'])('leaves unsupported URLs alone: %s', value => {
    expect(parseVideoUrl(value)).toBeNull();
  });
});

describe('video embed persistence', () => {
  it('resolves and upgrades an existing embed without creating an undo step', async () => {
    const e = editor();
    const video = parseVideoUrl(localizedUrl)!;
    const resolved = { ...video, aid: 117472724261620, cid: 42907075029 };
    vi.mocked(resolveVideo).mockResolvedValue(resolved);
    e.commands.insertContent({ type: 'videoEmbed', attrs: video });
    await vi.waitFor(() => expect(e.getHTML()).toContain('cid=42907075029'));
    expect(e.getHTML()).toContain('aid=117472724261620');
    expect(e.getMarkdown()).toContain('"cid":42907075029');
    e.commands.undo();
    expect(e.getJSON().content?.some(node => node.type === 'videoEmbed')).toBe(false);
  });
  it('shows a retry and source link when resolution fails', async () => {
    const e = editor();
    vi.mocked(resolveVideo).mockRejectedValue(new Error('network error'));
    e.commands.insertContent({ type: 'videoEmbed', attrs: parseVideoUrl(url)! });
    await vi.waitFor(() => expect(e.view.dom.textContent).toContain('视频解析失败'));
    expect(e.view.dom.querySelector('iframe')).toBeNull();
    expect(e.view.dom.querySelector('.editor-video-embed__empty')?.getAttribute('data-state')).toBe('error');
    expect(e.view.dom.querySelector('.editor-video-embed__empty button')?.textContent).toBe('重新加载');
    expect(e.view.dom.querySelector('a')?.href).toContain('bilibili.com/video/');
  });
  it('retries metadata resolution from the centered error action', async () => {
    const e = editor();
    const video = parseVideoUrl(url)!;
    vi.mocked(resolveVideo).mockRejectedValueOnce(new Error('offline'));
    e.commands.insertContent({ type: 'videoEmbed', attrs: video });
    await vi.waitFor(() => expect(e.view.dom.querySelector('.editor-video-embed__empty button')).not.toBeNull());
    vi.mocked(resolveVideo).mockResolvedValueOnce({ ...video, ...{ aid: 123, cid: 42 } });
    e.view.dom.querySelector<HTMLButtonElement>('.editor-video-embed__empty button')!.click();
    await vi.waitFor(() => expect(e.view.dom.querySelector('iframe')).not.toBeNull());
  });
  it.each(['https://www.bilibili.com/video/BV1TGnP6VE2f', 'https://www.youtube.com/watch?v=4jSNiaW0IIU'])('reloads an initialized player without changing the note: %s', sourceUrl => {
    const e = editor();
    const video = parseVideoUrl(sourceUrl)!;
    e.commands.insertContent({ type: 'videoEmbed', attrs: { ...video, ...{ aid: 123, cid: 42 } } });
    const before = e.getJSON();
    const frame = e.view.dom.querySelector('iframe')!;
    const src = frame.src;
    e.view.dom.querySelector<HTMLButtonElement>('.editor-video-embed__reload')!.click();
    const replacement = e.view.dom.querySelector('iframe')!;
    expect(replacement).not.toBe(frame);
    expect(replacement.src).toBe(src);
    expect(replacement.classList.contains('is-loading')).toBe(true);
    expect(e.getJSON()).toEqual(before);
  });
  it('round trips through editor and background Markdown parsers with neighboring text', () => {
    const e = editor();
    e.commands.setContent({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
      { type: 'videoEmbed', attrs: { ...parseVideoUrl(url)!, aid: 123, cid: 42 } },
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ] });
    const markdown = e.getMarkdown();
    expect(markdown).toContain('[视频](https://www.bilibili.com/video/BV1xx411c7mD?p=2)');
    const manager = new MarkdownManager({ extensions: createMarkdownParserExtensions() });
    const parsed = manager.parse(markdown);
    expect(parsed.content?.map(n => n.type)).toEqual(['paragraph', 'videoEmbed', 'paragraph']);
    e.commands.setContent(markdown, { contentType: 'markdown' });
    expect(e.getJSON().content?.[1].attrs).toMatchObject(parseVideoUrl(url)!);
    expect(e.getHTML()).toContain('player.bilibili.com/player.html');
  });
  it('covers the initializing iframe and reveals it after the page loads', async () => {
    const e = editor();
    e.commands.insertContent({ type: 'videoEmbed', attrs: { ...parseVideoUrl(url)!, aid: 123, cid: 42 } });
    const frame = e.view.dom.querySelector('iframe')!;
    expect(frame.classList.contains('is-loading')).toBe(true);
    expect(e.view.dom.querySelector('.editor-video-embed__loading-cover')).not.toBeNull();
    frame.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(frame.classList.contains('is-loading')).toBe(false));
    expect(e.view.dom.querySelector('.editor-video-embed__loading-cover')).toBeNull();
  });
  it('preserves playback IDs through HTML copy/paste without refetching', () => {
    const e = editor();
    const video = { ...parseVideoUrl(url)!, aid: 123, cid: 42 };
    e.commands.setContent({ type: 'doc', content: [{ type: 'videoEmbed', attrs: video }] });
    const html = e.getHTML();
    e.commands.setContent(html);
    expect(e.getJSON().content?.[0].attrs).toMatchObject(video);
    expect(resolveVideo).not.toHaveBeenCalled();
  });
  it('ignores playback results after a node is removed', async () => {
    let finish!: (value: Awaited<ReturnType<typeof resolveVideo>>) => void;
    vi.mocked(resolveVideo).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const e = editor();
    const video = parseVideoUrl(url)!;
    e.commands.insertContent({ type: 'videoEmbed', attrs: video });
    e.commands.setContent('<p>replacement</p>');
    if (video.provider !== 'bilibili') throw new Error('Expected Bilibili fixture');
    finish({ ...video, aid: 123, cid: 42 });
    await Promise.resolve();
    expect(e.getText()).toBe('replacement');
    expect(e.getJSON().content?.some(node => node.type === 'videoEmbed')).toBe(false);
  });
  it('does not trust injected iframe URLs or metadata', () => {
    const e = editor();
    e.commands.setContent({ type: 'doc', content: [{ type: 'videoEmbed', attrs: { sourceUrl: 'https://evil.org', provider: 'bilibili', videoId: 'x' } }] });
    expect(e.getHTML()).not.toContain('<iframe');
    expect(e.getMarkdown()).not.toContain('evil.org');
  });
});

describe('paste choice', () => {
  function bubbleButton() {
    const button = document.querySelector<HTMLButtonElement>('.editor-video-paste-bubble button');
    expect(button).not.toBeNull();
    return button!;
  }
  it('offers conversion above a natively pasted link in the full editor', async () => {
    const e = new Editor({ extensions: createMarkdownEditorExtensions({
      getOwnerPath: () => undefined, getAttachmentNotebookId: () => undefined,
      workspaceHost: 'column-1', getPlaceholder: () => '',
    }), content: '<p></p>' });
    vi.spyOn(e.view, 'coordsAtPos').mockReturnValue({ top: 100, bottom: 120, left: 50, right: 150 });
    editors.push(e);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      types: ['text/plain'], files: [], getData: (type: string) => type === 'text/plain' ? localizedUrl : '',
    } });
    e.view.dom.dispatchEvent(event);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(e.getText()).toBe(localizedUrl);
    expect(bubbleButton().textContent).toBe('嵌入视频');
    const bubble = bubbleButton().parentElement!;
    expect(Number.parseFloat(bubble.style.top)).toBeLessThan(100);
    bubbleButton().click();
    expect(document.querySelector('.editor-video-paste-bubble')).toBeNull();
    expect(e.getJSON().content?.some(node => node.type === 'videoEmbed' && node.attrs?.videoId === 'BV1TGnP6VE2f')).toBe(true);
  });
  it('hides the bubble outside the viewport and restores it on return', () => {
    const e = editor();
    pasteVideoLink(e, url);
    const bubble = bubbleButton().parentElement!;
    vi.mocked(e.view.coordsAtPos).mockReturnValue({ top: -40, bottom: -20, left: 50, right: 150 });
    window.dispatchEvent(new Event('scroll'));
    expect(bubble.hidden).toBe(true);
    vi.mocked(e.view.coordsAtPos).mockReturnValue({ top: 100, bottom: 120, left: 50, right: 150 });
    window.dispatchEvent(new Event('scroll'));
    expect(bubble.hidden).toBe(false);
  });
  it('hides the bubble when its anchor is clipped by an editor pane', () => {
    const e = editor();
    const pane = document.createElement('div');
    pane.style.overflowY = 'auto';
    pane.append(e.view.dom);
    document.body.append(pane);
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ top: 150, bottom: 500, left: 0, right: 500 } as DOMRect);
    pasteVideoLink(e, url);
    expect(bubbleButton().parentElement!.hidden).toBe(true);
    vi.mocked(pane.getBoundingClientRect).mockReturnValue({ top: 50, bottom: 500, left: 0, right: 500 } as DOMRect);
    pane.dispatchEvent(new Event('scroll'));
    expect(bubbleButton().parentElement!.hidden).toBe(false);
    pane.remove();
  });
  it('keeps the bubble through redundant selection synchronization', () => {
    const e = editor();
    pasteVideoLink(e, url);
    e.commands.setTextSelection(e.state.selection.from);
    expect(bubbleButton().isConnected).toBe(true);
  });
  it('offers conversion through the managed clipboard pipeline', () => {
    const e = editor();
    expect(pasteClipboardSnapshot(e, {
      types: ['text/plain'], text: url, html: '', markdown: '',
      uriList: [], files: [], sourceMime: 'text/plain',
    })).toBe(true);
    expect(e.getText()).toBe(url);
    expect(bubbleButton().textContent).toBe('嵌入视频');
  });
  it('keeps a link until explicitly converted and supports undo', () => {
    const e = editor();
    expect(pasteVideoLink(e, url)).toBe(true);
    expect(e.getJSON().content?.[0].content?.[0].marks?.[0].type).toBe('link');
    bubbleButton().click();
    expect(e.getJSON().content?.some(n => n.type === 'videoEmbed')).toBe(true);
    e.commands.undo();
    expect(e.getText()).toBe(url);
  });
  it('invalidates the choice after another edit', () => {
    const e = editor();
    pasteVideoLink(e, url);
    const button = bubbleButton();
    e.commands.insertContent(' more');
    button.click();
    expect(button.isConnected).toBe(false);
    expect(e.getJSON().content?.some(n => n.type === 'videoEmbed')).toBe(false);
    expect(e.getText()).toContain(' more');
  });
  it.each(['escape', 'outside', 'destroy'])('dismisses the bubble on %s', reason => {
    const e = editor();
    pasteVideoLink(e, url);
    if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    if (reason === 'outside') document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    if (reason === 'destroy') e.destroy();
    expect(document.querySelector('.editor-video-paste-bubble')).toBeNull();
  });
  it('keeps code blocks unchanged', () => {
    const e = editor();
    e.commands.setCodeBlock();
    expect(pasteVideoLink(e, url)).toBe(false);
    expect(document.querySelector('.editor-video-paste-bubble')).toBeNull();
  });
});
