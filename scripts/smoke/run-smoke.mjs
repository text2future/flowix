#!/usr/bin/env node
// 启动冒烟：把真实模块图打包进一个探针页，在 headless Chrome 里跑断言。
//
// 为什么不引 Playwright：与 scripts/check-agent-style-boundaries.mjs 同一套手法
// （esbuild 打包 → Chrome --dump-dom → 解析 JSON），零新增依赖、CI 里只要一个
// chromium 二进制。三个 case 覆盖的是"打包后能不能跑"，不是业务细节。
//
// 用法：
//   node scripts/smoke/run-smoke.mjs                # 全部
//   node scripts/smoke/run-smoke.mjs boot           # 单个
//   CHROME_BIN=/path/to/chrome node scripts/smoke/run-smoke.mjs

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { runRenderedPage } from './chrome-page.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(root, 'app/flowix-web');

const CASES = [
  { name: 'boot', entry: 'scripts/smoke/fixtures/boot.js', budgetMs: 20_000 },
  { name: 'save-pipeline', entry: 'scripts/smoke/fixtures/save-pipeline.js', budgetMs: 20_000 },
  { name: 'agent-markdown', entry: 'scripts/smoke/fixtures/agent-markdown.js', budgetMs: 20_000 },
  { name: 'editor-tables', entry: 'scripts/smoke/fixtures/editor-tables.js', budgetMs: 20_000, renderFrames: true,
    styles: ['editor.css', 'editor-table-presentation.css', 'overlay-scrollbar.css', 'editor-table-layout.css', 'editor-table-reorder.css'] },
];

const chrome = process.env.CHROME_BIN ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(existsSync);

if (!chrome) {
  console.error('未找到 Chrome/Chromium。设置 CHROME_BIN 后重试。');
  process.exit(2);
}

const only = process.argv[2];
const selected = only ? CASES.filter((entry) => entry.name === only) : CASES;
if (selected.length === 0) {
  console.error(`未知 case: ${only}（可选：${CASES.map((entry) => entry.name).join(', ')}）`);
  process.exit(2);
}

const alias = {
  '@': web,
  '@app': join(web, 'app'),
  '@features': join(web, 'features'),
  '@platform': join(web, 'platform'),
  '@shared': join(web, 'shared'),
  '@flowix-target-entry': join(web, 'entrypoints/desktop.tsx'),
};

const failures = [];

for (const testCase of selected) {
  const folder = await mkdtemp(join(tmpdir(), `flowix-smoke-${testCase.name}-`));
  try {
    const bundle = join(folder, 'case.js');
    await build({
      absWorkingDir: root,
      entryPoints: [testCase.entry],
      outfile: bundle,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome120',
      alias,
      loader: {
        '.css': 'empty',
        '.woff': 'empty',
        '.woff2': 'empty',
        '.ttf': 'empty',
        '.png': 'empty',
        '.jpg': 'empty',
        '.jpeg': 'empty',
        '.gif': 'empty',
        '.webp': 'empty',
        '.svg': 'empty',
        '.wasm': 'empty',
      },
      define: {
        'import.meta.env.DEV': 'true',
        'import.meta.env.PROD': 'false',
        'import.meta.env.MODE': '"development"',
        'process.env.NODE_ENV': '"development"',
        // Vite 专属 API：属性图标 / 笔记本图标 / 模板按目录收资源都靠它。
        // esbuild 不认识，替换成探针页里的桩（返回空表），否则整条 shell 图直接加载失败。
        'import.meta.glob': '__flowixViteGlob',
      },
      logLevel: 'error',
    });

    const styles = (await Promise.all((testCase.styles ?? []).map(name => readFile(join(web, 'styles', name), 'utf8')))).join('\n');
    const html = join(folder, 'index.html');
    await writeFile(
      html,
      `<!doctype html><meta charset="utf-8"><title>flowix smoke ${testCase.name}</title>
<style>html,body{margin:0;height:100%}#root,.app-shell{min-height:1px}</style>
<style>${styles}</style>
<script>globalThis.__flowixViteGlob = () => ({});</script>
<div id="root"></div>
<pre id="smoke-result">pending</pre>
<script type="module" src="./case.js"></script>`,
    );

    const stdout = testCase.renderFrames
      ? await runRenderedPage(chrome, pathToFileURL(html).href, folder, testCase.budgetMs)
      : (await promisify(execFile)(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--allow-file-access-from-files',
        '--disable-dev-shm-usage',
        `--user-data-dir=${join(folder, 'chrome-profile')}`,
        `--virtual-time-budget=${testCase.budgetMs}`,
        '--dump-dom',
        pathToFileURL(html).href,
      ],
      { timeout: testCase.budgetMs + 15_000, maxBuffer: 16 * 1024 * 1024 },
    )).stdout;

    const raw = stdout.match(/<pre id="smoke-result">([\s\S]*?)<\/pre>/)?.[1] ?? '';
    const text = raw
      .replaceAll('&gt;', '>')
      .replaceAll('&lt;', '<')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&');

    if (text.trim() === 'pending' || text.trim() === '') {
      failures.push(`${testCase.name}: 探针没有回写结果（脚本未执行或抛错在挂载前）`);
      console.error(`✗ ${testCase.name}: 无结果`);
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      failures.push(`${testCase.name}: 结果不是合法 JSON`);
      console.error(`✗ ${testCase.name}: 结果解析失败\n${text.slice(0, 400)}`);
      continue;
    }

    if (process.env.SMOKE_DEBUG) console.log(JSON.stringify(payload, null, 2));
    if (payload.ok) {
      console.log(`✓ ${testCase.name}（${payload.checks.length} 项断言 / ${payload.elapsedMs}ms）`);
    } else {
      failures.push(`${testCase.name}: ${payload.failed} 项失败`);
      console.error(`✗ ${testCase.name}`);
      for (const entry of payload.checks) {
        if (!entry.ok) console.error(`    - ${entry.name}: ${entry.error}`);
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (failures.length > 0) {
  console.error(`\n❌ 冒烟失败 ${failures.length} 项\n`);
  process.exit(1);
}

console.log(`\n✓ 冒烟全部通过（${selected.length} 个 case）`);
