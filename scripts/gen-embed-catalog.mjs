// Generates `app/flowix-cli/resources/embed-catalog.json` — the capability
// catalog that `flowix html` prints, which is how an agent writing a page in a
// notebook learns what data it can read.
//
// Why generated: the catalog is the fourth consumer of the embedded-page
// contract (`app/flowix-web/lib/html-embed-api.ts`). Hand-copying kind names,
// params and row shapes into a Rust string means a new kind ships invisible to
// every agent, and a renamed field ships wrong. Here the TS module is the only
// writer of truth.
//
// Why esbuild: the source is TypeScript and the repo's `tsconfig` only covers
// `app/flowix-web`, so a plain `import` fails on Node 20 (CI's web job). Rather
// than regex-scraping the file, strip types with the esbuild we already depend
// on and import the result through a data URL. No imports in that module means
// no resolution to configure.
//
// Run from repo root:
//
//     node scripts/gen-embed-catalog.mjs            # write the JSON
//     node scripts/gen-embed-catalog.mjs --check     # CI: fail if stale
//
// `--check` also validates the two page templates shipped next to the JSON:
// every `data-fx-*` attribute must exist in the injected SDK, every kind they
// request must be published here, and the CLI must actually embed both files.
// Templates are copied into a user's notebook and run there, so a typo costs a
// debugging session on something they cannot see the source of.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const CONTRACT = resolve(root, 'app/flowix-web/lib/html-embed-api.ts');
const SDK = resolve(root, 'app/flowix-desktop/src/local_html_preview.js');
const TEMPLATE_DIR = resolve(root, 'app/flowix-cli/resources/templates');
const CLI_MODULE = resolve(root, 'app/flowix-cli/src/html.rs');
const AGENT_PROMPT = resolve(root, 'app/flowix-web/features/agent/embed-html-prompt.ts');
const OUTPUT = resolve(root, 'app/flowix-cli/resources/embed-catalog.json');

/**
 * One line each for the catalog's "模板" section. Adding a template means: drop
 * the file in TEMPLATE_DIR, add it here, then embed it in `src/html.rs` — the
 * check below fails until all three agree.
 */
const TEMPLATES = {
  workbench: '零 JS 工作台：概览数字 + 标签分布 + 集合清单（纯声明式绑定）',
  table: '集合表格：手动取行、按列渲染、笔记本变更后重取（命令式）',
};

/** `data-fx-rendered` is the binder's own bookkeeping, never a template hook. */
const INTERNAL_ATTRIBUTES = new Set(['rendered']);

const checkOnly = process.argv.includes('--check');

const contract = await loadContract();
const sdk = readFileSync(SDK, 'utf8');
const bindings = readBindings(sdk);
const metaKeys = readMetaKeys(sdk);

const catalog = {
  protocol: contract.HTML_EMBED_PROTOCOL,
  version: contract.HTML_EMBED_PROTOCOL_VERSION,
  maxViewRows: contract.HTML_EMBED_MAX_VIEW_ROWS,
  maxInflight: contract.HTML_EMBED_MAX_INFLIGHT,
  fieldTypes: [...contract.HTML_EMBED_FIELD_TYPES],
  errorCodes: [...contract.HTML_EMBED_ERROR_CODES],
  bindings,
  metaKeys,
  kinds: contract.HTML_EMBED_KINDS.map((entry) => ({
    kind: entry.kind,
    intent: entry.intent,
    whenToUse: entry.whenToUse,
    summary: entry.summary,
    params: entry.params ?? null,
    returns: entry.returns,
    notes: [...(entry.notes ?? [])],
    metaKey: entry.metaKey ?? null,
  })),
  templates: Object.entries(TEMPLATES).map(([id, about]) => ({ id, about })),
};

