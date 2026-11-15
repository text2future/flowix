# Theme tokens

Each resolved theme owns a complete set of semantic tokens in its CSS file.
Light defines the `:root` fallback; the other palettes apply via `data-theme` on
the document. Components consume semantic roles instead of a particular
theme's colors. Keep token names consistent across themes and preserve distinct
roles even when their current values match.

- `--background`, `--card`, `--popover`, `--input-bg`, `--document-bg`,
  `--agent-bg`, `--frame-bg`, and `--list-bg` describe different surfaces.
- `--foreground`, `--muted-foreground`, `--document-foreground` and
  `--primary-foreground` describe text on their respective surfaces.
- `--primary` is a control color; `--brand` is the accent and can differ from
  it. Do not assume their foreground colors are interchangeable in new UI.
- `--info`, `--success`, `--warning`, and `--destructive` represent states.
  `--info` is also used for selections and borders. Its white foreground must
  have at least 4.5:1 contrast for normal text.
- `--document-tag-bg` contributes to property-tag hover; the editor's
  `--document-tag-background` is a separate fill defined in `editor.css`.
- Memo colors, document links, Shiki, and window material have separate roles;
  check their consumers before merging or removing a token.

Keep component rules in their owning stylesheet. Use theme-specific selectors
only for behavior that cannot be expressed with semantic tokens. Changes to
selectors or import order require checking the compiled CSS cascade.

When adding or changing a theme, check the CSS palette, `lib/theme/palette.ts`,
`lib/theme/options.ts` preview, preferences display order, shortcut cycle,
`public/theme-boot.js`, critical first-paint colors in `index.html`, and desktop
theme/window colors. The first-paint allowlist intentionally excludes the gated
Mist theme until entitlement is verified. Run the theme contract test and check
the main window, editor, dialogs, Agent and tables in light and dark themes.
