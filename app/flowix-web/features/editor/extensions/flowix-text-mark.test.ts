import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { describe, expect, it } from 'vitest';
import {
  FLOWIX_TEXT_COLORS,
  FlowixHighlight,
  normalizeFlowixTextStyle,
} from './flowix-text-mark';

function createEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      FlowixHighlight.configure({ multicolor: true }),
      Markdown,
    ],
    content,
    contentType: 'markdown',
  });
}

describe('Flowix semantic highlight mark', () => {
  it('round-trips the semantic color comment format', () => {
    const markdown = '==阻塞发布的问题==<!-- flowix:text {"bg":"red","fg":"blue"} -->';
    const editor = createEditor(markdown);

    expect(editor.getJSON()).toMatchObject({
      content: [{
        content: [{
          text: '阻塞发布的问题',
          marks: [{
            type: 'highlight',
            attrs: {
              flowixBg: 'red',
              flowixFg: 'blue',
            },
          }],
        }],
      }],
    });
    expect(editor.getMarkdown()).toBe(markdown);

    editor.destroy();
  });

  it('keeps legacy highlight markdown readable and uncolored', () => {
    const editor = createEditor('==旧格式高亮==');

    expect(editor.getJSON()).toMatchObject({
      content: [{
        content: [{
          text: '旧格式高亮',
          marks: [{
            type: 'highlight',
            attrs: {
              flowixBg: null,
              flowixFg: null,
            },
          }],
        }],
      }],
    });
    expect(editor.getMarkdown()).toBe('==旧格式高亮==');

    editor.destroy();
  });

  it('canonicalizes the previous danger semantic aliases during migration', () => {
    const editor = createEditor('==阻塞发布的问题==<!-- flowix:text {"bg":"danger","fg":"on-danger"} -->');

    expect(editor.getMarkdown()).toBe(
      '==阻塞发布的问题==<!-- flowix:text {"bg":"red","fg":"red"} -->',
    );

    editor.destroy();
  });

  it('accepts only the nine stable semantic color names', () => {
    expect(FLOWIX_TEXT_COLORS).toEqual([
      'red', 'orange', 'yellow', 'green',
      'cyan', 'blue', 'purple', 'pink', 'gray',
    ]);
    expect(normalizeFlowixTextStyle({ bg: 'purple', fg: 'gray' })).toEqual({
      bg: 'purple',
      fg: 'gray',
    });
    expect(normalizeFlowixTextStyle({ bg: '#ff0000', fg: 'blue' })).toEqual({
      bg: null,
      fg: 'blue',
    });
    expect(normalizeFlowixTextStyle({ bg: 'danger', fg: 'on-danger' })).toEqual({
      bg: 'red',
      fg: 'red',
    });
  });
});
