// Installed by the native host at document start, including sandboxed frames.
(() => {
  if (window === window.parent) return;
  const url = new URL(location.href);
  const local = (url.protocol === 'asset:' && url.hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
  if (!local) return;

  const documentUrl = (value) => {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.href;
  };
  const click = (event) => {
    if (event.button !== 0 && !(event.type === 'auxclick' && event.button === 1)) return;
    const anchor = event.target?.closest?.('a[href], area[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href?.trim()) return;
    try {
      const destination = new URL(href, document.baseURI || location.href);
      if (destination.href.includes('#') && documentUrl(destination.href) === documentUrl(location.href)) return;
    } catch {
      // Invalid links are handled by the host along with unsupported protocols.
    }
    // All cross-document links, including _blank/download, follow Browser's
    // normal surface navigation. The preview never launches another window.
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage({
      type: 'flowix:local-html-link', url: location.href, href,
      baseHref: document.querySelector?.('base[href]')?.getAttribute('href') ?? null,
    }, '*');
  };
  document.addEventListener('click', click, true);
  document.addEventListener('auxclick', click, true);

  function ready() {
    if (document.readyState === 'loading') return;
    document.removeEventListener('readystatechange', ready);
    // Interactive means the document was parsed, before deferred scripts and
    // images finish. External dependencies must not hold the Work host open.
    window.parent.postMessage({
      type: 'flowix:local-html-document-ready', url: location.href,
    }, '*');
  }
  const probe = (event) => {
    if (event.source === window.parent && event.data?.type === 'flowix:local-html-document-probe') ready();
  };
  window.addEventListener('message', probe);
  window.addEventListener('pagehide', () => {
    document.removeEventListener('readystatechange', ready);
    window.removeEventListener('message', probe);
    document.removeEventListener('click', click, true);
    document.removeEventListener('auxclick', click, true);
  }, { once: true });
  document.addEventListener('readystatechange', ready);
  ready();
})();

// The sandboxed frame owns computed styles; expose only its solid page color.
// Keep this separate from readiness so style work never delays document opens.
(() => {
  if (window === window.parent || !window.getComputedStyle) return;
  const url = new URL(location.href);
  const local = (url.protocol === 'asset:' && url.hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
  if (!local) return;

  let stopped = false;
  let animationFrame = null;
  let observer = null;
  let context = null;
  let lastColor = null;
  const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const publish = () => {
    animationFrame = null;
    if (stopped || !context || !document.body) return;
    // Composite alpha colors over the preview iframe's white canvas. Using a
    // pixel also handles computed CSS Color 4 values without a custom parser.
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1, 1);
    for (const element of [document.documentElement, document.body]) {
      context.fillStyle = window.getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    const color = `rgb(${r}, ${g}, ${b})`;
    if (color === lastColor) return;
    lastColor = color;
    window.parent.postMessage({ type: 'flowix:local-html-background', url: location.href, color }, '*');
  };
  const schedule = () => {
    if (!stopped && animationFrame === null) animationFrame = window.requestAnimationFrame(publish);
  };
  const probe = (event) => {
    if (event.source === window.parent && event.data?.type === 'flowix:local-html-document-probe') schedule();
  };
  const start = () => {
    if (document.readyState === 'loading' || stopped) return;
    document.removeEventListener('readystatechange', start);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    observer = new window.MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true });
    if (document.body) observer.observe(document.body, { attributes: true });
    if (document.head) observer.observe(document.head, { attributes: true, childList: true, subtree: true, characterData: true });
    document.addEventListener('load', schedule, true);
    window.addEventListener('load', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('message', probe);
    scheme?.addEventListener('change', schedule);
    schedule();
  };
  window.addEventListener('pagehide', () => {
    stopped = true;
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    observer?.disconnect();
    document.removeEventListener('readystatechange', start);
    document.removeEventListener('load', schedule, true);
    window.removeEventListener('load', schedule);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('message', probe);
    scheme?.removeEventListener('change', schedule);
  }, { once: true });
  document.addEventListener('readystatechange', start);
  start();
})();

// Data bridge for embedded local HTML previews. Activates under the same
// conditions as the link bridge above (sandboxed asset frames only). Exposes
// window.flowix.{request,render,onData,data} plus the data-fx-* declarative
// template syntax resolved from <meta name="flowix-data" content="...">.
(() => {
  if (window === window.parent) return;
  const url = new URL(location.href);
  const local = (url.protocol === 'asset:' && url.hostname === 'localhost')
    || (['http:', 'https:'].includes(url.protocol) && url.hostname === 'asset.localhost');
  if (!local) return;

  const pending = new Map();
  const pendingTemplateInstalls = new Map();
  let sequence = 0;
  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  const post = (message) => window.parent.postMessage(message, '*');

  const request = (kind, params) => {
    if (typeof kind !== 'string' || !kind) return Promise.reject(new Error('kind is required'));
    if (pending.size >= 16) return Promise.reject(new Error('too many inflight data requests'));
    const requestId = `fx-${Date.now().toString(36)}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(requestId)) reject(new Error('data request timeout'));
      }, 15000);
      pending.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      post({ type: 'flowix:local-html-data-request', url: location.href, requestId, kind, params: params ?? null });
    });
  };

  const installTemplate = (templateId) => {
    if (typeof templateId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(templateId) || templateId.length > 64) {
      return Promise.reject(new Error('invalid template ID'));
    }
    if (pendingTemplateInstalls.size >= 4) return Promise.reject(new Error('too many template installations'));
    const requestId = `fx-template-${Date.now().toString(36)}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingTemplateInstalls.delete(requestId)) reject(new Error('template installation timeout'));
      }, 120000);
      pendingTemplateInstalls.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      post({ type: 'flowix:local-html-template-install', url: location.href, requestId, templateId });
    });
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (data?.type === 'flowix:local-html-template-install-result' && typeof data.requestId === 'string') {
      const entry = pendingTemplateInstalls.get(data.requestId);
      if (!entry) return;
      pendingTemplateInstalls.delete(data.requestId);
      if (data.success === true) entry.resolve(data.result ?? null);
      else entry.reject(new Error(typeof data.error === 'string' ? data.error : 'template installation failed'));
    } else if (data?.type === 'flowix:local-html-data-response' && typeof data.requestId === 'string') {
      const entry = pending.get(data.requestId);
      if (!entry) return;
      pending.delete(data.requestId);
      if (data.ok) entry.resolve(data.payload);
      else entry.reject(new Error(typeof data.error === 'string' ? data.error : 'data request failed'));
    } else if (data?.type === 'flowix:local-html-data-changed') {
      const kinds = Array.isArray(data.kinds)
        ? new Set(data.kinds.filter((kind) => typeof kind === 'string'))
        : null;
      void refreshAuto(kinds);
    }
  });

  // ---------- data-fx-* declarative template rendering ----------
  const getPath = (scope, path) => String(path ?? '')
    .trim()
    .split('.')
    .reduce((value, key) => (value == null ? value : value[key]), scope);
  const CONDITION = /^([\w.$]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;
  const evaluate = (expr, lookup) => {
    const text = String(expr ?? '').trim();
    const match = text.match(CONDITION);
    if (!match) {
      const value = lookup(text);
      return Array.isArray(value) ? value.length > 0 : Boolean(value);
    }
    const left = lookup(match[1]);
    const raw = match[3].trim().replace(/^["']|["']$/g, '');
    const numeric = Number(raw);
    const right = raw !== '' && !Number.isNaN(numeric) ? numeric : raw;
    switch (match[2]) {
      case '==': return left === right;
      case '!=': return left !== right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '<': return left < right;
      default: return false;
    }
  };

  const bind = (fragment, local, root) => {
    const lookup = (path) => {
      const value = getPath(local, path);
      return value === undefined ? getPath(root, path) : value;
    };
    // Each templates first (document order = outer before nested), so per-item
    // fragments are bound with their item scope merged over the outer scopes.
    fragment.querySelectorAll('template[data-fx-each]').forEach((tpl) => {
      const list = lookup(tpl.getAttribute('data-fx-each'));
      let node = tpl.nextElementSibling;
      while (node && node.hasAttribute('data-fx-rendered')) {
        const next = node.nextElementSibling;
        node.remove();
        node = next;
      }
      if (!Array.isArray(list)) return;
      let cursor = tpl;
      for (const item of list.slice(0, 200)) {
        const clone = tpl.content.cloneNode(true);
        bind(clone, { ...local, item }, root);
        let child = clone.firstElementChild;
        while (child) {
          child.setAttribute('data-fx-rendered', '');
          child = child.nextElementSibling;
        }
        const last = clone.lastElementChild;
        cursor.parentNode.insertBefore(clone, cursor.nextSibling);
        if (last) cursor = last;
      }
    });
    fragment.querySelectorAll('[data-fx-text]').forEach((el) => {
      if (el.closest('[data-fx-rendered]')) return;
      const value = lookup(el.getAttribute('data-fx-text'));
      el.textContent = value == null ? '' : String(value);
    });
    fragment.querySelectorAll('[data-fx-attr]').forEach((el) => {
      if (el.closest('[data-fx-rendered]')) return;
      const declaration = String(el.getAttribute('data-fx-attr') ?? '');
      const split = declaration.indexOf(':');
      if (split <= 0) return;
      const name = declaration.slice(0, split).trim();
      const value = lookup(declaration.slice(split + 1));
      if (name) el.setAttribute(name, value == null ? '' : String(value));
    });
    fragment.querySelectorAll('[data-fx-if]').forEach((el) => {
      if (el.closest('[data-fx-rendered]')) return;
      el.hidden = !evaluate(el.getAttribute('data-fx-if'), lookup);
    });
  };

  const render = (root) => bind(document, {}, isRecord(root) ? root : {});

  const listeners = new Set();
  let autoSources = [];
  let lastRoot = null;
  const refreshAuto = async (changedKinds = null) => {
    if (!autoSources.length) return;
    const sources = changedKinds
      ? autoSources.filter((source) => changedKinds.has(source.kind))
      : autoSources;
    if (!sources.length) return;
    const entries = await Promise.all(sources.map(async (source) => [
      source.key,
      await request(source.kind).catch(() => null),
    ]));
    lastRoot = { ...(lastRoot ?? {}), ...Object.fromEntries(entries) };
    render(lastRoot);
    listeners.forEach((listener) => { try { listener(lastRoot); } catch { /* page errors stay local */ } });
  };

  window.flowix = {
    request,
    installTemplate,
    render,
    onData: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get data() { return lastRoot; },
  };

  const KIND_BY_KEY = {
    'stats': 'notebook-stats',
    'views': 'notebook-views',
    'custom-views': 'notebook-custom-views',
    'theme': 'product-theme',
  };
  const startAuto = () => {
    const content = document.querySelector('meta[name="flowix-data"]')?.getAttribute('content') ?? '';
    autoSources = content.split(/[\s,]+/).filter(Boolean)
      .map((key) => (KIND_BY_KEY[key] ? { key, kind: KIND_BY_KEY[key] } : null))
      .filter(Boolean);
    if (autoSources.length) void refreshAuto();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startAuto, { once: true });
  else startAuto();

  window.addEventListener('pagehide', () => {
    pending.forEach((entry) => entry.reject(new Error('page unloaded')));
    pending.clear();
    pendingTemplateInstalls.forEach((entry) => entry.reject(new Error('page unloaded')));
    pendingTemplateInstalls.clear();
    listeners.clear();
  }, { once: true });
})();
