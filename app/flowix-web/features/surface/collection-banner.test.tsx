import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  listPage: vi.fn(),
  preview: vi.fn(),
  saveFromPath: vi.fn(),
  selectFiles: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@platform/tauri/client', () => ({
  mediaResources: { listPage: calls.listPage },
  dialogs: { selectFiles: calls.selectFiles },
  notebookAssets: { saveFromPath: calls.saveFromPath },
}));
vi.mock('./media-preview-tasks', () => ({ requestMediaPreview: calls.preview }));
vi.mock('@/lib/toast', () => ({ toast: { error: calls.toastError, success: vi.fn() } }));

import { CollectionBanner, saveBannerImage } from './collection-banner';
import { bannerHue } from './collection-banner-tint';

let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  vi.clearAllMocks();
});

async function renderBanner(props: Parameters<typeof CollectionBanner>[0]): Promise<HTMLDivElement> {
  const node = document.createElement('div');
  root = createRoot(node);
  await act(async () => root?.render(<CollectionBanner {...props} />));
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  return node;
}

const scope = { relativePath: '客户周报', depth: 'descendants' as const };
const baseProps = { notebookPath: '/book', notebookId: 'book-1', title: '客户周报', scope, editable: false, selectedImage: undefined, onSelectImage: () => undefined };

const resource = (relativePath: string, modifiedMs = 7) => ({
  id: 'r1', relativePath, kind: 'image' as const, modifiedMs, sizeBytes: 1, fingerprint: null,
  properties: {}, propertiesRevision: 0, createdAt: 0, updatedAt: 0,
});

describe('collection banner', () => {
  it('未选择图片时即使媒体库有图片也展示色块背景（高 220、宽 100%）', async () => {
    calls.listPage.mockResolvedValue({ resources: [resource('客户周报/a.png')], nextCursor: null, hasMore: false });
    calls.preview.mockReturnValue({ promise: Promise.resolve('asset://preview.png'), cancel: vi.fn() });

    const node = await renderBanner(baseProps);

    expect(calls.listPage).toHaveBeenCalledWith('/book', ['image'], null, 60, '客户周报', 'descendants');
    expect(calls.preview).not.toHaveBeenCalled();
    const img = node.querySelector('img');
    expect(img).toBeNull();
    expect(node.querySelector('.h-\\[220px\\]')).not.toBeNull();
  });

  it('用户指定了头图时展示指定图片（而非第一张）', async () => {
    calls.listPage.mockResolvedValue({
      resources: [resource('客户周报/a.png', 7), resource('客户周报/b.png', 9)],
      nextCursor: null, hasMore: false,
    });
    calls.preview.mockReturnValue({ promise: Promise.resolve('asset://preview.png'), cancel: vi.fn() });

    await renderBanner({ ...baseProps, selectedImage: '客户周报/b.png' });

    expect(calls.preview).toHaveBeenCalledWith('/book/客户周报/b.png', '/book', 'image', 9);
    expect(calls.preview).not.toHaveBeenCalledWith('/book/客户周报/a.png', '/book', 'image', 7);
  });

  it('指定头图在媒体库列表外（上传到 attachments/）时直接使用该路径', async () => {
    calls.listPage.mockResolvedValue({ resources: [resource('客户周报/a.png', 7)], nextCursor: null, hasMore: false });
    calls.preview.mockReturnValue({ promise: Promise.resolve('asset://preview.png'), cancel: vi.fn() });

    const node = await renderBanner({ ...baseProps, selectedImage: 'attachments/banner.png' });

    expect(calls.preview).toHaveBeenCalledWith('/book/attachments/banner.png', '/book', 'image', 0);
    expect(node.querySelector('img')?.getAttribute('src')).toBe('asset://preview.png');
  });

  it('指定的头图读不出来时回退到色块背景', async () => {
    calls.listPage.mockResolvedValue({ resources: [resource('客户周报/a.png', 7)], nextCursor: null, hasMore: false });
    // 指定图解码失败（文件被删 / 改名），第一张图正常。
    calls.preview.mockImplementation((filePath: string) => ({
      promise: Promise.resolve(filePath.endsWith('gone.png') ? null : 'asset://preview.png'),
      cancel: vi.fn(),
    }));

    const node = await renderBanner({ ...baseProps, selectedImage: '客户周报/gone.png' });

    for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
    expect(node.querySelector('img')).toBeNull();
    expect(calls.preview).not.toHaveBeenCalledWith('/book/客户周报/a.png', '/book', 'image', 7);
  });

  it('可编辑时渲染「切换图片」工具条按钮', async () => {
    calls.listPage.mockResolvedValue({ resources: [resource('客户周报/a.png')], nextCursor: null, hasMore: false });
    calls.preview.mockReturnValue({ promise: Promise.resolve('asset://preview.png'), cancel: vi.fn() });

    const node = await renderBanner({ ...baseProps, editable: true });

    const button = node.querySelector('button[aria-label="切换图片"]');
    expect(button).not.toBeNull();
  });

  it('不可编辑时不渲染「切换图片」工具条按钮', async () => {
    calls.listPage.mockResolvedValue({ resources: [resource('客户周报/a.png')], nextCursor: null, hasMore: false });
    calls.preview.mockReturnValue({ promise: Promise.resolve('asset://preview.png'), cancel: vi.fn() });

    const node = await renderBanner(baseProps);

    expect(node.querySelector('button[aria-label="切换图片"]')).toBeNull();
  });

  it('媒体库没有图片时铺标题派生的纯色占位（同高 220）', async () => {
    calls.listPage.mockResolvedValue({ resources: [], nextCursor: null, hasMore: false });

    const node = await renderBanner(baseProps);

    expect(node.querySelector('img')).toBeNull();
    const placeholder = node.querySelector<HTMLElement>('.collection-banner-placeholder');
    expect(placeholder).not.toBeNull();
    // 占位挂在外层 220 高容器里，尺寸与有图时一致。
    expect(placeholder?.closest('.h-\\[220px\\]')).not.toBeNull();
    // 只注入一个色相：纯色不靠第二个色相，样式表里也没有渐变。
    expect(placeholder?.style.getPropertyValue('--banner-hue')).toBe(`${bannerHue('客户周报')}`);
    expect(placeholder?.style.getPropertyValue('--banner-hue-alt')).toBe('');
  });

  it('没有媒体域（没有取值范围）时不发请求，但仍然铺占位', async () => {
    const node = await renderBanner({ ...baseProps, scope: undefined });

    expect(calls.listPage).not.toHaveBeenCalled();
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelector('.collection-banner-placeholder')).not.toBeNull();
  });

  it('指定头图是在线链接（http/https）时直接作 src，不走本地解码', async () => {
    calls.listPage.mockResolvedValue({ resources: [resource('客户周报/a.png', 7)], nextCursor: null, hasMore: false });
    calls.preview.mockReturnValue({ promise: Promise.resolve('asset://preview.png'), cancel: vi.fn() });

    const url = 'https://images.unsplash.com/photo-1?w=1600';
    const node = await renderBanner({ ...baseProps, selectedImage: url });

    expect(calls.preview).not.toHaveBeenCalled();
    expect(node.querySelector('img')?.getAttribute('src')).toBe(url);
  });

  it('在线链接加载失败（onError）时置空展示地址，回落标题派生的纯色占位', async () => {
    calls.listPage.mockResolvedValue({ resources: [], nextCursor: null, hasMore: false });

    const url = 'https://images.unsplash.com/photo-1?w=1600';
    const node = await renderBanner({ ...baseProps, selectedImage: url });

    expect(node.querySelector('img')?.getAttribute('src')).toBe(url);
    await act(async () => {
      node.querySelector('img')?.dispatchEvent(new Event('error'));
    });
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelector('.collection-banner-placeholder')).not.toBeNull();
  });
});

