import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ContentIcon } from './content-icon';

/**
 * 每类图形取一个渲染指纹（svg 内稳定的 path/transform/填色片段）做断言，
 * 避免逐个导出组件比对。映射调整时改这里即可发现回归。
 */
const markupFor = (path: string) => renderToStaticMarkup(<ContentIcon content={{ kind: 'file', path }} />);

describe('ContentIcon file mapping', () => {
  it('renders the blank folded-paper fallback for archive, text and unknown files', () => {
    // archive / text 已无专属图形，与 unknown 一样统一空白纸页
    // （FallbackFileIcon 的 matrix(0.6923077 …) 缩放指纹）。
    for (const path of ['archive.zip', 'backup.tar.gz', 'notes.txt', 'LICENSE', 'data.bin']) {
      expect(markupFor(path)).toContain('matrix(0.6923077');
    }
  });

  it('keeps dedicated glyphs for categories that have them', () => {
    expect(markupFor('manual.pdf')).toContain('#FF5959'); // PdfFileIcon 红色纸面
    expect(markupFor('budget.xlsx')).toContain('#2BBC6B'); // SpreadsheetFileIcon 绿色表头
    expect(markupFor('README.md')).toContain('note-content-icon'); // NoteContentIcon
    expect(markupFor('photo.jpg')).toContain('matrix(0.6666667'); // ImageFileIcon
    expect(markupFor('clip.mp4')).toContain('M13.6'); // VideoFileIcon 摄像头造型
    expect(markupFor('app.ts')).toContain('M5.25'); // CodeFileIcon 尖括号
  });
});
