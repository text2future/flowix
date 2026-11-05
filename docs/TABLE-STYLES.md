# Table templates and cell borders

Flowix's note editor offers nine designed table styles alongside the existing
default grid. Templates and formatting controls use the existing editor menus.

## Insert and format a table

- Open the toolbar's table menu, or type `/` and choose **Table** to open the
  template submenu. Enter or Right opens the submenu; Escape or Left returns
  without deleting the slash query. Confirming a template inserts the table.
- Search by a template name or its keywords to narrow the submenu choices.
- Default grid, Gray stripes, Business blue, and Comparison insert empty 3 × 3
  grids. The remaining six styles appear below a separator and include headings
  and, where appropriate, financial line-item labels. Data cells are empty;
  templates do not invent financial or research results.
- Select a cell and use the floating menu to change the table style, row role
  (body, group, subtotal, total), or column role (default, label, note, amount).
- Switching to a content template fills an empty table with that template,
  replacing its grid structure and placing the cursor in the first blank cell.
  Only cells containing empty paragraphs count as blank; non-text content also
  prevents replacement. Once a table has content (including template labels),
  switching styles preserves its content, row/column roles, and manual borders.
  Switching between blank styles preserves the existing grid structure.
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

Ordinary Markdown tables use the `flowix:table` metadata comment for table style,
row roles, column roles, and border overrides. Column roles are written in one of
two encodings:

- `columnRoles`: one role per column, used whenever every cell in a column agrees.
  This is the normal case and costs a few dozen bytes per table.
- `cells`: the earlier dense per-cell matrix, still written for grids whose rows
  disagree (or that mix spanning cells).

Border overrides are sparse. `borderList` records only `[row, column, top, bottom]`
for the cells that differ from the template, so a 30 × 6 table with one manual
rule adds one entry instead of a matrix of 180 nulls. Both dense forms
(`cells`/`borders`) produced by earlier builds are still read, and are rewritten in
the compact form on the next save.

Tables requiring HTML (such as merged cells) use the corresponding `data-flowix-*`
attributes and keep their per-cell values there. Default border settings add no
metadata. Existing tables continue to use the original default presentation unless
a style is selected.

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