describe('bannerHue', () => {
  it('同一个标题永远得到同一个色相，不同标题换色', () => {
    expect(bannerHue('客户周报')).toBe(bannerHue('客户周报'));
    expect(bannerHue('客户周报')).not.toBe(bannerHue('客户月报'));
  });

  it('色相落在 0~359.9 的 0.1° 步进上，空标题回落到 collection', () => {
    for (const title of ['', '   ', 'a', '产品路线图', 'Q4 OKR', '客户周报']) {
      const hue = bannerHue(title);
      expect(Number.isInteger(hue * 10)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(bannerHue('')).toBe(bannerHue('collection'));
    // 整度色相下这两个会撞成同一个值，0.1° 步进后才分得开。
    expect(bannerHue('客户周报')).not.toBe(bannerHue('客户月报'));
  });
});

describe('saveBannerImage', () => {
  const t = (key: string) => key;

  it('图片存进笔记本 attachments/ 后返回相对路径', async () => {
    calls.saveFromPath.mockResolvedValue({ path: '/book/attachments/封面.png', created: true });

    expect(await saveBannerImage({ id: 'book-1', path: '/book' }, '/Users/me/封面.png', t))
      .toBe('attachments/封面.png');
    // 不带 reuseNotebookFile：顶图必须真的落到 attachments/。
    expect(calls.saveFromPath).toHaveBeenCalledWith('/Users/me/封面.png', { notebookId: 'book-1' });
  });

  it('非图片文件不落盘并提示', async () => {
    expect(await saveBannerImage({ id: 'book-1', path: '/book' }, '/Users/me/文档.pdf', t)).toBeNull();

    expect(calls.saveFromPath).not.toHaveBeenCalled();
    expect(calls.toastError).toHaveBeenCalledWith('collection.banner.imageOnly');
  });

  it('落点不在 attachments/ 时拒绝使用', async () => {
    calls.saveFromPath.mockResolvedValue({ path: '/book/客户周报/封面.png', created: false });

    expect(await saveBannerImage({ id: 'book-1', path: '/book' }, '/Users/me/封面.png', t)).toBeNull();
    expect(calls.toastError).toHaveBeenCalledWith('collection.banner.uploadFailed');
  });
});
