// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { THEME_IDS } from './palette';

const themeIds = THEME_IDS.filter((id) => id !== 'system');

function tokensFor(id: string): Map<string, string> {
  const css = readFileSync(resolve(process.cwd(), `app/flowix-web/styles/theme/${id}.css`), 'utf8');
  const root = postcss.parse(css);
  const tokens = new Map<string, string>();
  root.walkRules((rule) => {
    if (rule.selector !== (id === 'light' ? ':root' : `[data-theme="${id}"]`)) return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) {
        expect(tokens.has(decl.prop), `${id}: duplicate ${decl.prop}`).toBe(false);
        tokens.set(decl.prop, decl.value);
      }
    });
  });
  return tokens;
}

function contrastWithWhite(hex: string): number {
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return 1.05 / (luminance + 0.05);
}

describe('theme token contract', () => {
  it('defines the same nonempty set of tokens in every theme', () => {
    const expected = [...tokensFor('rock').keys()].sort();
    expect(expected.length).toBeGreaterThan(0);
    for (const id of themeIds) expect([...tokensFor(id).keys()].sort(), id).toEqual(expected);
  });

  it('keeps info button text readable in every theme', () => {
    for (const id of themeIds) {
      const tokens = tokensFor(id);
      expect(tokens.get('--info-foreground'), id).toBe('oklch(1 0 0)');
      expect(contrastWithWhite(tokens.get('--info') ?? ''), id).toBeGreaterThanOrEqual(4.5);
    }
  });
});