// A thrown stack is noise in CI logs; the message is the whole story.
try {
  verifyCatalog(catalog);
  verifyTemplates(catalog);
} catch (error) {
  console.error(`embed catalog: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const text = `${JSON.stringify(catalog, null, 2)}\n`;

if (checkOnly) {
  const current = readOrEmpty(OUTPUT);
  if (current !== text) {
    console.error(
      'embed catalog is stale: run `npm run gen:embed-catalog` and commit\n'
      + `  source: ${CONTRACT}\n  output: ${OUTPUT}`,
    );
    process.exit(1);
  }
  console.log(`embed catalog ok: ${catalog.kinds.length} kinds, ${catalog.templates.length} templates`);
} else {
  writeFileSync(OUTPUT, text);
  console.log(
    `embed catalog  kinds=${catalog.kinds.length}  bindings=${bindings.length}  templates=${catalog.templates.length}`
    + `  ${Buffer.byteLength(text)} bytes  ->  ${OUTPUT}`,
  );
}

/** Strip types with esbuild, then import through a data URL. */
async function loadContract() {
  const source = readFileSync(CONTRACT, 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/**
 * Attribute names the binder implements, read out of the SDK rather than
 * retyped: a renamed hook must show up in the catalog the same release.
 */
function readBindings(source) {
  const found = new Set();
  for (const match of source.matchAll(/data-fx-([a-z-]+)/g)) {
    if (!INTERNAL_ATTRIBUTES.has(match[1])) found.add(match[1]);
  }
  const order = ['text', 'attr', 'style', 'each', 'if', 'as'];
  return [
    ...order.filter((name) => found.has(name)),
    ...[...found].filter((name) => !order.includes(name)).sort(),
  ];
}

/** `<meta name="flowix-data">` keys, taken from the SDK's own key→kind table. */
function readMetaKeys(source) {
  const table = source.match(/const KIND_BY_KEY = \{([\s\S]*?)\};/);
  if (!table) throw new Error(`cannot find KIND_BY_KEY in ${SDK}`);
  return [...table[1].matchAll(/'([a-z-]+)':\s*'([a-z-]+)'/g)].map((match) => match[1]);
}

/** Cheap structural checks — a silently empty catalog is worse than a red CI. */
function verifyCatalog(value) {
  if (!value.kinds.length) throw new Error('catalog has no kinds');
  const names = new Set();
  for (const entry of value.kinds) {
    if (names.has(entry.kind)) throw new Error(`duplicate kind: ${entry.kind}`);
    names.add(entry.kind);
    for (const field of ['intent', 'whenToUse', 'summary', 'returns']) {
      if (!entry[field]) throw new Error(`kind ${entry.kind} is missing ${field}`);
    }
    if (entry.metaKey && !value.metaKeys.includes(entry.metaKey)) {
      throw new Error(`kind ${entry.kind} declares metaKey ${entry.metaKey}, which the SDK does not map`);
    }
  }
  // Every key the SDK auto-pulls must belong to a published kind, or the page
  // can write <meta> keys that resolve to nothing.
  for (const key of value.metaKeys) {
    if (!value.kinds.some((entry) => entry.metaKey === key)) {
      throw new Error(`the SDK maps <meta> key "${key}" but no kind declares it`);
    }
  }
  if (!value.bindings.includes('each') || !value.bindings.includes('style')) {
    throw new Error(`the SDK no longer implements the documented bindings: ${value.bindings.join(', ')}`);
  }
}

/**
 * Templates are shipped to users, so they get the same treatment as the doc:
 * names they use must exist in the contract, and the CLI must be able to print
 * them.
 */
function verifyTemplates(value) {
  const files = readdirSync(TEMPLATE_DIR).filter((name) => name.endsWith('.html')).sort();
  const ids = files.map((name) => name.slice(0, -'.html'.length));
  const declared = Object.keys(TEMPLATES).sort();
  if (ids.join() !== declared.join()) {
    throw new Error(
      `templates on disk (${ids.join(', ') || 'none'}) do not match TEMPLATES (${declared.join(', ')})`,
    );
  }

  const cli = readOrEmpty(CLI_MODULE);
  const embedded = [...cli.matchAll(/include_str!\("\.\.\/resources\/templates\/([a-z-]+)\.html"\)/g)]
    .map((match) => match[1])
    .sort();
  if (embedded.join() !== ids.join()) {
    throw new Error(
      `src/html.rs embeds (${embedded.join(', ') || 'none'}) but templates are (${ids.join(', ')})`,
    );
  }

  const kinds = new Set(value.kinds.map((entry) => entry.kind));
  const bindings = new Set(value.bindings);
  const metaKeys = new Set(value.metaKeys);

  // The agent prompt is what sends a page author to these templates; a template
  // nobody is told about is a template nobody uses.
  const prompt = readOrEmpty(AGENT_PROMPT);
  for (const id of ids) {
    if (!prompt.includes(`--template ${id}`)) {
      throw new Error(`features/agent/embed-html-prompt.ts never mentions \`--template ${id}\``);
    }
  }

  for (const id of ids) {
    const source = readFileSync(join(TEMPLATE_DIR, `${id}.html`), 'utf8');
    const file = `templates/${id}.html`;

    for (const match of source.matchAll(/data-fx-([a-z-]+)/g)) {
      if (!bindings.has(match[1])) {
        throw new Error(`${file}: data-fx-${match[1]} is not implemented by the page SDK`);
      }
    }

    for (const match of source.matchAll(/request\(\s*'([a-z-]+)'/g)) {
      if (!kinds.has(match[1])) throw new Error(`${file}: request('${match[1]}') is not a published kind`);
    }

    // A template that asks for more rows than the cap gets silently clamped,
    // which reads as "the data is missing" to whoever runs it.
    for (const match of source.matchAll(/limit:\s*(\d+)/g)) {
      if (Number(match[1]) !== value.maxViewRows) {
        throw new Error(`${file}: limit ${match[1]} should be the published cap ${value.maxViewRows}`);
      }
    }

    for (const match of source.matchAll(/<meta\s+name="flowix-data"\s+content="([^"]*)"/g)) {
      for (const key of match[1].split(/[\s,]+/).filter(Boolean)) {
        if (!metaKeys.has(key)) throw new Error(`${file}: <meta> key "${key}" is not a published kind key`);
      }
    }
  }
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
