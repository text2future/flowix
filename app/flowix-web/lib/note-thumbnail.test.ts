import { describe, expect, it, vi } from 'vitest';
import { resolveNoteThumbnailSrc } from './note-thumbnail';

vi.mock('@platform/tauri/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const assetUrl = (path: string) => `asset://localhost/${encodeURIComponent(path)}`;
const NOTE = '/Users/rop/Documents/flowix/小红书运营专家/05 我的作品/小红书历史笔记/01 推荐一个中文排版字体.md';
const NOTE_DIR = '/Users/rop/Documents/flowix/小红书运营专家/05 我的作品/小红书历史笔记';

describe('resolveNoteThumbnailSrc', () => {
  it('returns null for empty input', () => {
    expect(resolveNoteThumbnailSrc(null, NOTE)).toBeNull();
    expect(resolveNoteThumbnailSrc('   ', NOTE)).toBeNull();
  });

  it('loads asset storage keys through the asset protocol', () => {
    expect(resolveNoteThumbnailSrc('asset://localhost/attachments%2Fcover.png', NOTE))
      .toBe(assetUrl('attachments/cover.png'));
  });

  it('keeps remote and inline urls untouched', () => {
    expect(resolveNoteThumbnailSrc('https://cdn.example.com/a.jpg', NOTE)).toBe('https://cdn.example.com/a.jpg');
    expect(resolveNoteThumbnailSrc('data:image/png;base64,AAAA', NOTE)).toBe('data:image/png;base64,AAAA');
    expect(resolveNoteThumbnailSrc('blob:http://localhost/abc', NOTE)).toBe('blob:http://localhost/abc');
  });

  it('resolves a document relative image against the note path', () => {
    expect(resolveNoteThumbnailSrc('配图/XHS_rop_01_01.jpg', NOTE))
      .toBe(assetUrl(`${NOTE_DIR}/配图/XHS_rop_01_01.jpg`));
  });

  it('drops the query string before hitting the filesystem', () => {
    expect(resolveNoteThumbnailSrc('./配图/a.jpg?v=2', NOTE))
      .toBe(assetUrl(`${NOTE_DIR}/配图/a.jpg`));
  });

  it('resolves file urls and absolute paths without a note path', () => {
    expect(resolveNoteThumbnailSrc('/tmp/a.jpg', null)).toBe(assetUrl('/tmp/a.jpg'));
    expect(resolveNoteThumbnailSrc('file:///tmp/b.jpg', null)).toBe(assetUrl('/tmp/b.jpg'));
  });

  it('gives up when a relative path has no document to resolve against', () => {
    expect(resolveNoteThumbnailSrc('配图/a.jpg', null)).toBeNull();
    expect(resolveNoteThumbnailSrc('配图/a.jpg', '')).toBeNull();
  });

  it('ignores directory references and unparsable schemes', () => {
    expect(resolveNoteThumbnailSrc('配图/', NOTE)).toBeNull();
    expect(resolveNoteThumbnailSrc('mailto:a@b.com', NOTE)).toBeNull();
  });
});
