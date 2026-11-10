import { Editor, getExtensionField, type JSONContent } from '@tiptap/core';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { sanitizeExternalHtml } from '../paste-rules/html-sanitizer';
import { htmlTableToTableContent } from '../paste-rules/table';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableMap } from '@tiptap/pm/tables';
import { closeHistory } from '@tiptap/pm/history';
import { Lexer } from 'marked';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import { FlowixTable } from '@features/editor/extensions/table/flowix-table';
import { normalizeTableBorderStyle, type TableStyleId } from './table-presentation';

const editors: Editor[] = [];

function createEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), createTablePlugin(), Markdown],
    content,
    contentType: 'markdown',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
});

describe('Flowix table column widths', () => {
  it('restores hidden column widths from Markdown metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":240}]} -->',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    const table = editor.state.doc.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.firstChild?.firstChild?.attrs.colwidth).toEqual([120]);
    expect(table?.firstChild?.child(1).attrs.colwidth).toEqual([240]);
  });

  it('serializes restored widths back to metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":null}]} -->',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(editor.getMarkdown()).toContain('<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":null}]} -->');
  });

  it('keeps reading the legacy width metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table-widths=120,240 -->',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([120]);
    expect(editor.getMarkdown()).toContain('<!-- flowix:table {"version":1,"columns":[{"width":120},{"width":240}]} -->');
    expect(editor.getMarkdown()).not.toContain('flowix:table-widths=');
  });

  it('keeps tables without width metadata compatible', () => {
    const editor = createEditor([
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    expect(editor.state.doc.firstChild?.type.name).toBe('table');
    expect(editor.getMarkdown()).not.toContain('flowix:table-widths=');
  });

  it('distinguishes a missing row header from a column header', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":null},{"width":null}],"rowHeader":false,"columnHeader":true} -->',
      '|  |  |',
      '| --- | --- |',
      '| Name | Value |',
      '| Alpha | 1 |',
    ].join('\n'));

    const table = editor.state.doc.firstChild;
    expect(table?.firstChild?.firstChild?.type.name).toBe('tableHeader');
    expect(table?.firstChild?.firstChild?.textContent).toBe('Name');
    expect(table?.child(1).firstChild?.type.name).toBe('tableHeader');
    expect(table?.child(1).firstChild?.textContent).toBe('Alpha');
    expect(editor.getMarkdown()).toContain('"rowHeader":false');
    expect(editor.getMarkdown()).toContain('"columnHeader":true');
  });

  it('preserves a table after its header row is removed', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":null},{"width":null}],"rowHeader":false} -->',
      '|  |  |',
      '| --- | --- |',
      '| Alpha | Beta |',
    ].join('\n'));

    const table = editor.state.doc.firstChild;
    expect(table?.firstChild?.firstChild?.type.name).toBe('tableCell');
    expect(table?.firstChild?.firstChild?.textContent).toBe('Alpha');
    expect(editor.getMarkdown()).toContain('"rowHeader":false');
  });
});


