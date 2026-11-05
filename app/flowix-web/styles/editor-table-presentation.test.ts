import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { expect, it } from 'vitest';

const tableCss = readFileSync(resolve('app/flowix-web/styles/editor-table-presentation.css'), 'utf8');

/**
 * Selectors whose subject is a `table` element, ignoring `table-style` in names.
 *
 * `table` must be followed by something that ends a type selector and preceded
 * by something that starts one — either a combinator/`,`/`(` or the beginning
 * of the selector. Anchoring on the start matters: a bare `table { }` rule is
 * exactly the leak this guard exists to stop, and a lookbehind alone would
 * silently skip it.
 */
const TABLE_TYPE_SELECTOR = /(?:^|[\s>+~,(])table(?=[>+~:.[,\s)]|$)/;

function tableSelectors(css: string = tableCss): string[] {
  const selectors: string[] = [];
  parse(css).walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (TABLE_TYPE_SELECTOR.test(selector)) selectors.push(selector.trim());
    }
  });
  return selectors;
}

it('detects unscoped table rules, including a bare type selector', () => {
  // Self-check for the matcher above: every spelling that scopes a table rule
  // must be seen, and class names that merely contain "table" must not.
  const fixture = 'table { color: red }\n.a > table { color: red }\n'
    + '.a :is(table, .b) { color: red }\n.table-style-menu .td { color: red }\n'
    + '.a .multidimensional-table { color: red }';
  expect(tableSelectors(fixture)).toEqual([
    'table',
    '.a > table',
    '.a :is(table, .b)',
  ]);
});

it('keeps every table selector out of the multidimensional table view', () => {
  const selectors = tableSelectors();
  // The guard is only meaningful if this still parses real rules.
  expect(selectors.length).toBeGreaterThan(20);

  const unscoped = selectors.filter(selector => !selector.includes(':not(.multidimensional-table)'));
  expect(unscoped).toEqual([]);
});

it('assigns theme variables only to tables that carry a style id', () => {
  const assignments: string[] = [];
  parse(tableCss).walkDecls(/^--flowix-table-/, (declaration) => {
    const selector = declaration.parent?.type === 'rule'
      ? (declaration.parent as { selector: string }).selector
      : '';
    if (selector) assignments.push(selector);
  });
  expect(assignments.length).toBeGreaterThan(0);

  const leaking = assignments.filter(selector => !selector.includes('[data-flowix-table-style'));
  expect(leaking).toEqual([]);
});

it('applies column roles to editor tables but never to the database view', () => {
  document.body.innerHTML = `
    <div class="markdown-editor">
      <div class="tiptap ProseMirror">
        <table id="editor-table" data-flowix-table-style="hk-financial">
          <tbody><tr>
            <td id="amount" data-flowix-column-role="amount"><p>1</p></td>
            <td id="note" data-flowix-column-role="note"><p>2</p></td>
          </tr></tbody>
        </table>
        <table id="database-table" class="multidimensional-table" data-flowix-table-style="hk-financial">
          <tbody><tr>
            <td id="database-amount" data-flowix-column-role="amount"><p>1</p></td>
          </tr></tbody>
        </table>
      </div>
    </div>
  `;

  const alignmentSelectors: string[] = [];
  parse(tableCss).walkRules((rule) => {
    let alignsRight = false;
    rule.walkDecls('text-align', (declaration) => {
      if (declaration.value === 'right') alignsRight = true;
    });
    if (alignsRight) alignmentSelectors.push(...rule.selectors);
  });
  expect(alignmentSelectors.length).toBeGreaterThan(0);

  const matched = [...document.body.querySelectorAll('[id]')]
    .filter(node => alignmentSelectors.some(selector => node.matches(selector)))
    .map(node => node.id);

  expect(matched).toEqual(['amount']);
});
