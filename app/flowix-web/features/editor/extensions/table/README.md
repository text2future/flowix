# Markdown tables

This directory owns document tables, not multidimensional tables or Agent message tables.

## Responsibilities

- `table-fixed-widths.ts`: initialize/persist integer CSS pixel widths in cell `colwidth` arrays. Reuse existing Markdown metadata/HTML serialization; do not add a second source of column widths. Completed immutable table nodes are cached. Read-only rendering never writes widths. A newly inserted nested table waits for its current local DOM before measuring; append transactions must not resolve new document positions against stale DOM.
- `table-breakout.ts`: measure the document pane and prose origin. Update view-only CSS variables; never change column widths or document content.
- `table-plugin.ts`: the table NodeView owns the overlay scrollbar and its lifecycle. DOM structure is frame → scroller (`.tableWrapper`) → positioned rail → table + edge controls. Tbody remains ProseMirror's contentDOM.
- `table-edge-insert-plugin.ts`: own the edge controls and use rail-local CSS offsets, not viewport coordinates. Determine logical edges with TableMap so rowspan/colspan work. Render one h-6 square per axis past the far edge: the column button sits right of the last column aligned with the table top, the row button sits below the last row aligned with the table left. A transparent zone bridges each square back to the table edge (4px gap + 24px square): the full right gutter for the column and the full bottom gutter for the row. The row bridge sits below the horizontal scrollbar track/thumb in the stacking order, so the scrollbar keeps hit priority; hovering that band must not clear the row control (only a real scroll does). Ignore tables belonging to nested editors/other NodeViews. Cancel queued hover work on scrolling. Never hide controls from a plugin view update alone: `columnResizing` dispatches doc-free `setHandle` transactions while the pointer crosses the last column's 8px resize band, and other extensions may append a doc-changing transaction during the same gesture. On a document change, re-resolve from the last pointer target instead.
- `table-reorder-commands.ts`: model-only ordering, row/column selection endpoints and one undoable transaction. Widths/content/styles follow cells, row roles follow rows, header modes remain positional, and comparison-column identity follows its content. Merged/malformed tables are excluded. Comparison-column resolution is shared with decorations through `table-presentation.ts`.
- `table-reorder.ts`: pointer ownership, hover/selected handles, drop markers and edge scrolling. Independent pinned handles follow the first cell of a `CellSelection` or the caret cell, while hover handles remain available for other cells; selections outside the table clear the pinned handles. Sorting clears resize hover and captures pointer movement before the resize plugin. Escape, blur, selection changes and teardown release drag state. A plain mouseup without a drag leaves hover chrome alone (clicking into a cell must not blank it), and a content change re-resolves the cell the pointer still rests on instead of hiding the grips mid-edit. No document state is stored in DOM attributes.
- `table-axis-menu.tsx`: opens from a short grip click after selecting its row or column; actual drags never open it. The menu is anchored beside the grip, closes on outside interaction/scroll/selection change, and reuses the bubble's border, column alignment and background controls. Submenus open on hover and meet the trigger item, with a brief grace period when crossing into a portal. Single-row and single-column tables retain their handles for insertion and deletion.
- `table-reorder-preview.ts`: inert body portal, one content/style snapshot per drag, document-surface theme inheritance and axis-specific pointer anchoring (row left-center, column top-center). Hiding releases the snapshot, destroying removes the portal. The floating copy keeps the 10% selection fill because it has no outline to carry the state; the selection itself is framed, so selected cells and the preview deliberately no longer match.
- `editor-table-reorder.css`: all sorting chrome, body-portal styling and shared grip geometry. Rail layout remains in `editor-table-layout.css`; JS reads actual handle dimensions instead of duplicating CSS sizes. The quiet tick is 2px thick — the same as the selection frame — and is offset 1px inwards so it lands on the frame band, which runs `[edge, edge + 2]` from the table's outer edge; a centred tick would cover only its outer half and poke out of the table. It carries no halo (a spread shadow washed the border out around it, which is what made the line read as shifted) and gets its separation from a 2px background gap at either end, painted by clipping the fill to the content box so the rounded caps stay. The hover grip drops that padding and offset and centres its dot grid.
- `table-resize-indicator.ts`: render one continuous rail-local resize-hover line across the table height. The upstream resize plugin retains hit testing and width updates; its per-cell widgets stay hidden. The line is dwell-gated (`TABLE_RESIZE_HINT_DELAY_MS`, 300ms on one edge) so a fast sweep across the table does not flash a line on every column edge; the `col-resize` cursor stays immediate so dragging never waits, and an active drag shows the line at once. Observe table/cell geometry during resizing, and hide the overlay for read-only/sorting states.
- `table-text-selection.ts`: triple click selects paragraph text before the upstream whole-cell handler. Explicit rectangular CellSelection/dragging remain available. Cell highlight decorations live separately in `table-editing-cell.ts`.
- `table-selection-frame.ts`: geometry only for the selection outline. From a `CellSelection` it computes the rectangle through `TableMap.rectBetween` and writes `data-flowix-cell-frame` (`t b l r`) onto the cells whose edges land on the rectangle's outline, leaving interior cells unmarked. Painting and the caret-cell frame are CSS in `editor.css`; the sheet offsets the pseudo elements by `inset: -1px` so the frame covers each cell's own 1px border and neighbouring frames join into one block instead of showing a grey table edge between them. Nothing is painted inside the rectangle, so row/column fills and header tints stay readable while selected.
- `editor-table-layout.css`: own layout/scrolling, loaded after shared scrollbar CSS. Use the shared `--overlay-scrollbar-overscroll-x/y` and `--overlay-scrollbar-horizontal-end` variables rather than adding platform-specific selector overrides. The default grid, square table/cell corners and themes live together in `editor-table-presentation.css`; theme-specific corner resets are unnecessary.

