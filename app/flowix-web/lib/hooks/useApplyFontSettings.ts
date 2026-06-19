'use client';

import { useEffect } from 'react';
import type { FormatConfig } from '../constants';

/**
 * 将用户在「Preferences → Format」中选择的字体/字号/行间距/文档宽度写入 :root
 * 的 CSS 变量。
 *
 * 变量写入 :root 是为了 hook 点稳定, 但消费方 (css/editor.css 的
 * .markdown-editor .ProseMirror) 是唯一应用这些变量的地方 ——
 * 不再写到 body / html, 因此这些设置只影响 Tiptap 编辑器内容区,
 * 不会泄漏到 MemoList、Agent 面板、shadcn 按钮等其它 UI 文本。
 *
 * 与之配套的变量定义在 css/index.css :
 *   --app-font-family
 *   --app-font-size
 *   --app-line-height
 *   --app-document-width
 *
 * 调用方: App.tsx (主窗口 + 偏好设置窗口都会挂载, 因此跨窗口都会立即响应)。
 */
export function useApplyFontSettings(format: FormatConfig | undefined) {
  useEffect(() => {
    if (!format) return;
    const root = document.documentElement;
    if (format.fontFamily) {
      root.style.setProperty('--app-font-family', format.fontFamily);
    }
    if (typeof format.fontSize === 'number' && !Number.isNaN(format.fontSize)) {
      root.style.setProperty('--app-font-size', `${format.fontSize}px`);
    }
    if (typeof format.lineHeight === 'number' && !Number.isNaN(format.lineHeight)) {
      root.style.setProperty('--app-line-height', String(format.lineHeight));
    }
    if (typeof format.documentWidth === 'number' && !Number.isNaN(format.documentWidth)) {
      root.style.setProperty('--app-document-width', `${format.documentWidth}px`);
    }
  }, [format?.fontFamily, format?.fontSize, format?.lineHeight, format?.documentWidth]);
}
