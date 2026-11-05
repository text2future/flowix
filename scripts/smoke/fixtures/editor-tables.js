// Real-layout regression tests: jsdom cannot resolve CSS cascade, table borders,
// scrolling viewports, or the coordinates used by the edge insert controls.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TextSelection } from '@tiptap/pm/state';
import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import { setTableBackground } from '@features/editor/extensions/table/table-background-commands';
import { TABLE_STYLE_IDS } from '@features/editor/extensions/table/table-presentation';
import { check, checkAsync, assert, assertEqual, installCrashGuard, report, sleep } from './harness.js';

installCrashGuard();
const host = document.createElement('div');
host.className = 'markdown-editor';
host.style.cssText = 'width:760px;height:520px;--brand:#7651c7;--document-bg:#fff;--foreground:#222;--background:#fff;--muted:#eee;--border:#ccc;--muted-foreground:#777;--document-foreground:#222';
host.innerHTML = '<div class="editor-content-frame overlay-scrollbar-frame overlay-scrollbar-frame--custom-mac"><div class="editor-content overlay-scrollbar"><div class="editor-document-body"></div></div></div>';
document.body.append(host);
const pane = host.querySelector('.editor-content');
const p = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const content = (widths, styleId = 'default') => ({ type: 'doc', content: [
  p('Document paragraph'),
  { type: 'table', attrs: { styleId }, content: [0, 1, 2].map(row => ({ type: 'tableRow', content: widths.map((width, column) => ({
    type: row === 0 ? 'tableHeader' : 'tableCell', attrs: { colwidth: [width] }, content: [p(`Cell ${row}:${column} paragraph`)],
  })) })) },
  ...Array.from({ length: 20 }, () => p('Following document paragraph')),
] });
const editor = new Editor({ element: host.querySelector('.editor-document-body'), extensions: [StarterKit, Markdown, createTablePlugin()], content: content([120, 150, 90]) });
const root = editor.view.dom;
const frame = () => root.querySelector('.markdown-table-scrollbar');
const table = () => frame().querySelector('table');
const scroller = () => frame().querySelector('.tableWrapper');
const columns = () => [...table().querySelectorAll('col')].map(col => col.getBoundingClientRect().width).join(',');
const settle = async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await sleep(20);
};
const hover = async cell => {
  const rect = cell.getBoundingClientRect();
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 12, clientY: rect.top + 12 }));
  await settle();
};
const click = button => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1, `${label}: ${actual} != ${expected}`);
await settle();