describe('complex table HTML persistence', () => {
  const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const bullet = { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('哈哈'),
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('nested | <text>')] }] },
  ] }] };
  const tasks = { type: 'taskList', content: [true, false].map(checked => ({
    type: 'taskItem', attrs: { checked }, content: [paragraph('todo'),
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: !checked }, content: [paragraph('child')] }] },
    ],
  })) };

  it.each([bullet, tasks, { type: 'paragraph', content: [{ type: 'text', text: 'first' }] }])(
    'preserves complex cells, attributes and neighboring Markdown across repeated saves: $type', block => {
      const editor = createEditor('');
      editor.commands.setContent({ type: 'doc', content: [paragraph('before'), { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colwidth: [180] }, content: [paragraph('header')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [block, paragraph('after block')] }] },
      ] }, paragraph('after')] });
      const expected = editor.getJSON();
      for (let i = 0; i < 2; i++) {
        const markdown = editor.getMarkdown();
        expect(markdown).toContain('<table');
        expect(markdown).not.toContain('| ---');
        editor.commands.setContent(markdown, { contentType: 'markdown' });
        expect(editor.getJSON()).toEqual(expected);
      }
      const html = editor.getMarkdown();
      expect(htmlTableToTableContent(html, editor.schema)).toEqual(expected.content?.[1]);
    },
  );

  it.each([bullet, tasks])('uses HTML for a single list block: $type', block => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [{ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [160], colspan: 2 }, content: [block] }] },
    ] }] });
    const table: JSONContent | undefined = editor.getJSON().content?.[0];
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('<table');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON().content?.[0]).toEqual(table);
    const pasted = htmlTableToTableContent(sanitizeExternalHtml(markdown), editor.schema);
    expect(pasted?.content?.[0]?.content?.[0]?.content).toEqual(table?.content?.[0]?.content?.[0]?.content);
  });

  it('keeps renderers isolated between simultaneous editors', () => {
    const first = createEditor('<table><tr><td><ul><li><p>first</p></li></ul></td></tr></table>');
    const second = createEditor('<table><tr><td><p>one</p><p>two</p></td></tr></table>');
    expect(first.getMarkdown()).toContain('<ul>');
    second.destroy();
    expect(first.getMarkdown()).toContain('<ul>');
    first.commands.setContent('<table><tr><td><p>simple</p></td></tr></table>', { contentType: 'markdown' });
    expect(first.getMarkdown()).not.toContain('<table');
  });

  it('keeps literal list-like text in a simple Markdown table', () => {
    const editor = createEditor('| Header |\n| --- |\n| - 哈哈 |');
    expect(editor.getMarkdown()).not.toContain('<table');
    expect(editor.state.doc.firstChild?.child(1).firstChild?.firstChild?.type.name).toBe('paragraph');
  });
});

