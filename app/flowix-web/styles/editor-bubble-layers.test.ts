import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve('app/flowix-web/styles', name), 'utf8');
const tokensCss = read('floating-tokens.css');
const bubbleCss = read('editor-bubble-menus.css');
const linkCss = read('editor-link-tooltip.css');

/** `:root` 上声明的层级 token -> 数值。 */
function layerTokens(css = tokensCss): Map<string, number> {
  const tokens = new Map<string, number>();
  parse(css).walkDecls(/^--layer-/, (declaration) => {
    const value = Number(declaration.value.trim());
    if (Number.isFinite(value)) tokens.set(declaration.prop, value);
  });
  return tokens;
}

/** 某个选择器命中的 z-index 声明值。 */
function zIndexFor(css: string, selector: string): string | null {
  let value: string | null = null;
  parse(css).walkRules((rule) => {
    if (!rule.selectors.some(entry => entry.trim() === selector)) return;
    rule.walkDecls('z-index', (declaration) => {
      value = declaration.value.trim();
    });
  });
  return value;
}

describe('editor floating layers', () => {
  it('stacks table bubble below the link hover bubble, and both below the selection bubble', () => {
    const tokens = layerTokens();
    const table = tokens.get('--layer-editor-table-overlay');
    const link = tokens.get('--layer-editor-link-tooltip');
    const overlay = tokens.get('--layer-editor-overlay');

    expect(table).toBeTypeOf('number');
    expect(link).toBeTypeOf('number');
    expect(overlay).toBeTypeOf('number');
    // 链接 hover 气泡默认落在链接正上方, 表格气泡就压在表头上沿同一位置;
    // 表格气泡必须更低, 否则表头里的链接气泡被整条盖住。
    expect(table!).toBeLessThan(link!);
    expect(link!).toBeLessThan(overlay!);
    // 仍要高过文档通知, 否则表格气泡会被贴边通知压住。
    expect(table!).toBeGreaterThan(tokens.get('--layer-document-notice')!);
  });

  it('gives the table bubble panel its own layer instead of the shared selection layer', () => {
    const value = zIndexFor(bubbleCss, '.table-bubble-menu-panel.selection-bubble-menu');
    expect(value).toBe('var(--layer-editor-table-overlay)');
    // 复合选择器 (两个类) 的权重高于共享声明组的单类, 因此不依赖
    // index.css 里 editor-bubble-menus 与 editor-table-presentation 的先后。
    expect(zIndexFor(bubbleCss, '.selection-bubble-menu')).toBe('var(--layer-editor-overlay)');
  });

  it('keeps the link hover bubble on its own layer', () => {
    expect(zIndexFor(linkCss, '.editor-link-hover-tooltip')).toBe('var(--layer-editor-link-tooltip)');
    // 链接输入态是可交互面, 与选区气泡同档, 高于表格气泡。
    expect(zIndexFor(linkCss, '.editor-link-inline-editor')).toBe('var(--layer-editor-overlay)');
  });
});
