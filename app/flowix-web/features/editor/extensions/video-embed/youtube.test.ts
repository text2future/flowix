import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { web } from '@platform/tauri/client';
import { VideoEmbed } from './node';
import { isVideoReady, normalizeVideoInfo, parseVideoUrl, videoEmbedUrl } from './providers';
import { resolveVideo } from './resolve';
import type { YouTubeVideoInfo } from './providers/youtube';
import type { BilibiliVideoInfo } from './providers/bilibili';
import { pasteClipboardSnapshot } from '../paste-rules';

vi.mock('@platform/tauri/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@platform/tauri/client')>();
  return { ...actual, web: { ...actual.web, resolveBilibiliVideo: vi.fn() } };
});
const id = '4jSNiaW0IIU';
const url = `https://www.youtube.com/watch?v=${id}&amp;list=RD${id}&amp;start_radio=1`;
const editors: Editor[] = [];
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()); vi.clearAllMocks(); });
function editor() {
  const editor = new Editor({ extensions: [StarterKit, VideoEmbed, Markdown], content: '<p></p>' });
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 100, bottom: 120, left: 50, right: 150 });
  editors.push(editor);
  return editor;
}

describe('YouTube adapter', () => {
  it.each([
    url, `https://youtu.be/${id}?si=tracking`, `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`, `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ])('recognizes supported URLs: %s', input => {
    expect(parseVideoUrl(input)).toEqual({ provider: 'youtube', videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}` });
  });
  it.each([
    [`https://youtu.be/${id}?t=1h2m3s`, 3723],
    [`https://www.youtube.com/watch?v=${id}&amp;t=90`, 90],
    [`https://www.youtube.com/embed/${id}?start=60`, 60],
    [`https://youtu.be/${id}#t=1m30s`, 90],
    [`https://youtu.be/${id}?t=-2`, 0],
    [`https://youtu.be/${id}?t=NaN`, 0],
  ])('validates and preserves start time: %s', (input, start) => {
    const video = parseVideoUrl(input)!;
    if (video.provider !== 'youtube') throw new Error('Expected YouTube fixture');
    expect(video.start ?? 0).toBe(start);
    expect(new URL(videoEmbedUrl(video)).searchParams.get('start')).toBe(start ? String(start) : null);
  });
  it.each([
    `https://youtube.com.evil.org/watch?v=${id}`, `https://youtu.be/${id}/extra`,
    'https://www.youtube.com/playlist?list=abc', 'https://www.youtube.com/watch?v=bad',
    `https://user:password@www.youtube.com/watch?v=${id}`, `javascript:https://www.youtube.com/watch?v=${id}`,
  ])('does not embed unsupported or untrusted URLs: %s', input => expect(parseVideoUrl(input)).toBeNull());
  it('is immediately playable and never invokes the Bilibili resolver', async () => {
    const video = parseVideoUrl(url)!;
    expect(isVideoReady(video)).toBe(true);
    await expect(resolveVideo(video)).resolves.toBe(video);
    expect(web.resolveBilibiliVideo).not.toHaveBeenCalled();
    const embed = new URL(videoEmbedUrl(video));
    expect(embed.origin).toBe('https://www.youtube-nocookie.com');
    expect(embed.pathname).toBe(`/embed/${id}`);
    expect(embed.searchParams.get('controls')).toBe('1');
    expect(embed.searchParams.get('autoplay')).toBe('0');
  });
  it('keeps legacy platform fields out of the other provider model', () => {
    const youtube = normalizeVideoInfo({ sourceUrl: url, page: 1, aid: 123, cid: 42 });
    expect(youtube).toEqual({ provider: 'youtube', videoId: id, sourceUrl: `https://www.youtube.com/watch?v=${id}` });
    if (youtube?.provider === 'youtube') expectTypeOf(youtube).toEqualTypeOf<YouTubeVideoInfo>();
    expectTypeOf<YouTubeVideoInfo>().not.toHaveProperty('aid');
    expectTypeOf<YouTubeVideoInfo>().not.toHaveProperty('page');
    const bilibili = normalizeVideoInfo({ sourceUrl: 'https://www.bilibili.com/video/BV1TGnP6VE2f?p=2', aid: 123, cid: 42, start: 90 });
    expect(bilibili).toMatchObject({ provider: 'bilibili', page: 2, aid: 123, cid: 42 });
    expect(bilibili).not.toHaveProperty('start');
    if (bilibili?.provider === 'bilibili') expectTypeOf(bilibili).toEqualTypeOf<BilibiliVideoInfo>();
    expectTypeOf<BilibiliVideoInfo>().not.toHaveProperty('start');
  });
  it('derives identity and start time from the source rather than forged metadata', () => {
    expect(normalizeVideoInfo({ sourceUrl: url, provider: 'bilibili', aid: 123, cid: 42, start: 900, videoId: 'other' }))
      .toEqual(parseVideoUrl(url));
  });
});

describe('shared video node', () => {
  it('offers the same paste action and renders a YouTube player', () => {
    const e = editor();
    pasteClipboardSnapshot(e, { types: ['text/plain'], text: url, markdown: '', html: '', uriList: [], files: [], sourceMime: 'text/plain' });
    document.querySelector<HTMLButtonElement>('.editor-video-paste-bubble button')!.click();
    expect(e.view.dom.querySelector('iframe')?.src).toContain(`youtube-nocookie.com/embed/${id}`);
    expect(e.view.dom.querySelector('.editor-video-embed__source')?.textContent).toBe('在 YouTube 打开');
    e.commands.undo();
    expect(e.getText()).toBe(url);
  });
  it('round trips both providers through Markdown and HTML', () => {
    const e = editor();
    const youtube = parseVideoUrl(`https://youtu.be/${id}?t=90`)!;
    const bilibili = { ...parseVideoUrl('https://www.bilibili.com/video/BV1TGnP6VE2f?p=2')!, aid: 123, cid: 42 };
    e.commands.setContent({ type: 'doc', content: [youtube, bilibili].map(attrs => ({ type: 'videoEmbed', attrs })) });
    const markdown = e.getMarkdown();
    const html = e.getHTML();
    e.commands.setContent(html);
    expect(e.getJSON().content?.[0].attrs).toMatchObject(youtube);
    expect(e.getJSON().content?.[1].attrs).toMatchObject(bilibili);
    e.commands.setContent(markdown, { contentType: 'markdown' });
    expect(e.getJSON().content?.filter(node => node.type === 'videoEmbed')
      .map(node => node.attrs?.provider)).toEqual(['youtube', 'bilibili']);
    expect(e.getJSON().content?.[0].attrs).toMatchObject(youtube);
    expect(e.getJSON().content?.[1].attrs).toMatchObject(bilibili);
  });
  it('still reads older Bilibili HTML attributes', () => {
    const e = editor();
    e.commands.setContent('<div data-video-embed data-source-url="https://www.bilibili.com/video/BV1TGnP6VE2f" data-aid="123" data-cid="42"></div>');
    expect(e.getJSON().content?.[0].attrs).toMatchObject({ provider: 'bilibili', aid: 123, cid: 42 });
    expect(web.resolveBilibiliVideo).not.toHaveBeenCalled();
  });
});