describe('table presentation persistence', () => {
  const paragraph = (text: string): JSONContent => ({
    type: 'paragraph', content: text ? [{ type: 'text', text }] : [],
  });

  function styledTable(styleId: TableStyleId, rowHeader = true, columnHeader = false): JSONContent {
    const values = [
      ['项目', '附注', '2026', '原始文本'],
      ['经营开支', '', '', ''],
      ['销售成本', '6', '(9,700)', '01'],
      ['经营溢利', '', '6,800', '0.00'],
      ['年度溢利', '9', '5,678', '—'],
    ];
    const roles = ['body', 'group', 'body', 'subtotal', 'total'];
    const columns = ['label', 'note', 'amount', 'default'];
    const widths = [180, 80, 120, 100];
    return {
      type: 'table', attrs: { styleId },
      content: values.map((row, rowIndex) => ({
        type: 'tableRow', attrs: { role: roles[rowIndex] },
        content: row.map((text, columnIndex) => ({
          type: (rowHeader && rowIndex === 0) || (columnHeader && columnIndex === 0)
            ? 'tableHeader' : 'tableCell',
          attrs: { columnRole: columns[columnIndex], colwidth: [widths[columnIndex]] },
          content: [paragraph(text)],
        })),
      })),
    };
  }

  it.each(['default', 'three-line', 'hk-financial'] as const)(
    'keeps %s styling, row roles, column roles and literal values through repeated pipe saves', styleId => {
      const editor = createEditor('');
      editor.commands.setContent({ type: 'doc', content: [styledTable(styleId)] });
      const expected = editor.getJSON();
      const text = editor.state.doc.textContent;
      for (let index = 0; index < 2; index += 1) {
        const markdown = editor.getMarkdown();
        expect(markdown).toContain('"version":1');
        expect(markdown).toContain('"rows":["body","group","body","subtotal","total"]');
        // Uniform column roles persist once per column instead of per cell.
        expect(markdown).toContain('"columnRoles":["label","note","amount","default"]');
        expect(markdown).not.toContain('"cells"');
        expect(markdown).not.toContain('<table');
        editor.commands.setContent(markdown, { contentType: 'markdown' });
        expect(editor.getJSON()).toEqual(expected);
        expect(editor.state.doc.textContent).toBe(text);
      }
    },
  );

  it.each([false, true])('indexes real rows when the row header is absent (column header: %s)', columnHeader => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [styledTable('hk-financial', false, columnHeader)] });
    const expected = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('"rowHeader":false');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(expected);
  });

  it('does not add presentation metadata or HTML attributes to default tables', () => {
    const editor = createEditor('| Name | Value |\n| --- | --- |\n| Alpha | 01 |');
    expect(editor.getMarkdown()).not.toContain('flowix:table');
    expect(editor.getHTML()).not.toContain('data-flowix-');
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'auto' });
  });

  it.each([
    { rowHeader: true, columnHeader: false },
    { rowHeader: false, columnHeader: false },
    { rowHeader: false, columnHeader: true },
  ])('keeps borders on real cells through pipe saves (row header: $rowHeader, column header: $columnHeader)', ({ rowHeader, columnHeader }) => {
    const editor = createEditor('');
    const table = styledTable('hk-financial', rowHeader, columnHeader);
    table.content![0].content![0].attrs!.borderTop = 'none';
    table.content![0].content![2].attrs!.borderBottom = 'single';
    Object.assign(table.content![2].content![2].attrs!, { borderTop: 'single', borderBottom: 'double' });
    table.content![4].content![2].attrs!.borderBottom = 'none';
    editor.commands.setContent({ type: 'doc', content: [paragraph('before'), table, paragraph('after')] });
    const expected = editor.getJSON();
    for (let save = 0; save < 2; save += 1) {
      const markdown = editor.getMarkdown();
      expect(markdown).not.toContain('<table');
      const metadata = JSON.parse(markdown.match(/<!-- flowix:table (\{[^\n]+\}) -->/)![1]);
      expect(metadata.version).toBe(1);
      expect(metadata.columns).toEqual([{ width: 180 }, { width: 80 }, { width: 120 }, { width: 100 }]);
      // Sparse overrides only: untouched cells carry no entry at all.
      expect(metadata.borderList).toEqual([
        [0, 0, 'none', null],
        [0, 2, null, 'single'],
        [2, 2, 'single', 'double'],
        [4, 2, null, 'none'],
      ]);
      expect(JSON.stringify(metadata.borderList)).not.toContain('auto');
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(expected);
    }
  });

  it('keeps border attributes on merged cells through HTML saves and the schema paste path', () => {
    const html = '<table data-flowix-table-style="three-line">'
      + '<tr><th colspan="2" colwidth="180,120" data-flowix-border-top="double" data-flowix-border-bottom="none"><p>表头</p></th></tr>'
      + '<tr><td rowspan="2" colwidth="180" data-flowix-border-top="single" data-flowix-border-bottom="double"><p>项目</p></td>'
      + '<td colwidth="120" data-flowix-column-role="amount" data-flowix-border-top="none" data-flowix-border-bottom="single"><p>(9,700)</p></td></tr>'
      + '<tr><td colwidth="120" data-flowix-column-role="amount" data-flowix-border-bottom="double"><p>01</p></td></tr></table>';
    const editor = createEditor(`Before\n\n${html}\n\nAfter`);
    const expected = editor.getJSON();
    expect(htmlTableToTableContent(html, editor.schema)).toEqual(expected.content?.[1]);
    for (let save = 0; save < 2; save += 1) {
      const markdown = editor.getMarkdown();
      expect(markdown).toContain('<table');
      expect(markdown).toContain('data-flowix-border-top="double"');
      expect(markdown).toContain('data-flowix-border-bottom="none"');
      expect(markdown).not.toContain('data-flowix-border-top="auto"');
      expect(markdown).not.toMatch(/style="[^"]*border/);
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(expected);
    }
  });

  it('reads dense cell and border metadata from older builds and rewrites the compact form', () => {
    const legacy = '<!-- flowix:table {"version":1,"columns":[{"width":null},{"width":null}],"styleId":"striped",'
      + '"cells":[["label","amount"],["label","amount"]],"borders":[[{"bottom":"single"},null],[null,null]]} -->';
    const editor = createEditor([legacy, '| Name | Value |', '| --- | --- |', '| Alpha | 01 |'].join('\n'));
    const table = editor.state.doc.firstChild!;
    expect(table.attrs.styleId).toBe('striped');
    expect(table.child(0).child(0).attrs).toMatchObject({ columnRole: 'label', borderBottom: 'single' });
    expect(table.child(0).child(1).attrs.columnRole).toBe('amount');
    expect(table.child(1).child(0).attrs.columnRole).toBe('label');

    const markdown = editor.getMarkdown();
    expect(markdown).toContain('"columnRoles":["label","amount"]');
    expect(markdown).toContain('"borderList":[[0,0,null,"single"]]');
    expect(markdown).not.toContain('"cells"');
    expect(markdown).not.toContain('"borders"');

    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.state.doc.firstChild?.child(0).child(0).attrs)
      .toMatchObject({ columnRole: 'label', borderBottom: 'single' });
  });

  it('normalizes malformed border metadata without shifting later cells or losing widths and text', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":180},{"width":120}],"borders":[[{"top":"dotted","bottom":"double"},42],false,[{"top":"none","bottom":"single"},["double"]]]} -->',
      '| Name | Value |', '| --- | --- |', '| Alpha | (9,700) |', '| Beta | 01 |',
    ].join('\n'));
    const table = editor.state.doc.firstChild!;
    expect(table.child(0).child(0).attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'double', colwidth: [180] });
    expect(table.child(0).child(1).attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'auto', colwidth: [120] });
    expect(table.child(1).child(0).attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'auto' });
    expect(table.child(2).child(0).attrs).toMatchObject({ borderTop: 'none', borderBottom: 'single' });
    expect(table.child(2).child(1).attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'auto' });
    expect(table.child(1).child(1).textContent).toBe('(9,700)');
    expect(table.child(2).child(1).textContent).toBe('01');
    const markdown = editor.getMarkdown();
    expect(markdown).not.toContain('dotted');
    expect(markdown).toContain('"borderList":[[0,0,null,"double"],[2,0,"none","single"]]');
  });

  it('drops default or wholly invalid borders instead of adding metadata', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":null}],"borders":[[{"top":"auto","bottom":"dashed"}],[null],{}]} -->',
      '| Name |', '| --- |', '| Alpha |',
    ].join('\n'));
    expect(editor.getMarkdown()).not.toContain('flowix:table');
    expect(editor.getHTML()).not.toContain('data-flowix-border-');
  });

  it('normalizes invalid schema and HTML border values while retaining valid edges', () => {
    for (const value of [undefined, null, false, 1, 'DOUBLE', 'dashed', {}]) {
      expect(normalizeTableBorderStyle(value)).toBe('auto');
    }
    const editor = createEditor('<table><tr><td data-flowix-border-top="bad" data-flowix-border-bottom="double"><p>01</p></td></tr></table>');
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'double' });
    const cell = editor.state.doc.firstChild!.firstChild!.firstChild!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(2, undefined, { ...cell.attrs, borderTop: 'invalid', borderBottom: 'single' }));
    expect(editor.getHTML()).not.toContain('data-flowix-border-top');
    expect(editor.getHTML()).toContain('data-flowix-border-bottom="single"');
    const markdown = editor.getMarkdown();
    expect(markdown).not.toContain('invalid');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'single' });
  });

  it('normalizes invalid metadata values without dropping valid column widths or text', () => {
    const editor = createEditor([
      '<!-- flowix:table {"version":1,"columns":[{"width":180},{"width":120}],"styleId":"unknown","rows":[null,"total"],"cells":[["bad","amount"],false]} -->',
      '| Name | Value |', '| --- | --- |', '| Alpha | (9,700) |',
    ].join('\n'));
    const table = editor.state.doc.firstChild!;
    expect(table.attrs.styleId).toBe('default');
    expect(table.child(0).attrs.role).toBe('body');
    expect(table.child(1).attrs.role).toBe('total');
    expect(table.child(0).child(0).attrs).toMatchObject({ colwidth: [180], columnRole: 'default' });
    expect(table.child(0).child(1).attrs.columnRole).toBe('amount');
    expect(table.child(1).child(1).attrs.columnRole).toBe('default');
    expect(table.child(1).child(1).textContent).toBe('(9,700)');
  });

  it('preserves presentation when switching from pipe to complex HTML and back', () => {
    const editor = createEditor('');
    const table = styledTable('hk-financial');
    table.content![2].content![2].content!.push(paragraph('未经改写'));
    editor.commands.setContent({ type: 'doc', content: [paragraph('before'), table, paragraph('after')] });
    const expected = editor.getJSON();
    for (let index = 0; index < 2; index += 1) {
      const markdown = editor.getMarkdown();
      expect(markdown).toContain('<table');
      expect(markdown).toContain('data-flowix-table-style="hk-financial"');
      expect(markdown).toContain('data-flowix-row-role="total"');
      expect(markdown).toContain('data-flowix-column-role="amount"');
      editor.commands.setContent(markdown, { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(expected);
    }
    const simplified: JSONContent = editor.getJSON();
    simplified.content![1].content![2].content![2].content!.pop();
    editor.commands.setContent(simplified);
    const simplifiedExpected = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).not.toContain('<table');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(simplifiedExpected);
  });

  it('uses HTML for merged cells without losing roles or their layout', () => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [{
      type: 'table', attrs: { styleId: 'three-line' }, content: [{
        type: 'tableRow', attrs: { role: 'group' }, content: [{
          type: 'tableCell', attrs: { colspan: 2, colwidth: [120, 80], columnRole: 'label' },
          content: [paragraph('分组')],
        }],
      }, {
        type: 'tableRow', attrs: { role: 'total' }, content: ['5,678', '4,342'].map(text => ({
          type: 'tableCell', attrs: { columnRole: 'amount' }, content: [paragraph(text)],
        })),
      }],
    }] });
    const expected = editor.getJSON();
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('<table');
    expect(markdown).toContain('colspan="2"');
    editor.commands.setContent(markdown, { contentType: 'markdown' });
    expect(editor.getJSON()).toEqual(expected);
  });

  it('updates the actual resizable table DOM when styles and roles change', () => {
    const editor = createEditor('| Name | Value |\n| --- | --- |\n| Alpha | 01 |');
    const originalText = editor.state.doc.textContent;
    const table = editor.state.doc.firstChild!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...table.attrs, styleId: 'hk-financial' }));
    expect(editor.view.dom.querySelector('table')?.getAttribute('data-flowix-table-style')).toBe('hk-financial');
    const row = editor.state.doc.firstChild!.firstChild!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(1, undefined, { ...row.attrs, role: 'total' }));
    const cell = editor.state.doc.firstChild!.firstChild!.firstChild!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(2, undefined, { ...cell.attrs, columnRole: 'note' }));
    expect(editor.view.dom.querySelector('tr')?.getAttribute('data-flowix-row-role')).toBe('total');
    expect(editor.view.dom.querySelector('th')?.getAttribute('data-flowix-column-role')).toBe('note');
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...table.attrs, styleId: 'default' }));
    expect(editor.view.dom.querySelector('table')?.hasAttribute('data-flowix-table-style')).toBe(false);
    expect(editor.state.doc.textContent).toBe(originalText);
  });

  it('parses a report with many styled tables without recursively tokenizing its remaining tables', () => {
    const report = Array.from({ length: 8 }, (_, index) => [
      '<!-- flowix:table {"version":1,"columns":[{"width":180},{"width":120}],"styleId":"hk-financial","rows":["body","total"],"cells":[["label","amount"],["label","amount"]]} -->',
      '| 项目 | 金额 |', '| --- | --- |', `| Table ${index + 1} | (9,700) |`,
    ].join('\n')).join('\n\n') + '\n\nReport end';
    const tokenizations = vi.spyOn(Lexer.prototype, 'blockTokens');
    try {
      const editor = createEditor(report);
      expect(tokenizations.mock.calls.length).toBeLessThanOrEqual(17);
      const tables = editor.state.doc.content.content.filter(node => node.type.name === 'table');
      expect(tables).toHaveLength(8);
      tables.forEach((table, index) => {
        expect(table.attrs.styleId).toBe('hk-financial');
        expect(table.child(1).attrs.role).toBe('total');
        expect(table.child(1).firstChild?.textContent).toBe(`Table ${index + 1}`);
      });
      const expected = editor.getJSON();
      editor.commands.setContent(editor.getMarkdown(), { contentType: 'markdown' });
      expect(editor.getJSON()).toEqual(expected);
    } finally {
      tokenizations.mockRestore();
    }
  });

  function selectCell(editor: Editor, row: number, column: number): void {
    const table = editor.state.doc.firstChild!;
    const map = TableMap.get(table);
    editor.commands.setTextSelection(1 + map.map[row * map.width + column] + 2);
  }

  it.each(['addRowBefore', 'addRowAfter'] as const)('%s inherits only explicit column roles into the new row', command => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [styledTable('hk-financial')] });
    const original = editor.getJSON();
    const rows = editor.state.doc.firstChild!.content.content.map(row => row.toJSON());
    editor.view.dispatch(closeHistory(editor.state.tr));
    selectCell(editor, 2, 2);
    expect(editor.can()[command]()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
    expect(editor.commands[command]()).toBe(true);
    const insertedIndex = command === 'addRowBefore' ? 2 : 3;
    const table = editor.state.doc.firstChild!;
    const inserted = table.child(insertedIndex);
    expect(inserted.attrs.role).toBe('body');
    expect(inserted.textContent).toBe('');
    expect(inserted.content.content.map(cell => cell.attrs.columnRole)).toEqual(['label', 'note', 'amount', 'default']);
    expect(table.content.content.filter((_, index) => index !== insertedIndex).map(row => row.toJSON())).toEqual(rows);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(original);
  });

  it('inherits roles when Tab at the final cell creates a new row', () => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [styledTable('hk-financial')] });
    selectCell(editor, 4, 3);
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const table = editor.state.doc.firstChild!;
    expect(table.childCount).toBe(6);
    expect(table.lastChild?.attrs.role).toBe('body');
    expect(table.lastChild?.content.content.map(cell => cell.attrs.columnRole)).toEqual(['label', 'note', 'amount', 'default']);
  });

  it('inherits roles through the actual table edge insert button', async () => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [styledTable('hk-financial')] });
    const lastCell = editor.view.dom.querySelector('tr:last-child td:last-child')!;
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => lastCell;
    try {
      lastCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      // Edge controls are placed once per frame, not once per mousemove.
      await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
    } finally {
      document.elementFromPoint = elementFromPoint;
    }
    const root = editor.view.dom.parentElement ?? editor.view.dom;
    const button = root.querySelector<HTMLButtonElement>('.table-edge-insert-button--row')!;
    expect(button.hidden).toBe(false);
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const table = editor.state.doc.firstChild!;
    expect(table.childCount).toBe(6);
    expect(table.lastChild?.content.content.map(cell => cell.attrs.columnRole)).toEqual(['label', 'note', 'amount', 'default']);
  });

  it('leaves inconsistent and unknown columns at default without rewriting explicit roles', () => {
    const editor = createEditor('');
    const table = styledTable('hk-financial');
    table.content![2].content![2].attrs!.columnRole = 'note';
    editor.commands.setContent({ type: 'doc', content: [table] });
    const originalRows = editor.state.doc.firstChild!.content.content.map(row => row.toJSON());
    selectCell(editor, 4, 2);
    editor.commands.addRowAfter();
    const updated = editor.state.doc.firstChild!;
    expect(updated.lastChild?.content.content.map(cell => cell.attrs.columnRole)).toEqual(['label', 'note', 'default', 'default']);
    expect(updated.content.content.slice(0, -1).map(row => row.toJSON())).toEqual(originalRows);
  });

  it('uses logical columns around rowspan cells and preserves their explicit role', () => {
    const editor = createEditor('');
    const cell = (role: string, text: string, rowspan = 1): JSONContent => ({
      type: 'tableCell', attrs: { columnRole: role, rowspan }, content: [paragraph(text)],
    });
    editor.commands.setContent({ type: 'doc', content: [{ type: 'table', content: [
      { type: 'tableRow', content: [cell('label', '分组', 2), cell('note', '5'), cell('amount', '(9,700)')] },
      { type: 'tableRow', attrs: { role: 'total' }, content: [cell('note', '6'), cell('amount', '01')] },
    ] }] });
    selectCell(editor, 1, 2);
    editor.commands.addRowBefore();
    const table = editor.state.doc.firstChild!;
    expect(table.firstChild?.firstChild?.attrs).toMatchObject({ rowspan: 3, columnRole: 'label' });
    expect(table.child(1).content.content.map(cell => cell.attrs.columnRole)).toEqual(['note', 'amount']);
    expect(table.child(2).attrs.role).toBe('total');
    expect(table.child(2).textContent).toBe('601');
  });

  it('does not infer roles from numbers or apply a previous table\'s roles to a newly pasted table', () => {
    const editor = createEditor('');
    editor.commands.setContent({ type: 'doc', content: [styledTable('hk-financial'), paragraph('after')] });
    const insertion = editor.state.doc.content.size;
    expect(editor.commands.insertContentAt(insertion, '<table><tr><td>01</td><td>(9,700)</td></tr></table>')).toBe(true);
    const tables = editor.state.doc.content.content.filter(node => node.type.name === 'table');
    expect(tables).toHaveLength(2);
    expect(tables[1].firstChild?.content.content.map(cell => cell.attrs.columnRole)).toEqual(['default', 'default']);
    let pastedPosition = 0;
    editor.state.doc.forEach((node, offset) => { if (node === tables[1]) pastedPosition = offset; });
    editor.commands.setTextSelection(pastedPosition + 4);
    editor.commands.addRowAfter();
    const pasted = editor.state.doc.nodeAt(pastedPosition)!;
    expect(pasted.lastChild?.content.content.map(cell => cell.attrs.columnRole)).toEqual(['default', 'default']);
    expect(pasted.firstChild?.textContent).toBe('01(9,700)');
  });
});

