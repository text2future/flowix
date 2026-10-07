import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { BundledLanguage, BundledTheme } from 'shiki'

import { findChildren } from '@tiptap/core'

import { createHighlighterCore } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'

import { getShikiLanguageDefinition, SHIKI_THEMES } from './shiki-languages'

// createHighlighterCore 返回 HighlighterCore, 类型从 shiki/core 推导,
// 避免额外引入 shiki 全量包的类型面。
type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighterCore>>

let highlighter: ShikiHighlighter | undefined
let highlighterPromise: Promise<void> | undefined
const languagePromises = new Map<string, Promise<boolean>>()

export function getShiki() {
  return highlighter
}

/**
 * Load the highlighter once. Uses Shiki's fine-grained core (no bundled
 * languages/themes) with the curated language + theme set and the same
 * Oniguruma WASM engine that shiki's full `createHighlighter` uses internally.
 *
 * Themes are tiny and shared, so they load with the core. Language grammars are
 * deliberately omitted and loaded one at a time by {@link loadLanguage}.
 */
export async function loadHighlighter() {
  if (highlighter) return

  if (!highlighter && !highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: SHIKI_THEMES,
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).then((h) => {
      highlighter = h
    }).catch((error) => {
      // A transient chunk/WASM load failure must not poison every later attempt.
      highlighterPromise = undefined
      throw error
    })
  }

  return highlighterPromise
}

/**
 * Loads a theme if it's valid and not yet loaded.
 * Curated themes are all preloaded in {@link loadHighlighter}; nothing to do.
 */
export async function loadTheme(_theme: BundledTheme): Promise<boolean> {
  return false
}

/**
 * Load one curated language grammar. Concurrent requests for aliases of the
 * same canonical language share a promise. Unsupported languages retain the
 * existing plaintext fallback.
 */
export async function loadLanguage(language: BundledLanguage | string): Promise<boolean> {
  const definition = getShikiLanguageDefinition(language)
  if (!definition) return false

  await loadHighlighter()
  if (!highlighter) return false
  if (highlighter.getLoadedLanguages().includes(definition.id)) return false

  let pending = languagePromises.get(definition.id)
  if (!pending) {
    pending = definition.load()
      .then(async (registrations) => {
        await highlighter?.loadLanguage(...registrations)
        return true
      })
      .finally(() => {
        languagePromises.delete(definition.id)
      })
    languagePromises.set(definition.id, pending)
  }
  return pending
}

interface InitHighlighterOptions {
  doc: ProseMirrorNode
  name: string
  language: BundledLanguage | 'plaintext' | null
  theme: BundledTheme
  themes?: BundledTheme[]
}

/**
 * Initializes the highlighter based on the prose-mirror document, with the
 * themes and languages in the document.
 */
export async function initHighlighter({
  doc,
  name,
  language,
}: InitHighlighterOptions) {
  const codeBlocks = findChildren(doc, node => node.type.name === name)
  if (codeBlocks.length === 0 && language === 'plaintext') return

  await loadHighlighter()

  const languages = new Set<string>()
  if (language && language !== 'plaintext') languages.add(language)
  for (const block of codeBlocks) {
    const blockLanguage = block.node.attrs.language
    if (typeof blockLanguage === 'string' && blockLanguage && blockLanguage !== 'plaintext') {
      languages.add(blockLanguage)
    }
  }
  await Promise.all([...languages].map((currentLanguage) => loadLanguage(currentLanguage)))
}
