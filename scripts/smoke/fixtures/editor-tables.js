// Real-layout regression tests: jsdom cannot resolve CSS cascade, table borders,
// scrolling viewports, or the coordinates used by the edge insert controls.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TextSelection } from '@tiptap/pm/state';
import { createTablePlugin } from '@features/editor/extensions/table/table-plugin';
import { setTableBackground } from '@features/editor/extensions/table/table-background-commands';
import { TABLE_RESIZE_HINT_DELAY_MS } from '@features/editor/extensions/table/table-resize-indicator';
import { TABLE_STYLE_IDS } from '@features/editor/extensions/table/table-presentation';
import { check, checkAsync, assert, assertEqual, installCrashGuard, report, sleep } from './harness.js';

installCrashGuard();
// :root resolves var() on the root element itself, not on descendants, so the
// theme token must also live on <html> for the table selection fill to compute.
document.documentElement.style.setProperty('--info', '#0085e6');
const host = document.createElement('div');
host.className = 'markdown-editor';
host.style.cssText = 'width:760px;height:520px;--brand:#7651c7;--info:#0085e6;--info-foreground:#fff;--document-bg:#fff;--foreground:#222;--background:#fff;--muted:#eee;--border:#ccc;--muted-foreground:#777;--document-foreground:#222';
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
// Resize hover is gated on a dwell, so holding the pointer on an edge means
// staying there past the reveal delay, not just sending one mousemove.
const restOnEdge = async cell => {
  const rect = cell.getBoundingClientRect();
  cell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.right - 1, clientY: rect.top + rect.height / 2 }));
  await settle();
  await sleep(TABLE_RESIZE_HINT_DELAY_MS + 40);
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
  check(`${platform}: edge controls are fixed squares past the far edges`, () => {
    const t = table().getBoundingClientRect();
    const column = frame().querySelector('.table-edge-insert-button--column');
    const row = frame().querySelector('.table-edge-insert-button--row');
    assert(!column.hidden && !row.hidden, 'Edge buttons must be visible');
    const cb = column.getBoundingClientRect();
    const rb = row.getBoundingClientRect();
    near(cb.width, 24, 'Column button is a 24px square');
    near(cb.height, 24, 'Column button height');
    near(rb.width, 24, 'Row button is a 24px square');
    near(rb.height, 24, 'Row button height');
    near(cb.left, t.right + 4, 'Column button sits right of the last column');
    near(cb.top, t.top, 'Column button aligns with the table top');
    near(rb.left, t.left, 'Row button aligns with the table left');
    near(rb.top, t.bottom + 4, 'Row button sits below the last row');
    const cz = frame().querySelector('.table-edge-insert-hover-zone--column').getBoundingClientRect();
    const rz = frame().querySelector('.table-edge-insert-hover-zone--row').getBoundingClientRect();
    near(cz.left, t.right, 'Column hover bridge starts at the right edge');
    near(cz.width, 28, 'Column hover bridge spans the gutter');
    near(rz.top, t.bottom, 'Row hover bridge starts at the bottom edge');
    near(rz.height, 28, 'Row hover bridge spans the gutter');
    near(rz.left, t.left, 'Row hover bridge starts at the table left');
    near(rz.width, t.width, 'Row hover bridge spans the whole bottom gutter');
    // Without a horizontal scrollbar the whole band is a hover bridge, so the
    // row button persists even when the pointer travels far to the right.
    // elementFromPoint is unusable here: the smoke viewport can be shorter than
    // the document, so assert ownership through CSS + geometry instead.
    const rowZone = frame().querySelector('.table-edge-insert-hover-zone--row');
    const track = frame().querySelector('.overlay-scrollbar-track--horizontal');
    const thumb = frame().querySelector('.overlay-scrollbar-thumb--horizontal');
    assertEqual(frame().dataset.horizontalScrollable, 'false', 'Narrow table has no horizontal scrollbar');
    assertEqual(getComputedStyle(track).pointerEvents, 'none', 'Idle track yields the bottom band');
    assertEqual(getComputedStyle(thumb).pointerEvents, 'none', 'Idle thumb yields the bottom band');
    assertEqual(getComputedStyle(rowZone).pointerEvents, 'auto', 'Row bridge stays hit-testable');
    assertEqual(getComputedStyle(rowZone).zIndex, '0', 'Row bridge is stacked below the scrollbar');
    assert(t.left + 100 < rz.right && t.bottom + 12 < rz.bottom, 'Whole bottom gutter keeps the row button alive');
    assert(row.closest('.tableWrapper') === scroller(), 'Controls belong to the scrollable rail');
    // Crossing the last column's 8px resize band makes prosemirror-tables
    // dispatch doc-free setHandle transactions. They must not clear the button
    // before the pointer can travel from the cell onto its hover bridge.
    const lastCell = table().querySelector('tr:last-child td:last-child');
    const cellRect = lastCell.getBoundingClientRect();
    lastCell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cellRect.right - 2, clientY: cellRect.top + 10 }));
    const columnBridge = frame().querySelector('.table-edge-insert-hover-zone--column');
    columnBridge.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cellRect.right + 2, clientY: cellRect.top + 10 }));
    assert(!column.hidden, 'Column button survives the resize-handle hover band');
    click(column);
    assertEqual(table().rows[0].cells.length, 4, 'Column insertion');
  });
  await hover(table().querySelector('tr:last-child td:last-child'));
  check(`${platform}: row insertion uses the current table`, () => {
    click(frame().querySelector('.table-edge-insert-button--row'));
    assertEqual(table().rows.length, 4, 'Row insertion');
  });
  await checkAsync(`${platform}: full-width row bridge yields to the scrollbar band`, async () => {
    editor.commands.setContent(content([600, 700, 400]));
    await settle();
    assertEqual(frame().dataset.horizontalScrollable, 'true', 'Band belongs to a scrollable table');
    // Hit-testing needs real viewport coordinates; the bottom band can sit
    // below a short smoke viewport until the table is scrolled into view.
    frame().scrollIntoView({ block: 'center' });
    await settle();
    await hover(table().querySelector('tr:last-child td:last-child'));
    const row = frame().querySelector('.table-edge-insert-button--row');
    const zone = frame().querySelector('.table-edge-insert-hover-zone--row');
    const t = table().getBoundingClientRect();
    near(zone.getBoundingClientRect().width, t.width, 'Row bridge spans the full table width');
    assert(!row.hidden, 'Row button is visible before entering the band');
    const track = frame().querySelector('.overlay-scrollbar-track--horizontal');
    const band = track.getBoundingClientRect();
    const x = band.left + 120;
    const y = band.top + Math.min(3, band.height / 2);
    // The 6px strip between the table border and the track is still the bridge.
    const strip = document.elementFromPoint(x, t.bottom + 2);
    assert(strip && strip.closest('.table-edge-insert-hover-zone--row'), 'Row bridge owns the strip above the track');
    const hit = document.elementFromPoint(x, y);
    assert(hit && hit.closest('.overlay-scrollbar-track--horizontal, .overlay-scrollbar-thumb--horizontal'), 'Scrollbar wins hit-testing in the shared band');
    assert(!hit.closest('.table-edge-insert-hover-zone'), 'Row bridge never covers the scrollbar');
    strip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: t.bottom + 2 }));
    await settle();
    assert(!row.hidden, 'Row button survives the gap above the track');
    const pointer = type => new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 7, clientX: x, clientY: y });
    hit.dispatchEvent(pointer('pointermove'));
    assertEqual(frame().dataset.horizontalTrackHover, 'true', 'Scrollbar hover is tracked over the shared band');
    hit.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    await settle();
    assert(!row.hidden, 'Row button survives the scrollbar hover band');
    const rb = row.getBoundingClientRect();
    const buttonHit = document.elementFromPoint(rb.left + rb.width / 2, rb.top + rb.height / 2);
    assert(buttonHit === row || row.contains(buttonHit), 'Row button stays clickable above the track');
    click(row);
    assertEqual(table().rows.length, 4, 'Row insertion after crossing the scrollbar band');
    frame().dispatchEvent(pointer('pointerleave'));
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
  await checkAsync(`${platform}: hovering the scrollbar band reveals and drags the thumb`, async () => {
    const track = frame().querySelector('.overlay-scrollbar-track--horizontal');
    const thumb = frame().querySelector('.overlay-scrollbar-thumb--horizontal');
    assert(!frame().dataset.scrolling, 'Hover starts from an idle scrollbar');
    const band = track.getBoundingClientRect();
    const pointer = (type, x, y) => new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerType: 'mouse', pointerId: 9,
      button: 0, clientX: x, clientY: y,
    });
    const hoverX = band.left + 20;
    const hoverY = band.top + 2;
    track.dispatchEvent(pointer('pointermove', hoverX, hoverY));
    assertEqual(frame().dataset.horizontalTrackHover, 'true', 'Scrollbar band hover is tracked');
    await sleep(280);
    assertEqual(getComputedStyle(thumb).opacity, '1', 'Hover reveals the horizontal thumb');
    assertEqual(getComputedStyle(thumb).pointerEvents, 'auto', 'Thumb stays hit-testable for dragging');
    frame().dispatchEvent(pointer('pointerleave', hoverX, hoverY));
    await sleep(280);
    assertEqual(getComputedStyle(thumb).opacity, '0', 'Thumb fades when the band is left');
    // Synthetic pointers have no active capture; stub the capture API for the
    // drag gesture only, then restore it so real input is unaffected.
    const setCapture = thumb.setPointerCapture;
    const releaseCapture = thumb.releasePointerCapture;
    thumb.setPointerCapture = () => {};
    thumb.releasePointerCapture = () => {};
    try {
      track.dispatchEvent(pointer('pointermove', hoverX, hoverY));
      const grip = thumb.getBoundingClientRect();
      const startX = grip.left + 8;
      const gripY = grip.top + 2;
      const before = scroller().scrollLeft;
      thumb.dispatchEvent(pointer('pointerdown', startX, gripY));
      assertEqual(frame().dataset.horizontalDragging, 'true', 'Thumb drag starts');
      thumb.dispatchEvent(pointer('pointermove', startX + 80, gripY));
      assert(scroller().scrollLeft > before, 'Dragging the thumb scrolls the table');
      thumb.dispatchEvent(pointer('pointerup', startX + 80, gripY));
      assertEqual(frame().dataset.horizontalDragging, undefined, 'Thumb drag ends');
    } finally {
      thumb.setPointerCapture = setCapture;
      thumb.releasePointerCapture = releaseCapture;
      frame().dispatchEvent(pointer('pointerleave', hoverX, hoverY));
    }
    assertEqual(frame().dataset.horizontalTrackHover, undefined, 'Hover state clears for the next platform');
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
      await restOnEdge(cell);
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
    assertEqual(getComputedStyle(firstPreviewCell, '::after').backgroundColor, 'color(srgb 0 0.521569 0.901961 / 0.1)', 'Preview uses the 10% info selection fill');
    assertEqual(getComputedStyle(firstSourceCell, '::after').backgroundColor, getComputedStyle(firstPreviewCell, '::after').backgroundColor, 'Row/column selection and preview share the same fill');
    assertEqual(getComputedStyle(preview, '::before').borderRadius, '5px', 'Drag preview grip matches the 5px corner radius');
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
    assertEqual(getComputedStyle(selectedHandle, '::after').backgroundColor, 'rgb(0, 133, 230)', 'Selected handle uses the info fill, not the brand accent');
    assertEqual(getComputedStyle(selectedHandle, '::after').borderRadius, '5px', 'Selected grip uses a 5px corner radius');
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
