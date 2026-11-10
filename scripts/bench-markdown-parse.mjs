import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Markdown parse benchmark.
 *
 * Each measurement runs in its own process so JIT state and GC from a previous
 * shape/size cannot pollute the next one. Reported numbers are the median of N
 * runs after a warm-up run.
 *
 * Usage:
 *   npm run bench:markdown
 *   npm run bench:markdown -- --sizes=50,100,200,400 --reps=7 --shape=mixed
 *
 * `--shape` picks the document body. `paragraph` is the worst case for
 * per-block tokenizer scans (many blocks, no lists); `list` is the shape that
 * used to go quadratic when list tokenizers split the whole remaining document
 * per block (see `features/editor/markdown-tokenizer-source.ts`); `mixed`
 * alternates both.
 *
 * `--assert-linear` turns the run into a gate: every shape must stay inside
 * `sizeGrowth ^ 1.25`, so a quadratic regression (4x the document costing 10-20x
 * the time) fails instead of printing a table nobody reads. Run it outside the
 * test workers, e.g. `npm run check:markdown-parse-perf`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const frontendRoot = join(repoRoot, 'app/flowix-web');
const workDir = join(repoRoot, '.build/bench-markdown-parse');

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = ''] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);
const sizes = (args.get('sizes') ?? '50,100,200,400').split(',').map(Number).filter(Number.isFinite);
const reps = Number(args.get('reps') ?? '5');
const shapes = (args.get('shape') ?? 'paragraph,list,mixed').split(',');
const assertLinear = args.has('assert-linear');
const MAX_GROWTH_EXPONENT = 1.25;

if (sizes.length === 0 || !Number.isFinite(reps) || reps < 1) {
  console.error('Invalid arguments. Example: --sizes=50,100,200,400 --reps=5 --shape=mixed');
  process.exit(1);
}

const entry = `
import { MarkdownManager } from '@tiptap/markdown';
import { createMarkdownEditorExtensions } from '@features/editor/markdown-editor-extensions';

const manager = new MarkdownManager({
  extensions: createMarkdownEditorExtensions({
    getOwnerPath: () => undefined,
    getAttachmentNotebookId: () => undefined,
    workspaceHost: 'column-1',
    getPlaceholder: () => '',
  }),
});

const sentence = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.';

function paragraphBlock(index) {
  return (index % 5 === 0 ? '## Heading ' + index + '\\n\\n' : '') + sentence + ' ' + sentence;
}

function listBlock(index) {
  return index % 2 === 0
    ? '- [ ] task ' + index + '\\n- [x] task ' + (index + 1)
    : '1. step ' + index + '\\n2. step ' + (index + 1);
}

function buildDocument(shape, bytes) {
  if (shape === 'longlist') {
    const lines = [];
    let length = 0;
    let index = 0;
    while (length < bytes) {
      const line = '- item ' + index + ' with a little trailing description text';
      lines.push(line);
      length += line.length + 1;
      index += 1;
    }
    return lines.join('\\n');
  }
  const blocks = [];
  let length = 0;
  let index = 0;
  while (length < bytes) {
    const block = shape === 'list' || (shape === 'mixed' && index % 2 === 1)
      ? listBlock(index)
      : paragraphBlock(index);
    blocks.push(block);
    length += block.length + 2;
    index += 1;
  }
  return blocks.join('\\n\\n');
}

const [shape, bytes, runs] = process.argv.slice(2);
const markdown = buildDocument(shape, Number(bytes));
manager.instance.lexer(markdown.slice(0, 2000));

const samples = [];
for (let i = 0; i < Number(runs); i += 1) {
  const started = performance.now();
  manager.instance.lexer(markdown);
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({
  median: samples[Math.floor(samples.length / 2)],
  blocks: markdown.split('\\n\\n').length,
}));
`;

const entryPath = join(workDir, 'entry.ts');
const bundlePath = join(workDir, 'entry.mjs');
mkdirSync(workDir, { recursive: true });
writeFileSync(entryPath, entry, 'utf8');

await build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundlePath,
  alias: {
    '@features': join(frontendRoot, 'features'),
    '@shared': join(frontendRoot, 'shared'),
    '@platform': join(frontendRoot, 'platform'),
    '@': frontendRoot,
  },
  loader: { '.css': 'empty', '.svg': 'text', '.jpg': 'empty', '.png': 'empty' },
  // Editor extensions pull CommonJS dependencies (yaml) that call `require`
  // for Node built-ins; give the ESM bundle a real `require`.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);const __flowixEmptyGlob = () => ({});globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 };",
  },
  // Vite-only asset glob; the bench only needs the Markdown specs.
  define: { 'import.meta.glob': '__flowixEmptyGlob' },
  logLevel: 'silent',
});

const rows = [];
for (const sizeKb of sizes) {
  const row = { sizeKb };
  for (const shape of shapes) {
    const output = execFileSync(
      process.execPath,
      ['--no-warnings', bundlePath, shape, String(Math.round(sizeKb * 1000)), String(reps)],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1));
    row[shape] = result.median;
    row.blocks = result.blocks;
  }
  rows.push(row);
}

const failures = [];
if (assertLinear) {
  if (rows.length < 2) {
    failures.push('--assert-linear needs at least two --sizes');
  } else {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const sizeGrowth = last.sizeKb / first.sizeKb;
    const allowedGrowth = sizeGrowth ** MAX_GROWTH_EXPONENT;
    for (const shape of shapes) {
      const growth = last[shape] / Math.max(first[shape], 1);
      if (growth > allowedGrowth) {
        failures.push(
          `${shape}: ${sizeGrowth.toFixed(1)}x the document cost ${growth.toFixed(1)}x the time`
          + ` (${Math.round(first[shape])}ms -> ${Math.round(last[shape])}ms,`
          + ` allowed ${allowedGrowth.toFixed(1)}x)`,
        );
      }
    }
  }
}

const header = ['size', ...shapes.map((shape) => shape.padStart(11)), 'blocks'].join(' | ');
console.log(header);
console.log('-'.repeat(header.length));
for (const row of rows) {
  const cells = [String(row.sizeKb).padStart(6) + ' KB'];
  for (const shape of shapes) cells.push(String(Math.round(row[shape])).padStart(9) + ' ms');
  cells.push(String(row.blocks).padStart(6));
  console.log(cells.join(' | '));
}

if (assertLinear) {
  if (failures.length > 0) {
    console.error('\nFAIL: Markdown lexing is no longer near-linear in document length.');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('\nPASS: lexing stays near-linear in document length.');
}
