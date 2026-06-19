import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { BundledLanguage, BundledTheme } from 'shiki'

import { findChildren } from '@tiptap/core'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { getShiki } from './shiki-highlighter'

interface DecorationsOptions {
  doc: ProseMirrorNode
  name: string
  defaultTheme: BundledTheme
  defaultLanguage: BundledLanguage | 'plaintext' | null | undefined
}

export function getDecorations({
  doc,
  name,
  defaultTheme,
  defaultLanguage
}: DecorationsOptions) {
  const decorations: Decoration[] = []

  const codeBlocks = findChildren(doc, node => node.type.name === name)

  codeBlocks.forEach((block) => {
    const highlighter = getShiki()
    if (!highlighter) return

    const highlightLines = new Set<string>(block.node.attrs.highlightLines || [])
    let language = block.node.attrs.language || defaultLanguage

    if (!highlighter.getLoadedLanguages().includes(language)) {
      language = 'plaintext'
    }

    let theme = block.node.attrs.theme || defaultTheme
    // Theme resolution: CSS var (app theme) > node attr (per-block override) > hardcoded default.
    // Reading --shiki-theme from :root lets useApplyTheme drive code-block colors;
    // node.attrs.theme remains in the schema for forward-compat (future per-block picker).
    const cssTheme = typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--shiki-theme').trim()
      : ''
    if (cssTheme) theme = cssTheme as BundledTheme
    const themeToApply = highlighter.getLoadedThemes().includes(theme)
      ? theme
      : highlighter.getLoadedThemes()[0]

    const lines = highlighter.codeToTokensBase(block.node.textContent, {
      lang: language,
      theme: themeToApply
    })

    let from = block.pos + 1

    const baseSpan = document.createElement('span')
    baseSpan.innerText = '​'

    lines.forEach((lineTokens, index) => {
      const lineIndex = String(index + 1)
      const span = baseSpan.cloneNode(true) as HTMLElement
      span.classList.add('line-number')
      span.setAttribute('line', lineIndex)

      if (highlightLines.has(lineIndex)) span.classList.add('highlighted')

      const decoration = Decoration.widget(from, () => span, {
        side: -1,
        ignoreSelection: true,
        destroy() {
          span.remove()
        }
      })
      decorations.push(decoration)

      for (const token of lineTokens) {
        const to = from + token.content.length

        const decoration = Decoration.inline(from, to, {
          style: `color: ${token.color}`
        })

        decorations.push(decoration)
        from = to
      }

      from += 1
    })
  })

  return DecorationSet.create(doc, decorations)
}
