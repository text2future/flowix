# Markdown tables

This directory owns document tables, not multidimensional tables or Agent message tables.

## Responsibilities

- `table-fixed-widths.ts`: initialize/persist integer CSS pixel widths in cell `colwidth` arrays. Reuse existing Markdown metadata/HTML serialization; do not add a second source of column widths. Completed immutable table nodes are cached. Read-only rendering never writes widths. A newly inserted nested table waits for its current local DOM before measuring; append transactions must not resolve new document positions against stale DOM.
- `table-breakout.ts`: measure the document pane and prose origin. Update view-only CSS variables; never change column widths or document content.
- `table-plugin.ts`: the table NodeView owns the overlay scrollbar and its lifecycle. DOM structure is frame → scroller (`.tableWrapper`) → positioned rail → table + edge controls. Tbody remains ProseMirror's contentDOM.
- `table-edge-insert-plugin.ts`: own the edge controls and use rail-local CSS offsets, not viewport coordinates. Determine logical edges with TableMap so rowspan/colspan work. Ignore tables belonging to nested editors/other NodeViews. Cancel queued hover work on scrolling.
- `table-reorder-commands.ts`: model-only ordering, row/column selection endpoints and one undoable transaction. Widths/content/styles follow cells, row roles follow rows, header modes remain positional, and comparison-column identity follows its content. Merged/malformed tables are excluded. Comparison-column resolution is shared with decorations through `table-presentation.ts`.
- `table-reorder.ts`: pointer ownership, hover/selected handles, drop markers and edge scrolling. Selected handles follow `CellSelection`; text selection clears them. Sorting clears resize hover and captures pointer movement before the resize plugin. Escape, blur, content/selection changes and teardown release drag state. No document state is stored in DOM attributes.
- `table-reorder-preview.ts`: inert body portal, one content/style snapshot per drag, document-surface theme inheritance and axis-specific pointer anchoring (row left-center, column top-center). Hiding releases the snapshot, destroying removes the portal. No selected/preview outline; both use the same selected-cell fill.
- `editor-table-reorder.css`: all sorting chrome, body-portal styling and shared grip geometry. Rail layout remains in `editor-table-layout.css`; JS reads actual handle dimensions instead of duplicating CSS sizes.
- `table-resize-indicator.ts`: render one continuous rail-local resize-hover line across the table height. The upstream resize plugin retains hit testing and width updates; its per-cell widgets stay hidden. Observe table/cell geometry during resizing, and hide the overlay for read-only/sorting states.
- `table-text-selection.ts`: triple click selects paragraph text before the upstream whole-cell handler. Explicit rectangular CellSelection/dragging remain available. Cell highlight decorations live separately in `table-editing-cell.ts`.
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
3. Horizontal gestures scroll the table; vertical gestures chain to the editor. The thumb appears on scrolling/dragging, fades after 700ms plus the platform opacity transition, and has no idle hover reveal.
4. There is no table bottom margin. The rail reserves 14px above/left for drag grips (top-level breakout keeps its existing leading inset), 24px on the right and 22px below for edge controls (4px gap + 16px button + clearance). The scrollbar starts 6px below the final table border. Row insertion and scrollbar thumb share this space; scrolling hides controls and visible row controls suppress the thumb.
5. Collapsed fine-line borders must use opaque foreground/background blends. Alpha colors can be composited twice on WebKit's shared edges, making internal lines darker than the outside. Explicit user borders must still override templates.

## Regression checks

```sh
npx vitest run app/flowix-web/features/editor/extensions/table app/flowix-web/shared/ui/overlay-scrollbar-dom.test.ts app/flowix-web/styles/editor-table-presentation.test.ts
npm run test:editor-tables:browser
```

The browser check uses the real editor and production styles in headless Chrome, including both platform styles, geometry, edge insertion, scrollbar state/gap, paragraph triple click, opaque fine-line theme borders, sorting/undo, preview typography/background/anchoring, snapshot cleanup, and selected-handle persistence. It is also part of `npm run smoke`, adds no browser automation dependency, and accepts `CHROME_BIN`. Unlike the unit suite, it runs real layout/ResizeObserver/rAF. After changing browser event handling, additionally verify trusted wheel/drag events in a browser; synthetic wheel events have no native scrolling default action. Check WebKit when changing collapsed-border rendering for the macOS desktop app.
