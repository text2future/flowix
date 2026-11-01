// Remote pages own their scrollbars, and cross-origin documents cannot be
// reached through `contentDocument`. The shell injects this script into every
// frame, so the page restyles itself from the inside: the native bar is hidden
// (zero width, so content reclaims its space) and replaced by an overlay thumb
// that appears while scrolling. Native wheel, keyboard and touch scrolling are
// untouched — only the bar's geometry changes.
//
// Only the top-level page frame is handled. Nested frames keep their own
// scrollbars so embedded widgets and ad slots are not silently restyled.
(() => {
  if (window === window.top) return;
  if (window.parent !== window.top) return;
  const protocol = location.protocol;
  // Remote pages and local HTML previews are both cross-origin to the host, so
  // both can only be restyled from inside the frame.
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'asset:') return;

  const ATTR = 'data-flowix-overlay-scroll';
  const LAYER_ID = 'flowix-overlay-scroll-layer';
  const STYLE_ID = 'flowix-overlay-scroll-style';
  const THUMB_CLASS = 'flowix-overlay-thumb';
  const CONFIG_TYPE = 'flowix:web-frame-scrollbar';
  const READY_TYPE = 'flowix:web-frame-scrollbar-ready';
  const STATUS_TYPE = 'flowix:web-frame-scrollbar-status';
  const HIDE_DELAY = 700;
  const MIN_THUMB = 24;
  const EDGE = 2;
  /** Collapsing the viewport bar is confirmed over several passes: a layout
   * read taken right after the sheet lands can still report the bar that is
   * about to disappear, and acting on that first read is what used to restore
   * the full-width native bar for the rest of the document's life. */
  const VERIFY_PASSES = 4;
  const VERIFY_RETRY_MS = 150;

  let mac = true;
  let enabled = true;
  let color = 'rgba(0, 0, 0, 0.3)';
  let layer = null;
  let styleNode = null;
  let styleSheet = null;
  let scheduled = 0;
  let verifyTimer = 0;
  let started = false;
  /** The viewport bar alone refused to collapse. Element scrollers are still
   * adopted, so the document keeps its bars instead of losing them twice. */
  let rootSuppressed = false;
  /** Some hosts paint the viewport bar from a source no stylesheet can reach
   * (a native "thin" scroller, for instance). Scrolling then moves to <body>,
   * where the bar is an ordinary element scrollbar and always collapses. */
  let bodyScroller = false;
  let reported = '';
  const entries = new Map();

  function requestFrame(callback) {
    if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(callback);
    return window.setTimeout(callback, 16);
  }

  /** The document scroller is the only place WebKit can refuse to collapse the
   * native bar, so success is measured rather than assumed. */
  function rootGutter() {
    return window.innerWidth - document.documentElement.clientWidth;
  }

  /** The element the document actually scrolls by. WebKit keeps reporting
   * `document.scrollingElement === html` even after overflow moves to body, so
   * the scroller is derived from measurements instead of the property. */
  function rootElement() {
    const doc = document.documentElement;
    const body = document.body;
    if (bodyScroller && body) return body;
    if (doc && doc.scrollHeight - doc.clientHeight > 1) return doc;
    if (body && body.scrollHeight - body.clientHeight > 1) return body;
    return document.scrollingElement || doc;
  }

  function isRoot(element) {
    return element === document.scrollingElement || element === document.documentElement
      || element === document.body || element === rootElement();
  }

  function barSize() {
    return mac ? 6 : 9;
  }

  function overlayCss() {
    return `
      /* The document scroller is covered unconditionally: WebKit decides whether
       * the viewport bar belongs to html or body from how overflow propagates,
       * and getting that wrong is what leaves a gutter beside the content.
       * \`scrollbar-gutter: auto\` matters too — a page that reserves a stable
       * gutter keeps the empty strip after the bar itself is gone. */
      :root, body { scrollbar-width: none !important; -ms-overflow-style: none !important; scrollbar-gutter: auto !important; }
      [${ATTR}] { scrollbar-width: none !important; -ms-overflow-style: none !important; scrollbar-gutter: auto !important; }
      /* Doubled selectors outrank page rules that style the bar through a class,
       * an !important, or a sheet loaded later. WebKit paints scrollbars with
       * native NSScroller; display:none is the only declaration that reliably
       * removes the bar there, so width/height are emitted alongside it.
       * Body is covered through attribute selectors: a bare pseudo-class typo
       * like body:body invalidates the whole rule, scrollbar included. */
      :root:root::-webkit-scrollbar, body[${ATTR}][${ATTR}]::-webkit-scrollbar,
      [${ATTR}][${ATTR}]::-webkit-scrollbar {
        display: none !important; width: 0 !important; height: 0 !important;
      }
      #${LAYER_ID} { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
      #${LAYER_ID} > .${THUMB_CLASS} {
        position: fixed; top: 0; left: 0; margin: 0; padding: 0; border: 0;
        border-radius: 999px; background: currentColor; opacity: 0;
        transition: opacity 120ms ease-out; pointer-events: auto; touch-action: none;
      }
    `;
  }

  /** Last resort when the viewport bar ignores every stylesheet: take the
   * scrollbar away from the viewport entirely. <body> becomes the scroller,
   * and an element scrollbar always collapses under `::-webkit-scrollbar`.
   * The rules are ALSO inlined on the elements: an inline !important beats
   * any author rule and survives a sheet or <style> node being dropped. */
  function viewportFallbackCss() {
    return `
      :root:root {
        overflow: hidden !important; height: 100% !important;
        scrollbar-gutter: auto !important;
      }
      body[${ATTR}][${ATTR}] {
        position: fixed !important; inset: 0 !important; margin: 0 !important;
        overflow-y: auto !important; overflow-x: auto !important;
        scrollbar-width: none !important; scrollbar-gutter: auto !important;
      }
      body[${ATTR}][${ATTR}]::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    `;
  }

  /** The inline !important overrides that demote the viewport and promote
   * <body> to the scroller. One table drives the applied styles, their
   * cleanup, and documents what the fallback CSS mirrors. Both axes stay
   * scrollable: body's bars are hidden by the overlay stylesheet, and the
   * horizontal thumb needs the overflow to survive. */
  const FALLBACK_INLINE = {
    documentElement: [['overflow', 'hidden'], ['height', '100%'], ['scrollbar-gutter', 'auto']],
    body: [
      ['position', 'fixed'], ['inset', '0'], ['margin', '0'],
      ['overflow-y', 'auto'], ['overflow-x', 'auto'],
      ['scrollbar-width', 'none'], ['scrollbar-gutter', 'auto'],
    ],
  };

  function inlineFallbackStyles() {
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return;
    for (const [property, value] of FALLBACK_INLINE.documentElement) root.style.setProperty(property, value, 'important');
    for (const [property, value] of FALLBACK_INLINE.body) body.style.setProperty(property, value, 'important');
  }

  function clearInlineFallbackStyles() {
    for (const [element, keys] of [[document.documentElement, FALLBACK_INLINE.documentElement], [document.body, FALLBACK_INLINE.body]]) {
      if (!element) continue;
      for (const [property] of keys) element.style.removeProperty(property);
    }
  }

  function applyViewportFallback() {
    bodyScroller = true;
    inlineFallbackStyles();
    const css = overlayCss() + viewportFallbackCss();
    if (styleNode && styleNode.isConnected) styleNode.textContent = css;
    else appendStyleNode(css);
    if (styleSheet) {
      try {
        styleSheet.replaceSync(css);
      } catch {
        // Detached documents reject stylesheet updates; the sheet dies with them.
      }
    }
    const stale = [document.documentElement, document.body];
    for (const element of stale) {
      const entry = element && entries.get(element);
      if (entry) forget(entry);
    }
    document.documentElement.setAttribute(ATTR, '');
    if (document.body) document.body.setAttribute(ATTR, '');
    sync(ensureEntry(rootElement()), false);
  }

  /** Last-child-of-<html> sheet: author order beats a page rule that also uses
   * !important, and it survives engines that ignore constructed sheets. */
  function appendStyleNode(css) {
    if (styleNode && styleNode.isConnected) return;
    // An init script runs before `<html>` exists; without a root to append to,
    // leave the node uncreated — start() calls ensureStyle() again later.
    if (!document.documentElement) return;
    styleNode = document.createElement('style');
    styleNode.id = STYLE_ID;
    styleNode.textContent = css;
    document.documentElement.appendChild(styleNode);
  }

  /** Constructed stylesheets first: they are unaffected by however the document
   * handles inline `<style>`, which is why the local-preview script preferred
   * them too. Fall back to a <style> tag where they are unsupported. */
  function ensureStyle() {
    if (styleNode || styleSheet) return;
    const css = overlayCss();
    if (typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.replaceSync === 'function'
        && 'adoptedStyleSheets' in document) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        styleSheet = sheet;
        return;
      } catch {
        styleSheet = null;
      }
    }
    appendStyleNode(css);
  }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.style.color = color;
    (document.body || document.documentElement).appendChild(layer);
    return layer;
  }

  function measure(element) {
    if (isRoot(element)) {
      // Whichever element owns the scroll this document actually uses: the
      // viewport (html) normally, <body> when the fallback moved it there.
      const scroller = rootElement();
      const width = scroller.clientWidth || window.innerWidth;
      const height = scroller.clientHeight || window.innerHeight;
      return {
        root: true,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        scrollTop: scroller.scrollTop || (scroller === document.documentElement ? (window.pageYOffset || 0) : 0),
        scrollLeft: scroller.scrollLeft || (scroller === document.documentElement ? (window.pageXOffset || 0) : 0),
        scrollHeight: scroller.scrollHeight,
        scrollWidth: scroller.scrollWidth,
        clientHeight: height,
        clientWidth: width,
      };
    }
    const rect = element.getBoundingClientRect();
    return {
      root: false,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      scrollHeight: element.scrollHeight,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      clientWidth: element.clientWidth,
    };
  }

  function bounds(metrics, vertical) {
    const track = vertical ? metrics.bottom - metrics.top : metrics.right - metrics.left;
    const visible = vertical ? metrics.clientHeight : metrics.clientWidth;
    const total = vertical ? metrics.scrollHeight : metrics.scrollWidth;
    const offset = vertical ? metrics.scrollTop : metrics.scrollLeft;
    const max = total - visible;
    if (!(max > 1) || !(track > 0) || !(total > 0)) return null;
    const size = Math.min(track, Math.max(MIN_THUMB, Math.round((visible / total) * track)));
    const travel = Math.max(0, track - size);
    return { size, travel, offset: max > 0 ? (offset / max) * travel : 0, max };
  }

  function setBox(element, width, height, x, y) {
    const size = `${width}x${height}`;
    if (element.dataset.size !== size) {
      element.style.width = width;
      element.style.height = height;
      element.dataset.size = size;
    }
    const transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    if (element.dataset.pos !== transform) {
      element.style.transform = transform;
      element.dataset.pos = transform;
    }
  }

  function hideThumbs(entry) {
    if (entry.vThumb) entry.vThumb.style.display = 'none';
    if (entry.hThumb) entry.hThumb.style.display = 'none';
  }

  function paint(entry) {
    const metrics = entry.metrics;
    if (!metrics) return;
    // A bar that cannot be collapsed stays native; painting an overlay beside it
    // would be the double-scrollbar bug.
    if (metrics.root && rootSuppressed) {
      hideThumbs(entry);
      return false;
    }
    const bar = barSize();

    const vertical = bounds(metrics, true);
    if (vertical && entry.vThumb) {
      setBox(entry.vThumb, `${bar}px`, `${vertical.size}px`, metrics.right - bar - EDGE, metrics.top + vertical.offset);
      entry.vThumb.style.display = '';
    } else if (entry.vThumb) {
      entry.vThumb.style.display = 'none';
    }

    const horizontal = bounds(metrics, false);
    if (horizontal && entry.hThumb) {
      setBox(entry.hThumb, `${horizontal.size}px`, `${bar}px`, metrics.left + horizontal.offset, metrics.bottom - bar - EDGE);
      entry.hThumb.style.display = '';
    } else if (entry.hThumb) {
      entry.hThumb.style.display = 'none';
    }

    return Boolean(vertical || horizontal);
  }

  function sync(entry, reveal) {
    if (!entry.el.isConnected) {
      forget(entry);
      return;
    }
    entry.metrics = measure(entry.el);
    if (paint(entry) && reveal) revealThumb(entry);
  }

  function revealThumb(entry) {
    if (!entry.vThumb && !entry.hThumb) return;
    clearTimeout(entry.hideTimer);
    if (entry.vThumb) entry.vThumb.style.opacity = '1';
    if (entry.hThumb) entry.hThumb.style.opacity = '1';
    entry.hideTimer = setTimeout(() => {
      if (entry.dragging) return;
      if (entry.vThumb) entry.vThumb.style.opacity = '0';
      if (entry.hThumb) entry.hThumb.style.opacity = '0';
    }, HIDE_DELAY);
  }

  function forget(entry) {
    clearTimeout(entry.hideTimer);
    if (entry.vThumb) entry.vThumb.remove();
    if (entry.hThumb) entry.hThumb.remove();
    if (isRoot(entry.el)) {
      document.documentElement.removeAttribute(ATTR);
      if (document.body) document.body.removeAttribute(ATTR);
    } else {
      entry.el.removeAttribute(ATTR);
    }
    entries.delete(entry.el);
  }

  function beginDrag(event, entry, axis) {
    const metrics = entry.metrics;
    if (!metrics || event.button !== 0) return;
    const vertical = axis === 'v';
    const area = bounds(metrics, vertical);
    if (!area) return;

    event.preventDefault();
    entry.dragging = true;
    const start = vertical ? event.clientY : event.clientX;
    const startScroll = vertical ? metrics.scrollTop : metrics.scrollLeft;

    const onMove = (moveEvent) => {
      const delta = (vertical ? moveEvent.clientY : moveEvent.clientX) - start;
      const next = area.travel > 0 ? startScroll + (delta / area.travel) * area.max : startScroll;
      if (metrics.root) {
        const scroller = rootElement();
        scroller.scrollTop = vertical ? next : scroller.scrollTop;
        scroller.scrollLeft = vertical ? scroller.scrollLeft : next;
      } else if (vertical) {
        entry.el.scrollTop = next;
      } else {
        entry.el.scrollLeft = next;
      }
    };
    const onEnd = () => {
      entry.dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      revealThumb(entry);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
  }

  function createThumb(entry, axis) {
    const thumb = document.createElement('div');
    thumb.className = THUMB_CLASS;
    thumb.dataset.axis = axis;
    thumb.addEventListener('pointerdown', (event) => beginDrag(event, entry, axis));
    ensureLayer().appendChild(thumb);
    return thumb;
  }

  function ensureEntry(element) {
    const existing = entries.get(element);
    if (existing) return existing;
    if (isRoot(element)) {
      // WebKit paints the viewport bar from html or body depending on how
      // overflow propagates, so root coverage has to claim both.
      document.documentElement.setAttribute(ATTR, '');
      if (document.body) document.body.setAttribute(ATTR, '');
    } else {
      element.setAttribute(ATTR, '');
    }
    const entry = { el: element, vThumb: null, hThumb: null, metrics: null, hideTimer: 0, dragging: false };
    entry.vThumb = createThumb(entry, 'v');
    entry.hThumb = createThumb(entry, 'h');
    entries.set(element, entry);
    return entry;
  }

  function flush() {
    for (const entry of [...entries.values()]) {
      if (!entry.el.isConnected) forget(entry);
      else sync(entry, false);
    }
  }

  function scheduleFlush() {
    if (scheduled) return;
    scheduled = requestFrame(() => {
      scheduled = 0;
      flush();
    });
  }

  function onScroll(event) {
    if (!enabled) return;
    const target = event.target;
    let element = null;
    if (target === document || target === window || isRoot(target)) {
      element = rootElement();
    } else if (target instanceof Element) {
      element = target;
    }
    if (!element) return;
    revealThumb(ensureEntry(element));
    scheduleFlush();
  }

  /** Host-side diagnosis lives up there in the dark: report what this document
   * measured so a bar that stays native is visible in the host console. */
  function report() {
    const scroller = rootElement();
    const root = document.documentElement;
    const computed = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
    const status = {
      gutter: rootGutter(),
      styled: Boolean(styleNode || styleSheet),
      escalated: Boolean(styleNode),
      scrollers: entries.size,
      suppressed: rootSuppressed,
      // Which strategy is carrying the document, and what the engine says about
      // the bar it refuses to collapse.
      mode: bodyScroller ? 'body-scroller' : 'viewport',
      scroller: scroller === document.body ? 'body' : 'html',
      overflowY: computed ? computed.overflowY : 'n/a',
      scrollbarWidth: computed ? (computed.scrollbarWidth || 'n/a') : 'n/a',
      innerWidth: window.innerWidth,
      clientWidth: root.clientWidth,
      htmlWidth: Math.round(root.getBoundingClientRect().width),
      bodyWidth: document.body ? Math.round(document.body.getBoundingClientRect().width) : 0,
      visualWidth: window.visualViewport ? Math.round(window.visualViewport.width) : 0,
      zoom: window.outerWidth ? Math.round((window.outerWidth / window.innerWidth) * 100) / 100 : 1,
      dpr: window.devicePixelRatio,
      rules: styleNode && styleNode.sheet ? styleNode.sheet.cssRules.length : 0,
    };
    const key = JSON.stringify(status);
    if (key === reported) return;
    reported = key;
    try {
      window.parent.postMessage({ type: STATUS_TYPE, ...status }, '*');
    } catch {
      // Detached frames cannot reach the host; nothing to report.
    }
  }

  function scheduleVerify(pass) {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => verify(pass), pass === 0 ? 0 : VERIFY_RETRY_MS);
  }

  function verify(pass) {
    if (!started) return;
    const scroller = rootElement();
    // Both axes count: a horizontally-wide document deserves the same
    // gutter-free treatment as a tall one.
    const scrolling = scroller.scrollHeight > scroller.clientHeight + 1
      || scroller.scrollWidth > scroller.clientWidth + 1;
    if (!scrolling || rootGutter() <= 1) {
      if (rootSuppressed) {
        // The bar collapsed after all (window resize, late layout): take the
        // viewport back without waiting for a reload.
        rootSuppressed = false;
        const root = entries.get(rootElement());
        if (root) sync(root, false);
      }
      report();
      return;
    }
    if (pass < VERIFY_PASSES - 1) {
      // The constructed sheet is what some engines quietly ignore; the author
      // sheet is re-added as the escalation before giving up on the viewport.
      if (pass === 1) appendStyleNode(overlayCss());
      scheduleVerify(pass + 1);
      return;
    }
    // Stylesheets exhausted. Hand the scroll to <body>, whose bar is an element
    // scrollbar and therefore always collapses, then measure again.
    if (!bodyScroller) {
      applyViewportFallback();
      scheduleVerify(pass);
      return;
    }
    // Keep the stylesheet (element scrollers still benefit) and the listener, so
    // a later resize or a shorter document can still recover.
    rootSuppressed = true;
    const root = entries.get(rootElement());
    if (root) sync(root, false);
    report();
  }

  function start() {
    if (started || !enabled) return;
    started = true;
    ensureStyle();
    ensureLayer();

    const root = rootElement();
    sync(ensureEntry(root), false);
    // Take over containers that are already scrollable so the first wheel tick
    // does not visibly reflow the page when the native bar disappears. Huge
    // documents bail out early; later containers are adopted on first scroll.
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deadline = now() + 12;
    let checked = 0;
    for (const element of document.querySelectorAll('*')) {
      if ((++checked & 127) === 0 && now() > deadline) break;
      if (element === root || element === layer || element === document.body) continue;
      if (element.classList && element.classList.contains(THUMB_CLASS)) continue;
      if (element.scrollHeight - element.clientHeight > 1 || element.scrollWidth - element.clientWidth > 1) {
        sync(ensureEntry(element), false);
      }
    }

    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize);

    scheduleVerify(0);
  }

  function onResize() {
    scheduleFlush();
    if (rootSuppressed) scheduleVerify(0);
  }

  function teardown() {
    clearTimeout(verifyTimer);
    verifyTimer = 0;
    for (const entry of [...entries.values()]) forget(entry);
    entries.clear();
    if (layer) layer.remove();
    if (styleNode) styleNode.remove();
    if (bodyScroller) clearInlineFallbackStyles();
    bodyScroller = false;
    if (styleSheet) {
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== styleSheet);
      } catch {
        // Detached documents reject stylesheet updates; the sheet dies with them.
      }
    }
    layer = null;
    styleNode = null;
    styleSheet = null;
    started = false;
    rootSuppressed = false;
    reported = '';
    document.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('readystatechange', scheduleFlush);
    window.removeEventListener('resize', onResize);
  }

  function onMessage(event) {
    if (event.source !== window.parent) return;
    const config = event.data;
    if (!config || config.type !== CONFIG_TYPE) return;
    if (typeof config.mac === 'boolean') mac = config.mac;
    if (typeof config.enabled === 'boolean' && config.enabled !== enabled) {
      enabled = config.enabled;
      if (!enabled) {
        teardown();
        return;
      }
    }
    if (!enabled) return;
    if (typeof config.color === 'string' && config.color
        && (!window.CSS || typeof CSS.supports !== 'function' || CSS.supports('color', config.color))) {
      color = config.color;
      if (layer) layer.style.color = color;
    }
    if (started) scheduleFlush();
    else start();
  }

  document.addEventListener('readystatechange', scheduleFlush);
  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) teardown();
  });

  // The hiding stylesheet lands at document start: an init script runs before
  // the engine paints anything, so the native bar and its gutter never get a
  // frame. Waiting for DOMContentLoaded (or the host's config) let them flash
  // for the whole parse of a large document. Thumbs and measurement stay in
  // start(); this only needs to exist, not to measure.
  ensureStyle();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
  try {
    window.parent.postMessage({ type: READY_TYPE }, '*');
  } catch {
    // Detached frames cannot reach the host; nothing to configure.
  }
})();
