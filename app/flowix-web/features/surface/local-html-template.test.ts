import { beforeEach, describe, expect, it, vi } from 'vitest';
import bridgeSource from '../../../flowix-desktop/src/local_html_preview.js?raw';
import workbenchTemplate from '../../../flowix-cli/resources/templates/workbench.html?raw';

/**
 * Runs the injected SDK against jsdom and exercises the declarative binder.
 *
 * The contract is only real if the page actually renders: the shipped doc and
 * demo both promised nested loops and bar widths before the SDK supported them.
 * String assertions in `lib/html-embed-api.test.ts` catch drift in names; this
 * file catches drift in behaviour.
 */
interface PageBridge {
  flowix: {
    render: (root: unknown) => void;
    request: (kind: string) => Promise<unknown>;
    version: number;
    protocol: string;
    onInvalidate: (listener: (event: { kinds: string[] | null }) => void) => () => void;
  };
  parent: { postMessage: (message: unknown, target: string) => void };
}

function mount(html: string): PageBridge {
  document.body.innerHTML = html;
  const frame = Object.assign(new EventTarget(), {
    parent: { postMessage: vi.fn() },
    // jsdom lacks matchMedia; the background probe guards on it.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  new Function('window', 'document', 'location', bridgeSource)(
    frame,
    document,
    { href: 'asset://localhost/book/index.html' },
  );
  return frame as unknown as PageBridge;
}

/**
 * Mount a whole template file. `mount` sets `body.innerHTML`, which discards
 * attributes on `<html>`/`<body>` — a real document keeps them, and the shipped
 * template hangs its theme variables there, so replay those two.
 */
function mountTemplate(html: string): PageBridge {
  const page = mount(html);
  for (const tag of ['html', 'body']) {
    const declaration = new RegExp(`<${tag}\\b[^>]*data-fx-style="([^"]*)"`).exec(html)?.[1];
    if (declaration) {
      (tag === 'html' ? document.documentElement : document.body)
        .setAttribute('data-fx-style', declaration);
    }
  }
  return page;
}

describe('declarative binder', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('exposes the protocol the host answers', () => {
    const page = mount('');
    expect(page.flowix.protocol).toBe('flowix.embed');
    expect(page.flowix.version).toBe(1);
  });

  it('renders text and nested loops without losing the parent item', () => {
    const page = mount(`
      <template data-fx-each="views.collections">
        <div class="collection">
          <b data-fx-text="item.name"></b>
          <template data-fx-each="item.views" data-fx-as="view">
            <span class="view" data-fx-text="view.name"></span>
          </template>
        </div>
      </template>`);

    page.flowix.render({
      views: {
        collections: [
          { name: '产品文档', views: [{ name: '全部' }, { name: '按状态' }] },
          { name: '设计素材', views: [{ name: '瀑布流' }] },
        ],
      },
    });

    expect([...document.querySelectorAll('.collection > b')].map((el) => el.textContent))
      .toEqual(['产品文档', '设计素材']);
    expect([...document.querySelectorAll('.view')].map((el) => el.textContent))
      .toEqual(['全部', '按状态', '瀑布流']);
  });

  it('sets a single CSS property from a payload value', () => {
    const page = mount(`
      <template data-fx-each="stats.topTags">
        <div class="bar" data-fx-style="width:item.barWidth"></div>
      </template>`);

    page.flowix.render({ stats: { topTags: [{ barWidth: '62%' }, { barWidth: '100%' }] } });

    const bars = [...document.querySelectorAll<HTMLElement>('.bar')];
    expect(bars.map((el) => el.style.width)).toEqual(['62%', '100%']);
  });

  it('re-renders in place instead of appending duplicates', () => {
    const page = mount(`
      <template data-fx-each="stats.topTags">
        <div class="tag" data-fx-text="item.name"></div>
      </template>`);

    page.flowix.render({ stats: { topTags: [{ name: '#a' }, { name: '#b' }] } });
    page.flowix.render({ stats: { topTags: [{ name: '#c' }] } });

    expect([...document.querySelectorAll('.tag')].map((el) => el.textContent)).toEqual(['#c']);
  });

  it('toggles content with comparisons and empties arrays', () => {
    const page = mount(`
      <p id="empty" data-fx-if="views.collections.length == 0">空</p>`);

    page.flowix.render({ views: { collections: [] } });
    expect(document.getElementById('empty')!.hidden).toBe(false);

    page.flowix.render({ views: { collections: [{ name: 'x' }] } });
    expect(document.getElementById('empty')!.hidden).toBe(true);
  });

  it('tells pages that read rows imperatively to refresh', () => {
    const page = mount('');
    const seen: (string[] | null)[] = [];
    page.flowix.onInvalidate((event) => seen.push(event.kinds));

    const emit = (data: Record<string, unknown>) => (page as unknown as EventTarget).dispatchEvent(
      new MessageEvent('message', { data, source: page.parent as unknown as MessageEventSource }),
    );
    emit({ type: 'flowix:local-html-data-changed' });
    emit({ type: 'flowix:local-html-data-changed', kinds: ['product-theme'] });

    // A host that does not say what changed means "everything".
    expect(seen).toEqual([null, ['product-theme']]);
  });

  it('binds a theme token onto a custom property', () => {
    const page = mount('<div id="root" data-fx-style="--bg:theme.tokens.background"></div>');
    page.flowix.render({ theme: { tokens: { background: '#0b0b0b' } } });

    // The shipped workbench template sets --bg/--fg/--card/--brand this way:
    // one property per element, because the binding splits on the first colon.
    expect(document.getElementById('root')!.style.getPropertyValue('--bg')).toBe('#0b0b0b');
  });
});

