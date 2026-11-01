# Frame scrollbars

Work and Browser host two kinds of cross-origin documents: remote pages
(`<iframe src="https://…">`) and local HTML previews (`asset:`). Neither can be
reached from the host — `contentDocument` throws — so whatever bar the document
paints is its own. And when a document sets `::-webkit-scrollbar { width: 8px }`,
WebKit leaves overlay mode and the bar starts consuming layout width.

## Ownership model — who paints which bar

Every scrollbar on screen belongs to exactly one layer; nothing paints two bars
for one scroller:

- **Layer 0 — app containers.** Work columns, lists, sidebars use the in-app
  `OverlayScrollbar` component (`overlay-scrollbar.css`, 6px overlay thumb). A
  web surface must never make its host column scroll: the iframe is
  `h-full w-full` inside a `min-h-0 flex-1` wrapper, so the column has nothing
  to scroll and paints no bar. If a bar appears *outside* the iframe edge, that
  is a layout bug in the column, not a scrollbar problem.
- **Layer 1 — frame content.** Everything inside a first-level frame (remote
  pages and local previews alike) is owned by this script. The mechanism is
  origin-agnostic: `https://skills.flowix.cc`, any other remote page, and
  `asset:` previews all take the same path and were verified identical
  (gutter 0, thumb fades in on scroll, both axes).

Seeing two thin bars side by side therefore means one of: the frame bar (Layer 1)
plus a scrolling app column (Layer 0, layout bug), or the page was loaded before
the binary containing this script (the script is compiled in; hot reload cannot
deliver it). The frame's status message in the host console tells which layer
the frame itself is in — `gutter: 0` means the frame paints only its thumb.

## One script, injected into every frame

`flowix-desktop/src/web_frame_scrollbar.js` is registered as a Tauri
initialization script for all frames (`frame_scrollbar.rs`). WebKit and WebView2
run it inside each frame's own document, so it restyles cross-origin content from
the inside without any same-origin access.

Entry conditions — the script is inert everywhere else:

- not the top frame (`window === window.top`) — the app itself is never touched;
- not a nested frame (`window.parent !== window.top`) — embedded widgets and ad
  slots keep their own scrollbars;
- `http:`, `https:` or `asset:` only.

For each scroll container it adopts:

1. the element gets `data-flowix-overlay-scroll`, whose stylesheet sets
   `::-webkit-scrollbar { width: 0 }`, `scrollbar-width: none` and
   `scrollbar-gutter: auto` — the native bar stops taking width, and a page that
   reserved a stable gutter no longer keeps the empty strip;
2. a `position: fixed` thumb is painted into a single overlay layer, sized and
   placed from `scrollTop / scrollHeight / clientHeight` (and the horizontal
   equivalents), with the same 6px (macOS) / 9px (other) width and 24px minimum
   length the in-app `OverlayScrollbar` uses;
3. the thumb fades in while scrolling, stays for 700 ms, and is draggable.

Selector specificity is doubled (`:root:root::-webkit-scrollbar`) so a page rule
that styles its own bar through a class or an `!important` still loses. Body is
covered through attribute selectors (`body[ATTR][ATTR]`) — a doubled pseudo-class
like `body:body` is invalid CSS and would drop the whole rule, scrollbar hiding
included.

## Verifying instead of assuming

The hiding stylesheet is applied the moment the init script runs (document
start), before the engine paints anything — a large document never flashes its
native bar and gutter during parsing. Thumbs, measurement and the verify passes
still wait for the DOM to exist.

Whether the native bar actually collapsed can only be measured
(`innerWidth - documentElement.clientWidth`), and a layout read taken right
after the sheet lands can still report the bar it is about to remove. The script
therefore checks over four passes (~450 ms) before drawing conclusions, and
escalates on the second pass by appending its stylesheet as an author `<style>`
node — last child of `<html>`, so a page sheet that also uses `!important` loses
on order.

Both axes are first-class: the same `bounds(metrics, axis)` drives the vertical
and the horizontal thumb, `::-webkit-scrollbar` hiding covers width and height,
and verification counts horizontal overflow too.

If the viewport still reports a gutter after the last pass, the scroll leaves the
viewport entirely: `<html>` gets `overflow: hidden` and `<body>` becomes a fixed,
full-size scroller (`body-scroller` mode) that keeps scrolling on both axes. An
element scrollbar always collapses under the overlay stylesheet, so the gutter
disappears even when the engine refuses to restyle the viewport bar. The fallback rules are inlined on the
elements as well — inline `!important` beats any author rule and survives a
dropped `<style>` node — and are removed again on teardown. Only if even the
body bar refuses does the script stop painting the root thumb (`suppressed`);
the stylesheet and the scroll listener stay, so a resize or a shorter document
recovers without a reload. Element scrollers are unaffected by all of this.

The frame reports the outcome once per document
(`flowix:web-frame-scrollbar-status`) with `gutter`, `styled`, `escalated`,
`scrollers`, `suppressed`, `mode` (`viewport` / `body-scroller`) and layout
details (`scroller`, `overflowY`, `scrollbarWidth`, widths, `zoom`). `connectWebFrameScrollbar` logs it at debug level,
and warns only when `suppressed` is true — a bar that stayed native is otherwise
invisible to the host.

Native wheel, keyboard, trackpad and touch scrolling are untouched: no wheel
listener is installed and no `overflow` value is rewritten. Only the bar's
geometry changes.

Containers are adopted once at load — bounded by a 12 ms budget so very large
documents fall through to lazy adoption — and lazily afterwards, which covers SPA
content that appears later. Scrolling is watched through one capturing listener
on `document`, so containers Flowix never predicted still get a thumb.

## Host → frame channel

The frame cannot read the app's CSS variables, so `shared/ui/web-frame-scrollbar.ts`
posts only the palette it needs (`color`, `mac`). The frame asks first
(`flowix:web-frame-scrollbar-ready`); the host re-sends on `load` and on theme
changes. Nothing else crosses the boundary, and the page document is never read.

`enabled: false` in that payload tears the overlay down and restores the native
bar without reloading the frame.

## Verifying

```bash
npx vitest run app/flowix-web/shared/ui/web-frame-scrollbar.test.ts
```

The script is compiled into the binary, so changes need a desktop
rebuild/restart — frontend hot reload cannot replace the initialization script.

## Known limits

- Frames nested inside the page keep native bars by design.
- Documents whose scrolling is driven entirely by script (canvas editors,
  virtualized lists with no native overflow) have no bar to replace.
- A document that pins its layout to `clientWidth` will reflow once, when the
  bar's width is reclaimed. That reflow is the point of the change.
- Same-origin surfaces that inject CSS themselves (plugin artifacts, via
  `iframeScrollbarCss`) still use a narrow native bar; they are not frames the
  initialization script reaches.
