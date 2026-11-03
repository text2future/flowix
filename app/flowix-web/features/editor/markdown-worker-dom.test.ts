// @vitest-environment node
import { MarkdownManager } from '@tiptap/markdown';
import { afterAll, describe, expect, it } from 'vitest';
import { createMarkdownParserExtensions } from './markdown-parser-extensions';
import { installMarkdownWorkerDOM } from './markdown-worker-dom';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('HTML parsing without a browser DOM', () => {
  it('preserves HTML table cells, empty paragraphs and multiple cell paragraphs', () => {
    expect(typeof window).toBe('undefined');
    installMarkdownWorkerDOM();
    const manager = new MarkdownManager({ extensions: createMarkdownParserExtensions() });
    const empty = '<td colspan="1" rowspan="1"><p></p></td>';
    const header = '<th colspan="1" rowspan="1"><p></p></th>';
    const source = '<table style="min-width: 240px;"><colgroup>'
      + '<col style="min-width: 80px;">'.repeat(3) + '</colgroup><tbody>'
      + `<tr>${header.repeat(3)}</tr>`
      + `<tr><td colspan="1" rowspan="1"><p></p><p>哈哈好</p></td>${empty.repeat(2)}</tr>`
      + `<tr>${empty.repeat(3)}</tr></tbody></table>`;
    const doc = manager.parse(`Before\n\n${source}\n\nAfter`);
    const escapedSource = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(manager.parse(`Before\n\n${escapedSource}\n\nAfter`)).toEqual(doc);
    expect(manager.parse('```html\n' + escapedSource + '\n```').content?.[0].type).toBe('codeBlock');
    expect(manager.parse('Example: ' + escapedSource).content?.[0].type).toBe('paragraph');
    const table = doc.content?.[1];
    expect(table?.type).toBe('table');
    expect(table?.content).toHaveLength(3);
    expect(table?.content?.map(row => row.content?.length)).toEqual([3, 3, 3]);
    expect(table?.content?.[0].content?.[0].type).toBe('tableHeader');
    expect(table?.content?.[1].content?.[0].content).toEqual([
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: '哈哈好' }] },
    ]);
    expect(doc.content?.[2].content?.[0].text).toBe('After');

    const merged = manager.parse('<table><tr><td colspan="2" rowspan="2" colwidth="120,80"><p><strong>A &amp; B</strong></p><p>next</p></td></tr></table>');
    const cell = merged.content?.[0].content?.[0].content?.[0];
    expect(cell?.attrs).toMatchObject({ colspan: 2, rowspan: 2, colwidth: [120, 80] });
    expect(cell?.content?.[0].content?.[0]).toEqual({
      type: 'text', text: 'A & B', marks: [{ type: 'bold' }],
    });
  });

  it('preserves table presentation attributes in the worker schema', () => {
    installMarkdownWorkerDOM();
    const manager = new MarkdownManager({ extensions: createMarkdownParserExtensions() });
    const doc = manager.parse('<table data-flowix-table-style="hk-financial"><tr data-flowix-row-role="total"><td data-flowix-column-role="amount"><p>(9,700)</p><p>01</p></td></tr></table>');
    const table = doc.content?.[0];
    expect(table?.attrs?.styleId).toBe('hk-financial');
    expect(table?.content?.[0].attrs?.role).toBe('total');
    expect(table?.content?.[0].content?.[0].attrs?.columnRole).toBe('amount');
    expect(table?.content?.[0].content?.[0].content?.map(node => node.content?.[0].text)).toEqual(['(9,700)', '01']);
  });

  it('preserves merged HTML cell borders and normalizes unknown border attributes without browser APIs', () => {
    installMarkdownWorkerDOM();
    const manager = new MarkdownManager({ extensions: createMarkdownParserExtensions() });
    const doc = manager.parse('<table><tr><td colspan="2" data-flowix-border-top="double" data-flowix-border-bottom="none"><p>Header</p></td></tr><tr><td data-flowix-border-top="single" data-flowix-border-bottom="invalid"><p>01</p></td><td data-flowix-border-bottom="double"><p>(9,700)</p></td></tr></table>');
    const rows = doc.content?.[0].content;
    expect(rows?.[0].content?.[0].attrs).toMatchObject({ colspan: 2, borderTop: 'double', borderBottom: 'none' });
    expect(rows?.[1].content?.[0].attrs).toMatchObject({ borderTop: 'single', borderBottom: 'auto' });
    expect(rows?.[1].content?.[1].attrs).toMatchObject({ borderTop: 'auto', borderBottom: 'double' });
    expect(rows?.[1].content?.[0].content?.[0].content?.[0].text).toBe('01');
    expect(rows?.[1].content?.[1].content?.[0].content?.[0].text).toBe('(9,700)');
  });
});