/**
 * `flowix html --template workbench` prints this file verbatim into a user's
 * notebook. Nobody reads it as source before running it, so the only way to
 * know it still works is to render it against a realistic payload.
 */
describe('shipped workbench template', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  const payload = {
    stats: {
      totalMemos: 42,
      databaseCount: 7,
      todoMemos: 3,
      topTags: [{ name: '#flowix', count: 12, barWidth: '80%' }],
    },
    views: {
      collections: [
        {
          name: '产品文档',
          type: 'table',
          rowCount: 12,
          relativePath: 'docs/products',
          href: 'flowix://open?notebookId=nb-1&f=docs%2Fproducts',
          views: [{ name: '全部' }, { name: '按状态' }],
        },
        {
          name: '素材库',
          type: 'media_library',
          rowCount: null,
          relativePath: 'media',
          // Not a collection file: no address to open, so the host hands back
          // an empty string and the card must stay inert.
          href: '',
          views: [],
        },
      ],
    },
    theme: {
      id: 'warm',
      tokens: { background: '#101010', foreground: '#fafafa', card: '#181818', brand: '#c2603a' },
    },
  };

  it('renders the counts, tag bars and collections from the payload it advertises', () => {
    const page = mountTemplate(workbenchTemplate);
    page.flowix.render(payload);

    expect([...document.querySelectorAll('.card b')].map((el) => el.textContent))
      .toEqual(['42', '3', '7']);
    expect([...document.querySelectorAll('.tagrow .name')].map((el) => el.textContent))
      .toEqual(['#flowix']);
    expect(document.querySelector<HTMLElement>('.fill')!.style.width).toBe('80%');

    expect([...document.querySelectorAll('.coll h3')].map((el) => el.textContent))
      .toEqual(['产品文档', '素材库']);
    // The title is a link because `collections[].href` exists; a collection
    // without an address keeps an empty href (CSS makes it unclickable) rather
    // than pointing anywhere. The bridge resolves this protocol, so a page that
    // renders it needs no click handler of its own.
    expect([...document.querySelectorAll('.coll h3 a')].map((el) => el.getAttribute('href')))
      .toEqual(['flowix://open?notebookId=nb-1&f=docs%2Fproducts', '']);
    // rowCount is null for a paginated collection: the cell stays empty on
    // purpose (CSS hides it) instead of printing "0" or "null".
    expect([...document.querySelectorAll('.coll .rows')].map((el) => el.textContent))
      .toEqual(['12', '']);
    expect([...document.querySelectorAll('.coll .path')].map((el) => el.textContent))
      .toEqual(['docs/products', 'media']);
    // Nested loop: the inner alias must not have swallowed the outer item.
    expect([...document.querySelectorAll('.chip')].map((el) => el.textContent))
      .toEqual(['全部', '按状态']);
  });

  it('applies the product theme through custom properties', () => {
    const page = mountTemplate(workbenchTemplate);
    page.flowix.render(payload);

    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#101010');
    expect(document.body.style.getPropertyValue('--fg')).toBe('#fafafa');
    expect(document.querySelector('main')!.style.getPropertyValue('--card')).toBe('#181818');
    expect(document.querySelector('header')!.style.getPropertyValue('--brand')).toBe('#c2603a');
  });

  it('reveals the empty states only when the notebook really is empty', () => {
    const page = mountTemplate(workbenchTemplate);
    page.flowix.render(payload);
    const hints = [...document.querySelectorAll('p.hint[data-fx-if]')];
    expect(hints.length).toBe(2);
    expect(hints.map((el) => (el as HTMLElement).hidden)).toEqual([true, true]);

    page.flowix.render({ stats: { topTags: [] }, views: { collections: [] } });
    expect(hints.map((el) => (el as HTMLElement).hidden)).toEqual([false, false]);
  });

  it('auto-pulls exactly the payloads its bindings read from', () => {
    const meta = /<meta\s+name="flowix-data"\s+content="([^"]*)"/.exec(workbenchTemplate)?.[1] ?? '';
    const keys = meta.split(/[\s,]+/).filter(Boolean).sort();

    // Root of every binding path. `attr`/`style` declarations are `prop:path`.
    const roots = new Set<string>();
    for (const [, hook, value] of workbenchTemplate.matchAll(
      /data-fx-(text|attr|style|if|each)="([^"]*)"/g,
    )) {
      const path = hook === 'attr' || hook === 'style' ? value.slice(value.indexOf(':') + 1) : value;
      const root = path.trim().split(/[.\s]/)[0];
      if (root && root !== 'item' && root !== 'view') roots.add(root);
    }

    // A binding on a payload that is not auto-pulled renders empty with no
    // error to look at, so the two lists have to agree.
    expect([...roots].sort()).toEqual(keys);
  });
});


describe('request errors', () => {
  it('returns coded invalid, busy and timeout errors from the SDK', async () => {
    vi.useFakeTimers();
    try {
      const page = mount('');
      await expect(page.flowix.request('')).rejects.toMatchObject({ code: 'E_INVALID' });
      const pending = Array.from({ length: 16 }, () => page.flowix.request('notebook-stats').catch(error => error));
      await expect(page.flowix.request('notebook-stats')).rejects.toMatchObject({ code: 'E_BUSY' });
      await vi.advanceTimersByTimeAsync(15000);
      expect((await Promise.all(pending)).every(error => error instanceof Error && 'code' in error && error.code === 'E_TIMEOUT')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
