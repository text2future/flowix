import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HTML_DATA_KINDS,
  HTML_EMBED_ERROR_CODES,
  HTML_EMBED_FIELD_TYPES,
  HTML_EMBED_KINDS,
  HTML_EMBED_MAX_INFLIGHT,
  HTML_EMBED_MAX_VIEW_ROWS,
  HTML_EMBED_PROTOCOL,
  HTML_EMBED_PROTOCOL_VERSION,
  HtmlEmbedError,
  checkEmbedProtocol,
  embedErrorPayload,
} from './html-embed-api';
import { FLOWIX_EMBED_HTML_PROMPT_BLOCK } from '../features/agent/embed-html-prompt';
import bridgeSource from '../../flowix-desktop/src/local_html_preview.js?raw';
import previewHostSource from '../features/surface/use-local-html-preview.ts?raw';
import bridgeHostSource from '../features/surface/html-data-bridge.ts?raw';
import contractDoc from '../../../docs/EMBEDDED-HTML-API.md?raw';
import demoPage from '../../../examples/embedded-html-stats-demo.html?raw';
import workbenchTemplate from '../../flowix-cli/resources/templates/workbench.html?raw';

describe('embedded page protocol', () => {
  it('serves requests written before the version field existed', () => {
    expect(checkEmbedProtocol({})).toEqual({ ok: true });
    expect(checkEmbedProtocol({ kind: 'notebook-stats' })).toEqual({ ok: true });
  });

  it('accepts the current protocol and version', () => {
    expect(checkEmbedProtocol({
      protocol: HTML_EMBED_PROTOCOL,
      version: HTML_EMBED_PROTOCOL_VERSION,
    })).toEqual({ ok: true });
  });

  it('refuses a declared protocol or version it does not implement', () => {
    expect(checkEmbedProtocol({ protocol: 'flowix.other', version: 1 }))
      .toEqual({ ok: false, code: 'E_UNSUPPORTED', message: 'unsupported protocol: flowix.other' });
    expect(checkEmbedProtocol({ protocol: HTML_EMBED_PROTOCOL, version: 2 }))
      .toEqual({ ok: false, code: 'E_UNSUPPORTED', message: 'unsupported version: 2' });
    // Declaring half the contract counts as declaring it.
    expect(checkEmbedProtocol({ protocol: HTML_EMBED_PROTOCOL }))
      .toEqual({ ok: false, code: 'E_UNSUPPORTED', message: 'unsupported version: undefined' });
  });

  it('normalizes resolver failures into stable codes', () => {
    expect(embedErrorPayload(new HtmlEmbedError('E_SCOPE', 'view not found')))
      .toEqual({ code: 'E_SCOPE', message: 'view not found' });
    expect(embedErrorPayload(new Error('YAML broke'))).toEqual({ code: 'E_INTERNAL', message: 'YAML broke' });
    expect(embedErrorPayload('weird')).toEqual({ code: 'E_INTERNAL', message: 'weird' });
  });

  it('publishes the documented error codes', () => {
    expect([...HTML_EMBED_ERROR_CODES]).toEqual(['E_UNSUPPORTED', 'E_SCOPE', 'E_BUSY', 'E_INVALID', 'E_TIMEOUT', 'E_INTERNAL']);
  });
});

describe('capability catalog', () => {
  it('derives the request whitelist from the published list', () => {
    expect([...HTML_DATA_KINDS]).toEqual(HTML_EMBED_KINDS.map((entry) => entry.kind));
    expect(new Set(HTML_DATA_KINDS).size).toBe(HTML_DATA_KINDS.length);
  });

  it('uses a distinct meta key per auto-pulled kind', () => {
    const keys = HTML_EMBED_KINDS.flatMap((entry) => entry.metaKey ?? []);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is fully mirrored by the injected page SDK', () => {
    expect(bridgeSource).toContain(`const PROTOCOL = '${HTML_EMBED_PROTOCOL}'`);
    expect(bridgeSource).toContain(`const VERSION = ${HTML_EMBED_PROTOCOL_VERSION}`);
    for (const entry of HTML_EMBED_KINDS) {
      if (entry.metaKey) expect(bridgeSource).toContain(`'${entry.metaKey}': '${entry.kind}'`);
    }
    // The SDK must surface the same codes it can receive.
    expect(bridgeSource).toContain('error.code =');
  });

  it('is restated to agents with the location rule that makes it usable', () => {
    for (const entry of HTML_EMBED_KINDS) {
      expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain(entry.kind);
    }
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('当前笔记本目录');
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('E_SCOPE');
    // An agent that cannot run the CLI still has to be able to write a page, so
    // the one kind with params keeps them inline.
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('relativePath');
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('--template workbench');
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('--template table');
  });
});

/**
 * The row contract is what a workbench actually renders: a page that guesses the
 * column vocabulary or the row shape produces a table with blank headers. The
 * doc, the agent prompt and the SDK have to tell the same story.
 */
