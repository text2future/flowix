import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { createTablePlugin } from './table-plugin';
import { createTableTemplate, insertTableTemplate, TABLE_TEMPLATE_OPTIONS } from './table-templates';
import { normalizeTableStyleId, TABLE_STYLE_IDS } from './table-presentation';

const editors: Editor[] = [];
const paragraph = (text = ''): JSONContent => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

function createEditor() {
  const editor = new Editor({
    extensions: [StarterKit, createTablePlugin(), Markdown],
    content: { type: 'doc', content: [paragraph('before'), paragraph(), paragraph('after')] },
  });
  editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1);
  editors.push(editor);
  return editor;
}

afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

describe('editor table templates', () => {
  it('registers the default and all nine named templates in the shared menu order', () => {
    const expected = ['default', 'business-blue', 'striped', 'comparison', 'financial-brief', 'hk-financial', 'three-line', 'grouped', 'minimal', 'literature'];
    expect(TABLE_TEMPLATE_OPTIONS.map(option => option.styleId)).toEqual(expected);
    expect(TABLE_STYLE_IDS).toEqual(expected);
    expect(new Set(TABLE_TEMPLATE_OPTIONS.map(option => option.styleId)).size).toBe(10);
  });

  it('recognizes every registered style while safely normalizing unknown styles', () => {
    for (const { styleId } of TABLE_TEMPLATE_OPTIONS) expect(normalizeTableStyleId(styleId)).toBe(styleId);
    for (const value of [undefined, null, false, 1, 'unknown', 'business_blue', 'DEFAULT', {}]) {
      expect(normalizeTableStyleId(value)).toBe('default');
    }
  });

  it('keeps the original default as an empty 3 by 3 table', () => {
    const table = createTableTemplate('default');
    expect(table.attrs?.styleId).toBe('default');
    expect(table.content).toHaveLength(3);
    table.content!.forEach((row, index) => {
      expect(row.content).toHaveLength(3);
      row.content!.forEach(cell => {
        expect(cell.type).toBe(index === 0 ? 'tableHeader' : 'tableCell');
        expect(cell.attrs).toEqual({ columnRole: 'default' });
        expect(cell.content).toEqual([{ type: 'paragraph' }]);
      });
    });
  });

  it('creates a four-column academic table with blank data rows', () => {
    const table = createTableTemplate('three-line');
    expect(table.content).toHaveLength(4);
    expect(table.content![0].content!.map(cell => cell.content![0].content![0].text)).toEqual(['指标', '组别 A', '组别 B', 'P 值']);
    table.content!.slice(1).forEach(row => {
      expect(row.attrs?.role).toBe('body');
      expect(row.content!.map(cell => cell.attrs?.columnRole)).toEqual(['label', 'amount', 'amount', 'amount']);
      row.content!.forEach(cell => expect(cell.content).toEqual([{ type: 'paragraph' }]));
    });
  });

  it('creates an empty financial structure with explicit subtotal and total roles and no widths', () => {
    const table = createTableTemplate('hk-financial');
    expect(table.content).toHaveLength(7);
    expect(table.content![0].content!.map(cell => cell.content![0].content![0].text)).toEqual(['项目', '附注', '本期', '上期']);
    expect(table.content!.slice(1).map(row => row.content![0].content![0].content![0].text)).toEqual(['收入', '成本', '毛利', '税前利润', '税项', '年度利润']);
    expect(table.content!.map(row => row.attrs?.role)).toEqual(['body', 'body', 'body', 'subtotal', 'subtotal', 'body', 'total']);
    table.content!.forEach((row, index) => {
      expect(row.content!.map(cell => cell.attrs?.columnRole)).toEqual(['label', 'note', 'amount', 'amount']);
      row.content!.forEach(cell => expect(cell.attrs?.colwidth).toBeUndefined());
      if (index > 0) row.content!.slice(1).forEach(cell => expect(cell.content).toEqual([{ type: 'paragraph' }]));
    });
  });

  it.each(['business-blue', 'striped', 'comparison', 'financial-brief'] as const)(
    'creates the same empty operating statement for %s without fixed column widths', styleId => {
      const table = createTableTemplate(styleId);
      expect(table.content).toHaveLength(7);
      expect(table.content![0].content!.map(cell => cell.content![0].content![0].text)).toEqual(['经营指标', '上期', '本期', '同比']);
      expect(table.content!.slice(1).map(row => row.content![0].content![0].content![0].text)).toEqual(['核心业务收入', '新业务收入', '总收入', '营业成本', '经营费用', '经营利润']);
      expect(table.content!.map(row => row.attrs?.role)).toEqual(['body', 'body', 'body', 'subtotal', 'body', 'body', 'total']);
      table.content!.forEach((row, index) => {
        expect(row.content!.map(cell => cell.attrs?.columnRole)).toEqual(['label', 'amount', 'amount', 'amount']);
        row.content!.forEach(cell => expect(cell.attrs?.colwidth).toBeUndefined());
        if (index > 0) row.content!.slice(1).forEach(cell => expect(cell.content).toEqual([{ type: 'paragraph' }]));
      });
    },
  );

  it.each(['minimal', 'literature'] as const)('creates %s as a blank literature review without invented studies', styleId => {
    const table = createTableTemplate(styleId);
    expect(table.content).toHaveLength(4);
    expect(table.content![0].content!.map(cell => cell.content![0].content![0].text)).toEqual(['研究', '设计与样本', '主要结果', '局限']);
    table.content!.forEach((row, index) => {
      expect(row.attrs?.role).toBe('body');
      expect(row.content!.map(cell => cell.attrs?.columnRole)).toEqual(['label', 'default', 'default', 'default']);
      row.content!.forEach(cell => expect(cell.attrs?.colwidth).toBeUndefined());
      if (index > 0) row.content!.forEach(cell => expect(cell.content).toEqual([{ type: 'paragraph' }]));
    });
  });

  it('keeps the grouped template\'s merged section headings and blank study rows after reopening', () => {
    const editor = createEditor();
    insertTableTemplate(editor, 'grouped');
    const table = editor.state.doc.child(1);
    expect(table.childCount).toBe(10);
    expect(table.child(0).content.content.map(cell => cell.textContent)).toEqual(['研究', '设计与样本', '主要结果', '局限']);
    const groups = ['随机试验', '观察性研究', '证据综合'];
    for (let group = 0; group < groups.length; group += 1) {
      const index = group * 3 + 1;
      const heading = table.child(index);
      expect(heading.attrs.role).toBe('group');
      expect(heading.childCount).toBe(1);
      expect(heading.firstChild?.attrs).toMatchObject({ colspan: 4, columnRole: 'label', colwidth: null });
      expect(heading.textContent).toBe(groups[group]);
      for (const rowIndex of [index + 1, index + 2]) {
        expect(table.child(rowIndex).attrs.role).toBe('body');
        expect(table.child(rowIndex).childCount).toBe(4);
        expect(table.child(rowIndex).textContent).toBe('');
      }
    }
    const original = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('data-flowix-table-style="grouped"');
    expect(markdown.match(/colspan="4"/g)).toHaveLength(3);
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(original);
  });

  it('uses the active language for template content', () => {
    const table = createTableTemplate('hk-financial', 'en-US');
    expect(table.content![0].content![0].content![0].content![0].text).toBe('Item');
    expect(table.content![6].content![0].content![0].content![0].text).toBe('Profit for the year');
  });

  it.each(TABLE_TEMPLATE_OPTIONS)('inserts $styleId in the note and undoes it in one step', ({ styleId }) => {
    const editor = createEditor();
    const original = editor.getJSON();
    expect(insertTableTemplate(editor, styleId)).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe('before');
    expect(editor.state.doc.child(1).type.name).toBe('table');
    expect(editor.state.doc.child(1).attrs.styleId).toBe(styleId);
    expect(editor.state.doc.child(2).textContent).toBe('after');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(editor.state.selection.$from.parent.textContent).toBe('');
    expect(editor.isActive('table')).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.child(1).attrs.styleId).toBe(styleId);
  });

  it.each(TABLE_TEMPLATE_OPTIONS)('keeps $styleId editable and persistent through Markdown saves', ({ styleId }) => {
    const editor = createEditor();
    insertTableTemplate(editor, styleId);
    const emptyTemplate = editor.getJSON();
    const emptyCellPosition = editor.state.selection.from;
    editor.commands.setContent(editor.getMarkdown(), { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(emptyTemplate);
    editor.commands.setTextSelection(emptyCellPosition);
    editor.commands.insertContent('(9,700)');
    editor.commands.setCellAttribute('borderTop', 'none');
    editor.commands.setCellAttribute('borderBottom', 'double');
    const original = editor.getJSON();
    for (let save = 0; save < 2; save += 1) {
      const markdown = editor.getMarkdown();
      expect(markdown).toContain('(9,700)');
      expect(markdown).not.toMatch(/"width":\d/);
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(original);
    }
  });

  it('replaces an explicit slash target without leaving an extra paragraph', () => {
    const editor = createEditor();
    const from = editor.state.doc.firstChild!.nodeSize;
    expect(insertTableTemplate(editor, 'hk-financial', { replaceRange: { from, to: from + 2 } })).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe('table');
    expect(editor.state.doc.child(2).textContent).toBe('after');
  });

  it('does not change a read-only editor or an invalid insertion range', () => {
    const editor = createEditor();
    const original = editor.getJSON();
    expect(insertTableTemplate(editor, 'three-line', { replaceRange: { from: 0, to: 99999 } })).toBe(false);
    expect(editor.getJSON()).toEqual(original);
    editor.setEditable(false);
    expect(insertTableTemplate(editor, 'hk-financial')).toBe(false);
    expect(editor.getJSON()).toEqual(original);
  });

  it('refuses a nested table without changing existing content or formatting', () => {
    const editor = createEditor();
    insertTableTemplate(editor, 'hk-financial');
    editor.commands.insertContent('(9,700)');
    const original = editor.getJSON();
    expect(editor.isActive('table')).toBe(true);
    expect(insertTableTemplate(editor, 'three-line')).toBe(false);
    expect(editor.getJSON()).toEqual(original);
  });
});
