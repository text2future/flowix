#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import postcss from 'postcss';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const styles = join(root, 'app/flowix-web/styles');
const boundaryErrors = [];

const isKeyframeStep = rule => rule.parent?.type === 'atrule' && /keyframes/i.test(rule.parent.name);
// Comments in this tree routinely mention token names; only real declarations
// and real var() calls count.
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Require the exclusion on editor-owned rules; CSS files in the Agent tree
// own their classes directly. editor-host.css is the explicit NodeView bridge.
for (const name of await readdir(styles)) {
  if (!name.endsWith('.css')) continue;
  if (!/^editor.*\.css$/.test(name) && !['index.css', 'code-editor.css', 'multidimensional-table.css', 'popup-list.css'].includes(name)) continue;
  const css = postcss.parse(await readFile(join(styles, name), 'utf8'));
  css.walkRules(rule => {
    for (const selector of rule.selectors) {
      if (!/\.(?:markdown-editor|tiptap|ProseMirror)(?![\w-])/.test(selector)) continue;
      if (!/:where\(:not\([^)]*\.agent-conversation-surface,\s*\.agent-conversation-surface \*/.test(postcss.list.space(selector).at(-1))) boundaryErrors.push(`${name}: missing Agent boundary: ${selector}`);
    }
  });
}

// Tokens the composition root must own. Consuming a token from the composer
// path while declaring it on .agent-thread-card silently degrades to `auto`
// for width/height and to `none` for max-height when no card ancestor exists.
const SURFACE_ROOT_TOKENS = [
  '--agent-content-max-width',
  '--agent-content-inline-inset',
  '--atc-send-size',
  '--atc-bottom-pad',
  '--atc-composer-max-h',
];

// Custom properties written by TypeScript at runtime. Everything else used in
// the Agent tree must be declared by Agent CSS or by a theme file.
const JS_PROVIDED_VARS = new Map([
  ['--agent-icon-src', 'agent-icon.tsx / badge-chrome-controller.tsx'],
  ['--agent-icon-color', 'agent-icon.tsx'],
  ['--agent-message-font-family', 'agent-message-font-store.ts'],
  ['--agent-message-base-font-size', 'agent-message-font-store.ts'],
  ['--agent-message-size-scale', 'agent-message-font-store.ts'],
  ['--atc-fullscreen-top', 'fullscreen-layout-controller.ts'],
  ['--atc-fullscreen-left', 'fullscreen-layout-controller.ts'],
  ['--atc-fullscreen-width', 'fullscreen-layout-controller.ts'],
  ['--atc-fullscreen-height', 'fullscreen-layout-controller.ts'],
]);

const declaredInStyles = new Set();
const cssSources = [
  ...(await readdir(styles)).filter(name => name.endsWith('.css')).map(name => join(styles, name)),
  ...(await readdir(join(styles, 'theme'))).filter(name => name.endsWith('.css')).map(name => join(styles, 'theme', name)),
  ...(await readdir(join(styles, 'agent-conversation'))).filter(name => name.endsWith('.css')).map(name => join(styles, 'agent-conversation', name)),
  ...(await readdir(join(styles, 'agent-thread-card'))).filter(name => name.endsWith('.css')).map(name => join(styles, 'agent-thread-card', name)),
];
for (const file of cssSources) {
  for (const [, variable] of stripComments(await readFile(file, 'utf8')).matchAll(/(--[\w-]+)\s*:/g)) {
    declaredInStyles.add(variable);
  }
}

// Shared popup rules may include Agent selectors alongside editor selectors.
// Check only the Agent selectors and their declarations, since the other
// selectors intentionally belong to different UI areas.
postcss.parse(await readFile(join(styles, 'popup-list.css'), 'utf8')).walkRules(rule => {
  const agentSelectors = rule.selectors.filter(selector => /\.agent-[\w-]+/.test(selector));
  for (const selector of agentSelectors) {
    if (selector.includes('.markdown-editor')) boundaryErrors.push(`popup-list.css: Agent styling depends on its editor host: ${selector}`);
  }
  if (!agentSelectors.length) return;
  for (const [, variable] of stripComments(rule.toString()).matchAll(/var\(\s*(--(?:agent|atc)-[\w-]+)/g)) {
    if (!declaredInStyles.has(variable) && !JS_PROVIDED_VARS.has(variable)) {
      boundaryErrors.push(`popup-list.css: ${variable} is consumed but never declared (Agent CSS, theme or JS)`);
    }
  }
});

for (const folder of ['agent-conversation', 'agent-thread-card']) {
  for (const name of await readdir(join(styles, folder))) {
    if (!name.endsWith('.css') || name === 'editor-host.css') continue;
    const label = `${folder}/${name}`;
    const source = await readFile(join(styles, folder, name), 'utf8');
    const css = postcss.parse(source);
    css.walkRules(rule => {
      if (isKeyframeStep(rule)) return;
      for (const selector of rule.selectors) {
        if (selector.includes('.markdown-editor')) boundaryErrors.push(`${label}: Agent styling depends on its editor host`);
        // Portaled panels are appended to body and are exempt from the surface
        // prefix, but they still have to advertise whose UI they are.
        if (!selector.includes('.agent-')) boundaryErrors.push(`${label}: selector is not namespaced with agent-: ${selector}`);
      }
      if (rule.selector.trim() === '.agent-conversation-surface') {
        for (const token of SURFACE_ROOT_TOKENS) {
          if (!new RegExp(`${token}\\s*:`).test(rule.toString())) boundaryErrors.push(`${label}: surface root must declare ${token}`);
        }
      }
    });
    for (const [, variable] of stripComments(source).matchAll(/var\(\s*(--(?:agent|atc)-[\w-]+)/g)) {
      if (!declaredInStyles.has(variable) && !JS_PROVIDED_VARS.has(variable)) {
        boundaryErrors.push(`${label}: ${variable} is consumed but never declared (Agent CSS, theme or JS)`);
      }
    }
  }
}

// The surface root contract is defined in surface.css only; a second
// declaration site would let the composer drift per surface.
const surfaceRootDeclarations = [];
for (const name of await readdir(join(styles, 'agent-conversation'))) {
  if (!name.endsWith('.css')) continue;
  postcss.parse(await readFile(join(styles, 'agent-conversation', name), 'utf8')).walkRules(rule => {
    if (isKeyframeStep(rule) || rule.selector.trim() !== '.agent-conversation-surface') return;
    for (const [, variable] of stripComments(rule.toString()).matchAll(/(--(?:agent|atc)-[\w-]+)\s*:/g)) surfaceRootDeclarations.push(`${name}:${variable}`);
  });
}
for (const entry of surfaceRootDeclarations) {
  if (!entry.startsWith('surface.css:')) boundaryErrors.push(`surface root token declared outside surface.css: ${entry}`);
}

assert.equal(boundaryErrors.length, 0, boundaryErrors.join('\n'));
const fixtureOnly = process.argv.includes('--fixture-only');
const chrome = process.env.CHROME_BIN ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
assert(fixtureOnly || chrome, 'Set CHROME_BIN or use --fixture-only.');
const folder = await mkdtemp(join(tmpdir(), 'flowix-agent-styles-'));
try {
  await build({ absWorkingDir: root, entryPoints: ['scripts/fixtures/agent-style-boundaries.js'], bundle: true, format: 'iife', platform: 'browser', alias: { '@': resolve(root, 'app/flowix-web') }, outfile: join(folder, 'probe.js') });
  const html = join(folder, 'probe.html');
  await writeFile(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="probe.css"><style>*,::before,::after { box-sizing:border-box; } .flex { display:flex; } .flex-col { flex-direction:column; } .min-h-0 { min-height:0; } .flex-1 { flex:1 1 0%; } :root { --font-sans: Arial; --font-size:15px; --font-line-height:1.8; --titlebar-gradient:linear-gradient(to bottom,var(--bg-titlebar),transparent); }</style><pre id="agent-style-result">Running</pre><script src="probe.js"></script>`);
  if (fixtureOnly) console.log(pathToFileURL(html).href);
  else {
    const { stdout } = await promisify(execFile)(chrome, ['--headless', '--disable-gpu', '--allow-file-access-from-files', `--user-data-dir=${join(folder, 'chrome')}`, '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(html).href], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    const match = stdout.match(/<pre id="agent-style-result">(.*?)<\/pre>/s);
    assert(match, 'Browser did not return a style report.');
    const result = JSON.parse(match[1].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
    assert(result.ok, result.error);
    console.log(`Agent style boundaries passed: ${result.cases.join(', ')}; ${result.checks.join('; ')}.`);
  }
} finally {
  if (!fixtureOnly) await rm(folder, { recursive: true, force: true });
}
