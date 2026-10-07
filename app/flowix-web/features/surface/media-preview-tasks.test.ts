import { beforeEach, expect, it, vi } from 'vitest';
import { files, mediaResources } from '@platform/tauri/client';

vi.mock('@platform/tauri/client', () => ({
  files: { toAssetUrl: vi.fn((path: string) => `asset://${path}`) },
  mediaResources: { thumbnail: vi.fn(), get: vi.fn(), cancelThumbnail: vi.fn() },
}));
vi.mock('./video-preview-cache', () => ({ getNotebookVideoPreview: vi.fn() }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it('uses the cached native thumbnail when available', async () => {
  vi.mocked(mediaResources.thumbnail).mockResolvedValue('/cache/preview.png');
  const { requestMediaPreview } = await import('./media-preview-tasks');
  expect(await requestMediaPreview('/book/photo.webp', '/book', 'image', 1).promise).toBe('asset:///cache/preview.png');
  expect(mediaResources.get).not.toHaveBeenCalled();
});

it('falls back to a scoped original WebP when the native codec fails', async () => {
  vi.mocked(mediaResources.thumbnail).mockRejectedValue(new Error('MEDIA_PREVIEW_UNSUPPORTED: unsupported format'));
  vi.mocked(mediaResources.get).mockResolvedValue({ resource: { sizeBytes: 14048 } } as Awaited<ReturnType<typeof mediaResources.get>>);
  const { requestMediaPreview } = await import('./media-preview-tasks');
  expect(await requestMediaPreview('/book/photo.webp', '/book', 'image', 1).promise).toBe('asset:///book/photo.webp');
  expect(mediaResources.get).toHaveBeenCalledWith('/book/photo.webp', '/book');
});

it('renders SVG directly after verifying notebook scope', async () => {
  vi.mocked(mediaResources.get).mockResolvedValue({ resource: { sizeBytes: 443 } } as Awaited<ReturnType<typeof mediaResources.get>>);
  const { requestMediaPreview } = await import('./media-preview-tasks');
  expect(await requestMediaPreview('/book/icon.svg', '/book', 'image', 1).promise).toBe('asset:///book/icon.svg');
  expect(mediaResources.thumbnail).not.toHaveBeenCalled();
});

it('does not load large originals or files that fail scope validation', async () => {
  vi.mocked(mediaResources.thumbnail).mockResolvedValue(null);
  vi.mocked(mediaResources.get).mockResolvedValueOnce({ resource: { sizeBytes: 9 * 1024 * 1024 } } as Awaited<ReturnType<typeof mediaResources.get>>).mockRejectedValueOnce(new Error('outside notebook'));
  const { requestMediaPreview } = await import('./media-preview-tasks');
  expect(await requestMediaPreview('/book/large.webp', '/book', 'image', 1).promise).toBeNull();
  expect(await requestMediaPreview('/other/photo.webp', '/book', 'image', 1).promise).toBeNull();
  expect(files.toAssetUrl).not.toHaveBeenCalled();
});