for (const platform of ['mac', 'non-mac']) {
  document.documentElement.dataset.platform = platform;
  editor.commands.setContent(content([120, 150, 90]));
  await settle();
  check(`${platform}: independent axes, pane boundaries, and no table margin`, () => {
    const style = getComputedStyle(scroller());
    assertEqual(style.overscrollBehaviorY, 'auto', 'Vertical wheel must chain to the editor');
    assertEqual(style.overscrollBehaviorX, 'contain', 'Table owns horizontal gestures');
    near(frame().getBoundingClientRect().width, pane.clientWidth, 'Pane width');
    near(table().getBoundingClientRect().left, root.querySelector('p').getBoundingClientRect().left, 'Initial prose alignment');
    assertEqual(getComputedStyle(frame()).marginBottom, '0px', 'No outer bottom margin');
    assertEqual(getComputedStyle(scroller()).marginBottom, '0px', 'No inner bottom margin');
  });
  await hover(table().querySelector('tr:last-child td:last-child'));
  check(`${platform}: short-table edge controls follow the table`, () => {
    const t = table().getBoundingClientRect();
    const column = frame().querySelector('.table-edge-insert-button--column');
    const row = frame().querySelector('.table-edge-insert-button--row');
    assert(!column.hidden && !row.hidden, 'Edge buttons must be visible');
    near(column.getBoundingClientRect().left, t.right + 4, 'Column button');
    near(row.getBoundingClientRect().left, t.left, 'Row button origin');
    near(row.getBoundingClientRect().width, t.width, 'Row button width');
    near(row.getBoundingClientRect().top, t.bottom + 4, 'Row button bottom edge');
    assert(row.closest('.tableWrapper') === scroller(), 'Controls belong to the scrollable rail');
    click(column);
    assertEqual(table().rows[0].cells.length, 4, 'Column insertion');
  });
  await hover(table().querySelector('tr:last-child td:last-child'));
  check(`${platform}: row insertion uses the current table`, () => {
    click(frame().querySelector('.table-edge-insert-button--row'));
    assertEqual(table().rows.length, 4, 'Row insertion');
  });
  editor.commands.setContent(content([600, 700, 400]));
  await settle();
  const before = columns();
  scroller().dispatchEvent(new WheelEvent('wheel', { deltaX: 400 }));
  scroller().scrollLeft = 400;
  scroller().dispatchEvent(new Event('scroll'));
  check(`${platform}: wide-table scrolling, scrollbar gap and no overflow leak`, () => {
    assert(table().getBoundingClientRect().left < root.querySelector('p').getBoundingClientRect().left, 'Table enters left prose margin');
    assertEqual(pane.scrollWidth, pane.clientWidth, 'Document must not gain horizontal overflow');
    assertEqual(frame().dataset.scrolling, 'true', 'User scrolling reveals the thumb');
    near(frame().querySelector('.overlay-scrollbar-thumb--horizontal').getBoundingClientRect().top, table().getBoundingClientRect().bottom + 6, 'Scrollbar gap');
    assertEqual(frame().querySelector('.overlay-scrollbar-track--horizontal').clientWidth, scroller().clientWidth, 'No unused scrollbar corner');
  });
  await checkAsync(`${platform}: resize only changes the viewport, not stored column widths`, async () => {
    host.style.width = '1100px'; await settle();
    near(frame().getBoundingClientRect().width, pane.clientWidth, 'Resized pane width');
    assertEqual(columns(), before, 'Fixed widths after resize');
    host.style.width = '760px'; await settle();
    const saved = editor.getMarkdown();
    assert(saved.includes('"width":600'), 'Column widths persist in Markdown');
  });
  await checkAsync(`${platform}: scrolling thumb automatically fades`, async () => {
    await sleep(1000);
    assert(!frame().dataset.scrolling, 'Scrolling state must expire');
    assertEqual(getComputedStyle(frame().querySelector('.overlay-scrollbar-thumb--horizontal')).opacity, '0', 'Idle thumb is hidden');
  });
}

editor.commands.setContent(content([120, 150, 90]));
await settle();
check('triple click selects paragraph text through the real event pipeline', () => {
  const cell = table().querySelector('tr:last-child td:first-child');
  const rect = cell.querySelector('p').getBoundingClientRect();
  for (let detail = 1; detail <= 3; detail++) {
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail, clientX: rect.left + 12, clientY: rect.top + 12 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  }
  assert(editor.state.selection instanceof TextSelection, 'Triple click must not create CellSelection');
  assertEqual(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), 'Cell 2:0 paragraph', 'Selected paragraph');
});

for (const styleId of TABLE_STYLE_IDS) {
  editor.commands.setContent(content([120, 150, 90], styleId));
  await settle();
  check(`${styleId}: square table and corner-cell fills`, () => {
    const t = table();
    const corners = [t, t.rows[0].cells[0], t.rows[0].cells[2], t.rows[2].cells[0], t.rows[2].cells[2]];
    for (const corner of corners) {
      const style = getComputedStyle(corner);
      for (const property of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) {
        assertEqual(style[property], '0px', 'All table/fill corners are square');
      }
    }
  });
}

const alignmentContent = content([120, 150, 90], 'hk-financial');
const alignmentTable = alignmentContent.content.find(node => node.type === 'table');
alignmentTable.content.forEach((row, index) => {
  row.attrs = { role: index === 2 ? 'total' : 'body' };
  row.content.forEach((cell, column) => { cell.attrs.columnRole = ['label', 'right', 'amount'][column]; });
});
editor.commands.setContent(alignmentContent);
await settle();
check('plain right alignment stays distinct from financial amount styling', () => {
  const plain = getComputedStyle(table().rows[2].cells[1]);
  const amount = getComputedStyle(table().rows[2].cells[2]);
  assertEqual(plain.textAlign, 'right', 'Plain right alignment');
  assertEqual(amount.textAlign, 'right', 'Amount right alignment');
  assert(!plain.fontVariantNumeric.includes('tabular-nums'), 'Plain alignment does not enable numeric styling');
  assert(amount.fontVariantNumeric.includes('tabular-nums'), 'Amount uses tabular figures');
  assertEqual(plain.borderBottomStyle, 'none', 'Plain alignment has no financial total line');
  assertEqual(amount.borderBottomStyle, 'double', 'Amount retains the financial total line');
});

