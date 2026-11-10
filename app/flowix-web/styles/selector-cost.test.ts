import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `:has()` relative selectors are evaluated per candidate element. A
 * `nth-child(An+B of S)` inside one makes WebKit rescan siblings for every
 * element: a 100 KB note with 103 code blocks spent 32–39 s inside
 * `Editor.mount()` with two such rules, and mounted in 0.2 s once they were
 * rewritten against a class (see
 * `features/editor/extensions/editor-first-block-mark.ts`).
 *
 * Chromium is not affected, so nothing else in the toolchain catches this.
 */
const STYLES_ROOT = join(__dirname);

function collectCssFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) return collectCssFiles(full);
    return entry.endsWith('.css') ? [full] : [];
  });
}

/** Balanced `(...)` slice starting at the `(` that precedes `start`. */
function parenContent(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, index);
    }
  }
  return source.slice(openParenIndex + 1);
}

/** Comments document the anti-pattern they forbid; only declarations count. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `:has(...)` body in a stylesheet. */
function hasBodies(css: string): string[] {
  const bodies: string[] = [];
  let cursor = 0;
  for (;;) {
    const found = css.indexOf(':has(', cursor);
    if (found === -1) return bodies;
    bodies.push(parenContent(css, found + ':has'.length));
    cursor = found + ':has('.length;
  }
}

describe('stylesheet selector cost', () => {
  it('never nests an `of S` nth-child inside :has()', () => {
    const offenders: string[] = [];
    for (const file of collectCssFiles(STYLES_ROOT)) {
      const css = stripComments(readFileSync(file, 'utf8'));
      if (!css.includes(':has(')) continue;
      for (const body of hasBodies(css)) {
        if (!/nth-(?:last-)?child\([^()]*\bof\b/.test(body)) continue;
        offenders.push(`${file.slice(STYLES_ROOT.length + 1)} → :has(${body.slice(0, 120)})`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