describe('view-data row contract', () => {
  it('publishes every column type it can emit', () => {
    expect(new Set(HTML_EMBED_FIELD_TYPES).size).toBe(HTML_EMBED_FIELD_TYPES.length);
    for (const type of HTML_EMBED_FIELD_TYPES) {
      expect(contractDoc).toContain(`\`${type}\``);
    }
  });

  it('documents the fields a page needs to render and refresh a card', () => {
    for (const field of ['rowCount', 'total', 'resolved', 'href', 'onInvalidate']) {
      expect(`${field}:${contractDoc.includes(field)}`).toBe(`${field}:true`);
    }
  });

  it('states the row shape where agents actually read it', () => {
    // The row contract used to be restated in the agent prompt; it now lives in
    // the capability catalog that `flowix html` prints, generated from this
    // module (`npm run check:embed-catalog` keeps the JSON honest). What the
    // prompt still owes the agent is the pointer — without it nobody reads the
    // catalog.
    const catalog = readFileSync(
      resolve(__dirname, '../../flowix-cli/resources/embed-catalog.json'),
      'utf8',
    );
    for (const field of ['propertyKey', 'resolved', 'href', 'total', 'rowCount']) {
      expect(`${field}:${catalog.includes(field)}`).toBe(`${field}:true`);
    }
    for (const type of HTML_EMBED_FIELD_TYPES) {
      expect(catalog).toContain(type);
    }
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('flowix html');
  });

  it('exposes the invalidation hook the doc promises', () => {
    expect(bridgeSource).toContain('onInvalidate');
    expect(bridgeSource).toContain('flowix:local-html-data-changed');
  });
});

/**
 * The declarative template syntax is the part agents copy verbatim. These
 * guards exist because the doc, the demo and the SDK disagreed once already:
 * `data-fx-attr="style:..."` writes an invalid whole-attribute value, and a
 * nested loop without an alias silently hides the parent item.
 */
describe('declarative template contract', () => {
  it('keeps every documented binding attribute implemented by the SDK', () => {
    for (const attribute of ['data-fx-text', 'data-fx-attr', 'data-fx-style', 'data-fx-each', 'data-fx-if', 'data-fx-as']) {
      expect(bridgeSource).toContain(attribute);
    }
  });

  it('never advertises style through the whole-attribute binding', () => {
    for (const [name, source] of [['doc', contractDoc], ['demo', demoPage]] as const) {
      expect(`${name}:${source.includes('data-fx-attr="style:')}`).toBe(`${name}:false`);
    }
    expect(demoPage).toContain('data-fx-style="width:item.barWidth"');
  });

  it('gives nested loops in the demo a distinct item name', () => {
    expect(demoPage).toContain('data-fx-each="item.views" data-fx-as="view"');
    expect(demoPage).toContain('data-fx-text="view.name"');
  });

  it('tells agents about both pitfalls', () => {
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('data-fx-style');
    expect(FLOWIX_EMBED_HTML_PROMPT_BLOCK).toContain('data-fx-as');
  });

  it('ships a workbench whose collection cards are clickable', () => {
    // The template is what an agent copies first. Without this binding every
    // generated workbench renders collection names as inert text, and the page
    // looks read-only to whoever opens it.
    expect(workbenchTemplate).toContain('data-fx-each="views.collections"');
    expect(workbenchTemplate).toContain('data-fx-attr="href:item.href"');
  });
});

/**
 * Page authors get autocomplete from `docs/embed/flowix-embed.d.ts`. It is
 * hand-written, so the only thing keeping it honest is this guard: a kind or a
 * field type added to the contract must show up in the typings too.
 */
describe('page typings', () => {
  const typings = readFileSync(resolve('docs/embed/flowix-embed.d.ts'), 'utf8');

  it('declares every published kind', () => {
    for (const kind of HTML_DATA_KINDS) expect(typings).toContain(`'${kind}'`);
  });

  it('declares every field type a page can switch on', () => {
    for (const type of HTML_EMBED_FIELD_TYPES) expect(typings).toContain(`'${type}'`);
  });

  it('declares the SDK surface, including the invalidation hook', () => {
    for (const member of ['request(kind:', 'render(', 'onData(', 'onInvalidate(', 'readonly data']) {
      expect(typings).toContain(member);
    }
    expect(typings).toContain('FlowixViewDataRow');
    expect(typings).toContain('readonly version: 1');
  });
});

/**
 * Both sides cap concurrent data requests. They disagreed once (page 16, host
 * 8), which turned a legal parallel read into `E_BUSY` for half the page's
 * requests. The host now derives its cap from the contract; the SDK is plain JS
 * injected into a sandbox and can only mirror the literal, so compare that.
 */
describe('request budget', () => {
  const limitOf = (source: string, pattern: RegExp): number => {
    const match = pattern.exec(source);
    expect(match, `budget literal missing from ${pattern}`).not.toBeNull();
    return Number(match![1]);
  };

  it('gives the page and the host the same inflight cap', () => {
    const pageLimit = limitOf(bridgeSource, /pending\.size >= (\d+)/);
    // The host reads the contract; the SDK can only mirror the literal.
    expect(pageLimit).toBe(HTML_EMBED_MAX_INFLIGHT);
    expect(previewHostSource).toContain('HTML_EMBED_MAX_INFLIGHT');
  });

  it('makes the resolver read the row cap instead of repeating it', () => {
    // The catalog quotes both numbers, so a copy in the resolver is a number
    // the page can be told it has but cannot use.
    expect(bridgeHostSource).toContain('HTML_EMBED_MAX_VIEW_ROWS');
    expect(HTML_EMBED_MAX_VIEW_ROWS).toBe(200);
  });
});
