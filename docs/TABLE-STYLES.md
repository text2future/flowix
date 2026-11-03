# Table templates and cell borders

Flowix's note editor offers nine designed table styles alongside the existing
default grid. Templates and formatting controls use the existing editor menus.

## Insert and format a table

- Open the toolbar's table menu, or type `/` and choose **Table** to open the
  template submenu. Enter or Right opens the submenu; Escape or Left returns
  without deleting the slash query. Confirming a template inserts the table.
- Search by a template name or its keywords to narrow the submenu choices.
- Templates contain headings and, where appropriate, financial line-item labels.
  Data cells are empty; templates do not invent financial or research results.
- Select a cell and use the floating menu to change the table style, row role
  (body, group, subtotal, total), or column role (default, label, note, amount).
- Switching styles preserves content, row/column roles, and manual cell borders.
  Existing row/column insertion and deletion controls remain available.

| Style | Initial presentation |
| --- | --- |
| Default grid | Existing 3 × 3 empty table. |
| Business blue | Blue header, horizontal rules, and a light-blue total row. |
| Gray stripes | Alternating gray rows without vertical rules. |
| Comparison | Emphasizes the logical third column, including merged-cell coverage. |
| Financial brief | Indented items, subtotal rules, and double rules for totals. |
| Three-line | Top, header separator, and bottom rules without vertical grid lines. |
| HK financial | Item, note, and two amount columns; right-aligned amounts and subtotal/total rules. |
| Grouped rules | Three merged section headings with empty research data rows. |
| Minimal rules | Spacious literature table with subtle horizontal rules. |
| Compact literature | Compact grid with a shaded first column. |

The comparison style always emphasizes the logical third column. Its view-only
markers are recalculated for merged cells and are not saved into the note.
Financial templates do not calculate values, add accounting parentheses, or infer
row roles from text such as “Total”.

## Edit horizontal borders

The floating menu provides **Top border** and **Bottom border** controls for the
current cell or a multi-cell selection: single, double, none, or template default.
Manual settings override the template's rules and participate in undo/redo.

Adjacent cells share horizontal edges, so edits synchronize both sides. A merged
cell can only have a complete edge; when an edit must extend to neighboring cells,
the menu shows a notice. Newly inserted cells use default borders; existing cells
retain their settings. On the outer edge of a three-line table, a single border
retains the template's thicker solid rule.

## Persistence and compatibility

Ordinary Markdown tables use the existing `flowix:table` metadata mechanism for
table style, row roles, cell column roles, and sparse versioned border settings.
Tables requiring HTML (such as merged cells) use corresponding `data-flowix-*`
attributes. Default border settings add no metadata. Existing tables continue to
use the original default presentation unless a style is selected.

This feature changes in-app presentation and note persistence. It does not add
download or document-export controls, or modify the existing export adapters.

## Verification

Focused tests cover template insertion, keyboard submenu navigation, style
switching, selection/merged-edge border edits, undo/redo, Markdown and HTML
round-trips, worker parsing, and comparison-column decorations.

```sh
npx vitest run app/flowix-web/features/editor/extensions/table app/flowix-web/features/editor/markdown-parser-regressions.test.ts app/flowix-web/features/editor/markdown-worker-dom.test.ts
npx tsc --noEmit
npm run check:layers
npm run check:arch
```

For manual verification, use a disposable notebook: insert templates through
both menus, edit data, switch styles, change cell borders, undo/redo, then save
and reopen the note. Check merged group headings and manual borders after
restarting the application. Verify light and dark themes with the existing theme
switcher. Production bundle budgets and repository-wide checks remain separate
release gates.