## Formatting menu

`TABLE_STYLE_ROW_ROLES` in `table-presentation.ts` controls row-role discovery:
financial themes expose all row roles, grouped exposes body/group only, and
ordinary themes omit semantic row options. Every theme exposes row/column
column alignment. A separate circle color button after the style menu exposes
row and column background palettes. Hidden row roles are retained in saved
content and do not contribute a misleading mixed-format status to the menu.

Backgrounds store validated color identifiers only: `rowBackground` on row
nodes and `columnBackground` on cell nodes. Pipe-table metadata encodes row
colors plus sparse column-cell entries; HTML tables use data attributes.
`flowix-text-colors.ts` defines the shared color identifiers, and the
`--flowix-highlight-background-*` tokens in `editor.css` define the actual
fills for text highlighting, palettes and tables. Row fills win over column
fills; clearing a fill returns to the theme. New rows inherit uniform column
fills. Drag previews snapshot these computed fills without persisting colors.

## Layout invariants

1. Every initialized column is fixed. Resizing panes changes the viewport only. Inserting/deleting/resizing a column must not redistribute other widths.
2. Top-level tables initially align with prose, may extend into pane margins, and clip within the pane. Lists/quotes retain local scrolling. Printing removes breakout/padding/chrome.
3. Horizontal gestures scroll the table; vertical gestures chain to the editor. The thumb appears on scrolling, dragging, or hovering the scrollbar band (`data-horizontal-track-hover` from the shared controller), and stays hit-testable so it can be grabbed. It fades after 700ms plus the platform opacity transition once scrolling ends. Scrolling clears the edge insert controls, leaving the bottom gutter to the scrollbar.
4. There is no table bottom margin. The rail reserves 14px above/left for the row/column drag grips (top-level breakout keeps its existing leading inset) and 28px right/below for the square edge-insert controls (24px button + 4px gap). The horizontal thumb starts 6px below the final table border (28px bottom padding - 22px thumb offset = 6). The row insert bridge spans the full bottom gutter but is stacked below the scrollbar track/thumb (z-index 0 vs 1/2); the 24px square button stays above them (z-index 18) and remains clickable.
5. Collapsed fine-line borders must use opaque foreground/background blends. Alpha colors can be composited twice on WebKit's shared edges, making internal lines darker than the outside. Explicit user borders must still override templates.

## Regression checks

```sh
npx vitest run app/flowix-web/features/editor/extensions/table app/flowix-web/shared/ui/overlay-scrollbar-dom.test.ts app/flowix-web/styles/editor-table-presentation.test.ts
npm run test:editor-tables:browser
```

The browser check uses the real editor and production styles in headless Chrome, including both platform styles, geometry, edge insertion and crossing the column resize band, the full-width row bridge yielding to scrollbar hit-testing, scrollbar state/gap/hover-reveal/thumb-dragging, paragraph triple click, opaque fine-line theme borders, sorting/undo, preview typography/background/anchoring, snapshot cleanup, and selected-handle persistence. It is also part of `npm run smoke`, adds no browser automation dependency, and accepts `CHROME_BIN`. Unlike the unit suite, it runs real layout/ResizeObserver/rAF. After changing browser event handling, additionally verify trusted wheel/drag events in a browser; synthetic wheel events have no native scrolling default action. Check WebKit when changing collapsed-border rendering for the macOS desktop app.