// Compare real computed colors against the existing text highlighter, not a
// separately hard-coded palette. Row fill wins where a colored column crosses it.
document.documentElement.style.setProperty('--flowix-text-yellow', '#e5bb25');
document.documentElement.style.setProperty('--flowix-text-blue', '#3982df');
const highlightReference = document.createElement('div');
highlightReference.className = 'markdown-editor';
highlightReference.innerHTML = '<div class="tiptap"><mark data-flowix-bg="yellow">yellow</mark><mark data-flowix-bg="blue">blue</mark></div>';
document.body.append(highlightReference);
for (const styleId of ['default', 'business-blue', 'striped']) {
  const colored = content([120, 150, 90], styleId);
  const node = colored.content.find(item => item.type === 'table');
  node.content[1].attrs = { rowBackground: 'yellow' };
  node.content.forEach(row => { row.content[1].attrs.columnBackground = 'blue'; });
  editor.commands.setContent(colored);
  await settle();
  check(`${styleId}: row and column backgrounds share highlight tokens`, () => {
    const yellow = getComputedStyle(highlightReference.querySelector('[data-flowix-bg="yellow"]')).backgroundColor;
    const blue = getComputedStyle(highlightReference.querySelector('[data-flowix-bg="blue"]')).backgroundColor;
    assert(getComputedStyle(table().rows[1].cells[0]).backgroundImage.includes(yellow), 'Row uses highlight yellow');
    assert(getComputedStyle(table().rows[0].cells[1]).backgroundImage.includes(blue), 'Column including header uses highlight blue');
    assert(getComputedStyle(table().rows[1].cells[1]).backgroundImage.includes(yellow), 'Row wins at intersection');
    editor.commands.setTextSelection(editor.view.posAtDOM(table().rows[1].cells[1], 0) + 1);
    setTableBackground(editor, 'row', null);
    assert(getComputedStyle(table().rows[1].cells[1]).backgroundImage.includes(blue), 'Clearing the row reveals column fill');
    setTableBackground(editor, 'column', null);
    assertEqual(getComputedStyle(table().rows[1].cells[1]).backgroundImage, 'none', 'Clearing both returns to the theme');
  });
}
highlightReference.remove();

