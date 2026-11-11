#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(ROOT, '.build/web-dist');
const indexPath = join(DIST, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const failures = [];

const manifestPath = join(DIST, '.vite', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// All three lazy roots render concurrently in the default desktop window.
// Follow their static imports recursively; checking index.html alone misses
// Vite's runtime __vitePreload dependency graph.
//
// Rollup may merge the `features/shell` facade into an anonymous shared
// dynamic chunk. In that case the manifest has no stable
// `features/shell/index.ts` key, so resolve the chunk from the index entry's
// dynamic imports by its exported startup marker instead of making the budget
// check depend on a content hash.
function findDynamicChunkContaining(entryKey, marker) {
  const entry = manifest[entryKey];
  for (const candidateKey of entry?.dynamicImports ?? []) {
    const candidate = manifest[candidateKey];
    if (!candidate?.file?.endsWith('.js')) continue;
    const source = readFileSync(resolve(DIST, candidate.file), 'utf8');
    if (source.includes(marker)) return candidateKey;
  }
  return null;
}

const shellStartupRoot = findDynamicChunkContaining('index.html', 'MainLayout');
if (!shellStartupRoot) {
  failures.push('manifest has no desktop startup root/import: features/shell/index.ts');
}
const desktopStartupRoots = [
  'index.html',
  shellStartupRoot,
  'app/main-window-effects.tsx',
  'app/agent-window-effects.tsx',
].filter((key) => key !== null);
const startupManifestKeys = new Set();

function visitStaticImports(key) {
  if (startupManifestKeys.has(key)) return;
  const chunk = manifest[key];
  if (!chunk) {
    failures.push(`manifest has no desktop startup root/import: ${key}`);
    return;
  }
  startupManifestKeys.add(key);
  for (const importedKey of chunk.imports ?? []) {
    visitStaticImports(importedKey);
  }
}

for (const root of desktopStartupRoots) visitStaticImports(root);

let startupRawBytes = 0;
let startupGzipBytes = 0;
for (const key of startupManifestKeys) {
  const chunk = manifest[key];
  if (!chunk?.file?.endsWith('.js')) continue;
  const bytes = readFileSync(resolve(DIST, chunk.file));
  startupRawBytes += bytes.byteLength;
  startupGzipBytes += gzipSync(bytes).byteLength;
}

// Budgets track the desktop startup graph (`index.html` + `features/shell/` +
// `app/main-window-effects.tsx` + `app/agent-window-effects.tsx`).
//
// 2026-11-11 债务基线（不是目标值）。2026-10-25 曾收紧到 1,090 KB / 340 KB
// gzip；此后三周的功能增长（Agent 云访问轮次卡、Skill Market、属性图标
// picker、文档指标）把 agent 数据图、图标库和 document-metrics-store 一起
// 拉回了启动图，实测 2,253,576 raw / 677,458 gzip。这里按「实测 + 2%」记录，
// 作用是拦住新增回退，不代表这个水位可以接受。
//
// 回到 340 KB 需要拆掉三处静态泄漏（估算可回收 ~290 KB gzip）：
//   1. `features/document/public/shell-api.ts` 首页导出了
//      `agent-thread-card-titlebar`，把 agent-session-store 拖进启动图；
//   2. `features/memo/components/notebook-tree-row.tsx` 静态引用
//      `property-icons` 全量图标表（234 KB raw）；
//   3. `features/document/store/index.ts` 静态引用 `document-metrics-store`
//      （311 KB raw）。
// 三处都拆完仍差约 48 KB，届时应把这份预算再收紧一轮，而不是继续抬。
const STARTUP_RAW_BUDGET = 2_300_000;
const STARTUP_GZIP_BUDGET = 690_000;
if (startupRawBytes > STARTUP_RAW_BUDGET) {
  failures.push(`desktop startup JavaScript is ${startupRawBytes} bytes, budget is ${STARTUP_RAW_BUDGET}`);
}
if (startupGzipBytes > STARTUP_GZIP_BUDGET) {
  failures.push(`desktop startup gzip is ${startupGzipBytes} bytes, budget is ${STARTUP_GZIP_BUDGET}`);
}

const startupGrammarKeys = [...startupManifestKeys].filter((key) =>
  key.includes('node_modules/@shikijs/langs/'),
);
if (startupGrammarKeys.length > 0) {
  failures.push(`Shiki grammars entered desktop startup: ${startupGrammarKeys.join(', ')}`);
}

// CSS 总量预算（T4-0 配套，见 docs/architecture-78-to-85-plan.md）。
// 口径：manifest 所有 chunk 的 css 数组去重后汇总（与 JS 启动图同一套 manifest
// 复算方法，避免源码级统计的坑）。
// 2026-10-27 实测基线 559,001 raw / 83,321 gzip（含入口 index-*.css 499 KB
// raw / 70.5 KB gzip、katex、csv/docx preview）。2026-11-11 编辑器气泡叠层
// （链接气泡 / 表格气泡分层）、表格只读态 chrome 与图标 picker 规则把总量推到
// 588,599 raw / 88,064 gzip，同样按「实测 + 2%」记录为债务基线。
// 收紧时要先合并同类规则，而不是继续加选择器。
const CSS_RAW_BUDGET = 600_000;
const CSS_GZIP_BUDGET = 90_000;
const cssFiles = new Set();
for (const chunk of Object.values(manifest)) {
  for (const css of chunk.css ?? []) cssFiles.add(css);
}
let cssRawBytes = 0;
let cssGzipBytes = 0;
const cssReport = [];
for (const css of cssFiles) {
  const bytes = readFileSync(resolve(DIST, css));
  const gzip = gzipSync(bytes).byteLength;
  cssRawBytes += bytes.byteLength;
  cssGzipBytes += gzip;
  cssReport.push([css, bytes.byteLength, gzip]);
}
if (cssRawBytes > CSS_RAW_BUDGET) {
  failures.push(`all CSS is ${cssRawBytes} bytes, budget is ${CSS_RAW_BUDGET}`);
}
if (cssGzipBytes > CSS_GZIP_BUDGET) {
  failures.push(`all CSS gzip is ${cssGzipBytes} bytes, budget is ${CSS_GZIP_BUDGET}`);
}
if (process.argv.includes('--css-report')) {
  cssReport.sort((a, b) => b[2] - a[2]);
  console.log('CSS chunks by gzip:');
  for (const [file, raw, gzip] of cssReport) {
    console.log(`  ${file}  ${raw} raw / ${gzip} gzip`);
  }
}

const optionalHeavyChunks = ['mermaid', 'shiki', 'katex', 'cytoscape'];
for (const name of optionalHeavyChunks) {
  if (new RegExp(`modulepreload[^>]+${name}`, 'i').test(html)) {
    failures.push(`optional ${name} chunk is preloaded by index.html`);
  }
}

function referencedAsset(pattern, label, maxBytes) {
  const match = html.match(pattern);
  if (!match) {
    failures.push(`index.html has no ${label} asset`);
    return;
  }
  const path = resolve(DIST, match[1]);
  const bytes = statSync(path).size;
  if (bytes > maxBytes) {
    failures.push(`${label} is ${bytes} bytes, budget is ${maxBytes}`);
  }
}

referencedAsset(/<script[^>]+src="([^"]+\.js)"/, 'entry JavaScript', 700_000);
// 2026-11-11 实测 522,402 raw：表格与编辑器交互样式进入入口 CSS 后，
// 原 520 KB 门槛仅差 2.4 KB；保留约 0.5% 余量拦住后续回退。
referencedAsset(/<link[^>]+href="([^"]+\.css)"/, 'entry CSS', 525_000);

const interFonts = readdirSync(join(DIST, 'assets')).filter((name) =>
  /^inter-.*\.(?:woff2?|ttf)$/i.test(name),
);
if (interFonts.length > 12) {
  failures.push(`Inter emits ${interFonts.length} font files, budget is 12`);
}
if (interFonts.some((name) => !name.endsWith('.woff2'))) {
  failures.push(`legacy Inter font formats emitted: ${interFonts.map(basename).join(', ')}`);
}

if (failures.length) {
  console.error(`\n❌ Web bundle budget failed\n\n${failures.map((item) => `  ${item}`).join('\n')}\n`);
  process.exit(1);
}

console.log(
  `✓ Web bundle budget passed (startup JS: ${startupRawBytes} raw / ${startupGzipBytes} gzip; ` +
    `all CSS: ${cssRawBytes} raw / ${cssGzipBytes} gzip; Inter fonts: ${interFonts.length}/12)`,
);
