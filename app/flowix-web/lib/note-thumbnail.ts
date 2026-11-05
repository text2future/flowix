import { convertFileSrc } from '@platform/tauri/core';
import { decodeStorageKey } from './asset-markdown';
import { resolveDocumentRelativeHref } from './document-relative-path';

/**
 * 笔记索引里的 `thumbnail` 有两种值域：
 *   1. `asset://localhost/<存储键>` ── 编辑器内粘贴/上传的图片写回 Markdown 的形态；
 *   2. 文档相对路径 ── 外部写入或导入的 Markdown 原样保留（如 `配图/cover.jpg`）。
 *
 * 渲染端过去只处理第 1 种，第 2 种会被直接塞进 `<img src>`，被 WebView 当成
 * 相对自身 origin 的地址而 404。这里把两种都规约成可直接加载的 URL。
 *
 * 走 asset protocol（`convertFileSrc`）而不是 `readImageFile` 回读 base64：
 * 同步、无 IPC、无 base64 常驻内存，且由 WebView 自带缓存。
 * 前提是 `tauri.conf.json` 的 assetProtocol scope 已放开（当前为 `**`）。
 *
 * 代价：加载的是原图，没有降采样。列表是虚拟滚动 + `loading="lazy"`，
 * 同时在屏的图有限；若日后出现超大原图导致的解码卡顿，再引入
 * `mediaResources.thumbnail` 那条原生缩略图管线（带磁盘缓存），而不是退回 base64。
 */
export function resolveNoteThumbnailSrc(
  thumbnail: string | null | undefined,
  /** 笔记文件自身的绝对路径；文档相对路径据此解析。 */
  documentPath: string | null | undefined,
): string | null {
  const raw = thumbnail?.trim();
  if (!raw) return null;

  const storageKey = decodeStorageKey(raw);
  if (storageKey) return convertFileSrc(storageKey);

  // 远程/内联地址与文档位置无关，原样交给浏览器。
  if (/^(?:https?:|data:|blob:)/i.test(raw)) return raw;

  const target = resolveDocumentRelativeHref(raw, documentPath);
  if (!target || target.isDirectory) return null;
  return convertFileSrc(target.path);
}