for (const styleId of ['minimal', 'literature', 'comparison']) {
  editor.commands.setContent(content([120, 150, 90], styleId));
  for (const dark of [false, true]) {
    host.style.setProperty('--foreground', dark ? '#eee' : '#222');
    host.style.setProperty('--background', dark ? '#222' : '#fff');
    check(`${styleId}, ${dark ? 'dark' : 'light'}: opaque consistent fine-line borders`, () => {
      const first = getComputedStyle(table().rows[0].cells[0]);
      const inner = getComputedStyle(table().rows[1].cells[0]);
      assertEqual(first.borderBottomColor, inner.borderBottomColor, 'Outer/header and body color');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = inner.borderBottomColor;
      ctx.fillRect(0, 0, 1, 1);
      assertEqual(ctx.getImageData(0, 0, 1, 1).data[3], 255, 'Collapsed fine-line border must be opaque');
      const cell = table().rows[1].cells[0];
      cell.setAttribute('data-flowix-border-top', 'double');
      assertEqual(getComputedStyle(cell).borderTopStyle, 'double', 'Explicit borders still override templates');
      cell.removeAttribute('data-flowix-border-top');
    });
  }
}
// Resize hover is one continuous overlay, including the row-border crossings.
for (const styleId of ['default', 'striped', 'comparison']) {
  editor.commands.setContent(content([120, 150, 90], styleId));
  await settle();
  await checkAsync(`${styleId}: continuous resize indicator across row borders`, async () => {
    for (const column of [0, 2]) {
      const cell = table().rows[1].cells[column];
      const rect = cell.getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.right - 1, clientY: rect.top + rect.height / 2 }));
      await settle();
      const indicator = root.querySelector('.table-resize-indicator:not([hidden])');
      assert(indicator, 'Column resize overlay visible');
      const box = indicator.getBoundingClientRect();
      const outer = table().getBoundingClientRect();
      near(box.top, outer.top, 'Resize line starts at table top');
      near(box.bottom, outer.bottom, 'Resize line ends at table bottom');
      near(box.width, 2, 'Resize line stays 2px wide');
      const crossing = table().rows[1].getBoundingClientRect().bottom;
      assert(box.top < crossing && box.bottom > crossing, 'One line spans the horizontal border');
      assertEqual(getComputedStyle(cell.querySelector('.column-resize-handle')).display, 'none', 'Per-cell segments do not paint a second line');
    }
    const cell = table().rows[1].cells[1];
    await hover(cell);
    assert(!root.querySelector('.table-resize-indicator:not([hidden])'), 'Leaving a column edge hides the overlay');
  });
}
// Exercise the actual handle/document event pipeline with production layout.
for (const axis of ['column', 'row']) {
  editor.commands.setContent(content([120, 150, 90], 'comparison'));
  await settle();
  const source = axis === 'column' ? table().rows[1].cells[0] : table().rows[1].cells[1];
  await hover(source);
  const handle = root.querySelector(`.table-reorder-handle--${axis}`);
  await checkAsync(`drag ${axis} through its handle and preserve widths`, async () => {
    assert(!handle.hidden, 'Reorder handle visible');
    const tick = getComputedStyle(handle, '::before');
    assertEqual(axis === 'column' ? tick.height : tick.width, '2px', 'Quiet handle is a thin tick');
    handle.dispatchEvent(new MouseEvent('mouseenter'));
    handle.dispatchEvent(new MouseEvent('mouseleave'));
    const box = handle.getBoundingClientRect();
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: box.left + 10, clientY: box.top + 10 }));
    editor.view.dispatch(editor.state.tr.setMeta('reorder-view-only-update', true));
    const last = axis === 'column' ? table().rows[1].cells[2] : table().rows[2].cells[1];
    const target = last.getBoundingClientRect();
    const x = axis === 'column' ? target.right - 2 : target.left + target.width / 2;
    const y = axis === 'row' ? target.bottom - 2 : target.top + target.height / 2;
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    assert(!root.querySelector('.table-reorder-marker').hidden, 'Drop indicator visible');
    const preview = document.querySelector('.table-reorder-preview:not([hidden])');
    assert(preview, 'Row/column content preview visible');
    assert(preview.inert, 'Preview links and controls cannot receive focus');
    assertEqual(preview.parentElement, document.body, 'Preview escapes editor clipping');
    assertEqual(getComputedStyle(preview).position, 'fixed', 'Body portal receives preview styles');
    assertEqual(getComputedStyle(preview).backgroundColor, 'rgb(255, 255, 255)', 'Preview uses the white document surface rather than the app background');
    assertEqual(getComputedStyle(preview).pointerEvents, 'none', 'Preview cannot intercept dragging');
    assertEqual(getComputedStyle(preview).borderRadius, '0px', 'Drag preview uses square corners too');
    assertEqual(getComputedStyle(preview.querySelector('.table-reorder-preview-content')).borderRadius, '0px', 'Preview fill uses square corners');
    assert(preview.getBoundingClientRect().width > 0 && preview.getBoundingClientRect().height > 0, 'Preview has visible dimensions');
    assertEqual(preview.querySelectorAll('.table-reorder-preview-cell').length, 3, 'Preview contains the entire row/column');
    const firstPreviewCell = preview.querySelector('.table-reorder-preview-cell');
    const previewCells = preview.querySelectorAll('.table-reorder-preview-cell');
    const cell0 = previewCells[0].getBoundingClientRect();
    const cell1 = previewCells[1].getBoundingClientRect();
    if (axis === 'column') {
      near(cell0.left, cell1.left, 'Column preview cells align vertically');
      near(cell0.bottom, cell1.top, 'Column preview cells stack without overlap');
    } else {
      near(cell0.top, cell1.top, 'Row preview cells align horizontally');
      near(cell0.right, cell1.left, 'Row preview cells sit side by side');
    }
    const firstSourceCell = axis === 'column' ? table().rows[0].cells[0] : table().rows[1].cells[0];
    assertEqual(getComputedStyle(firstPreviewCell).fontWeight, getComputedStyle(firstSourceCell).fontWeight, 'Preview retains header/body font weight');
    assertEqual(getComputedStyle(firstPreviewCell).whiteSpace, getComputedStyle(firstSourceCell).whiteSpace, 'Preview retains original wrapping');
    assertEqual(getComputedStyle(firstPreviewCell.querySelector('p')).marginTop, getComputedStyle(firstSourceCell.querySelector('p')).marginTop, 'Preview retains paragraph spacing');
    assertEqual(getComputedStyle(firstPreviewCell, '::after').position, 'absolute', 'Selection background overlays cell fill');
    assertEqual(getComputedStyle(firstPreviewCell, '::after').backgroundColor, 'rgba(59, 130, 246, 0.1)', 'Preview uses the shared light-blue selection fill');
    assertEqual(getComputedStyle(firstSourceCell, '::after').backgroundColor, getComputedStyle(firstPreviewCell, '::after').backgroundColor, 'Row/column selection and preview share the same fill');
    assert(preview.textContent.includes(axis === 'column' ? 'Cell 2:0 paragraph' : 'Cell 1:2 paragraph'), 'Preview displays dragged content');
    const previewBounds = preview.getBoundingClientRect();
    near(axis === 'row' ? previewBounds.left : previewBounds.left + previewBounds.width / 2, x, 'Preview horizontal pointer anchor');
    near(axis === 'row' ? previewBounds.top + previewBounds.height / 2 : previewBounds.top, y, 'Preview vertical pointer anchor');
    const previewX = preview.getBoundingClientRect().left;
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x - 24, clientY: y }));
    assert(preview.getBoundingClientRect().left < previewX, 'Preview follows the pointer');
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
    await settle();
    assert(preview.hidden, 'Preview disappears after dropping');
    assertEqual(preview.childElementCount, 0, 'Drop releases preview content');
    root.dispatchEvent(new MouseEvent('mouseleave'));
    const selectedHandle = root.querySelector(`.table-reorder-handle--${axis}[data-selected]`);
    assert(selectedHandle && !selectedHandle.hidden, 'Selected handle persists after pointer leaves');
    editor.commands.setTextSelection(1);
    assert(selectedHandle.hidden, 'Returning to text clears pinned controls');
    assertEqual(table().rows[2].cells[2].textContent, axis === 'column' ? 'Cell 2:0 paragraph' : 'Cell 1:2 paragraph', 'Moved content');
    assertEqual(columns(), axis === 'column' ? '150,90,120' : '120,150,90', 'Widths follow columns');
    editor.commands.undo();
    await settle();
    assertEqual(table().rows[2].cells[2].textContent, 'Cell 2:2 paragraph', 'Undo restores table');
  });
}
editor.commands.setContent(content([600, 700, 400]));
scroller().scrollLeft = 0;
await settle();
await checkAsync('column drag scrolls at the viewport edge', async () => {
  await hover(table().rows[1].cells[0]);
  const handle = root.querySelector('.table-reorder-handle--column');
  const grip = handle.getBoundingClientRect();
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: grip.left + grip.width / 2, clientY: grip.top + grip.height / 2 }));
  const viewport = scroller().getBoundingClientRect();
  const row = table().rows[1].getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: viewport.right - 4, clientY: row.top + 10 }));
  await sleep(150);
  assert(scroller().scrollLeft > 0, 'Drag should automatically scroll horizontally');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
editor.commands.setContent(content([120, 150, 90]));
await settle();
await checkAsync('Escape cancels a row drag without changing content', async () => {
  const before = JSON.stringify(editor.getJSON());
  await hover(table().rows[1].cells[0]);
  const handle = root.querySelector('.table-reorder-handle--row');
  const box = handle.getBoundingClientRect();
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: box.left + 10, clientY: box.top + 10 }));
  const target = table().rows[2].cells[0].getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: target.left + 30, clientY: target.bottom - 2 }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  assertEqual(JSON.stringify(editor.getJSON()), before, 'Canceled drag must not mutate content');
  assert(root.querySelector('.table-reorder-marker').hidden, 'Canceled marker is hidden');
});
editor.setEditable(false);
await hover(table().rows[1].cells[0]);
check('read-only tables hide reorder handles', () => {
  assert(!root.querySelector('.table-reorder-handle:not([hidden])'), 'Read-only handles hidden');
});
editor.destroy();
host.remove();
report();