describe('renderer boundaries', () => {
  const mergedCellTable = (): JSONContent => ({
    type: 'table',
    content: [{
      type: 'tableRow',
      content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [{ type: 'paragraph' }] }],
    }],
  });

  it('refuses to downgrade a complex table without an editor schema', () => {
    const renderMarkdown = getExtensionField(FlowixTable, 'renderMarkdown') as (
      node: JSONContent, helpers: unknown, ctx: unknown,
    ) => string;

    // This base renderer has no schema, so it cannot emit the HTML the table
    // needs. Failing loud beats silently dropping merged cells.
    expect(() => renderMarkdown(mergedCellTable(), {}, {})).toThrow(/needs HTML/);
  });

  it('still renders complex tables through the editor path', () => {
    const editor = new Editor({
      extensions: [StarterKit, createTablePlugin(), Markdown],
      content: { type: 'doc', content: [mergedCellTable()] },
    });
    editors.push(editor);

    expect(() => editor.getMarkdown()).not.toThrow();
    expect(editor.getMarkdown()).toContain('colspan="2"');
  });
});

describe('edge insert button labels', () => {
  it('uses the labels the plugin was configured with', async () => {
    const editor = new Editor({
      extensions: [StarterKit, createTablePlugin({
        labels: { insertColumnAfter: '右侧插入列', insertRowAfter: '下方插入行' },
      })],
      content: {
        type: 'doc',
        content: [{ type: 'table', content: [{
          type: 'tableRow',
          content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }],
        }] }],
      },
    });
    editors.push(editor);

    const cell = editor.view.dom.querySelector('td')!;
    const elementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => cell;
    try {
      cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await new Promise<void>(resolve => { requestAnimationFrame(() => resolve()); });
    } finally {
      document.elementFromPoint = elementFromPoint;
    }

    const root = editor.view.dom.parentElement ?? editor.view.dom;
    // A single-cell table is both the last column and the last row.
    expect(root.querySelector('.table-edge-insert-button--row')?.getAttribute('title')).toBe('下方插入行');
    expect(root.querySelector('.table-edge-insert-button--column')?.getAttribute('title')).toBe('右侧插入列');
  });
});
