import type { BundledLanguage } from 'shiki'

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
