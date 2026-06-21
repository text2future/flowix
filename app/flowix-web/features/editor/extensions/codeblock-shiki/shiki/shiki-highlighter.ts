import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { BundledLanguage, BundledTheme, Highlighter, BundledHighlighterOptions } from 'shiki'

import { findChildren } from '@tiptap/core'

let highlighter: Highlighter | undefined
let highlighterPromise: Promise<void> | undefined
let shikiModulePromise: Promise<typeof import('shiki')> | undefined
const loadingLanguages = new Set<BundledLanguage>()
const loadingThemes = new Set<BundledTheme>()

function loadShikiModule() {
  if (!shikiModulePromise) {
    shikiModulePromise = import('shiki')
  }
  return shikiModulePromise
}

export function getShiki() {
  return highlighter
}

/**
 * Load the highlighter. Makes sure the highlighter is only loaded once.
 * After creation, eagerly load all languages (Shiki v4 doesn't sync load them).
 */
export async function loadHighlighter(opts: BundledHighlighterOptions<BundledLanguage, BundledTheme>) {
  if (highlighter) return

  if (!highlighter && !highlighterPromise) {
    highlighterPromise = loadShikiModule().then(async ({ bundledLanguages, bundledThemes, createHighlighter }) => {
      const themes = (opts.themes as string[]).filter(
        (theme) => !!theme && (theme in bundledThemes)
      ) as BundledTheme[]
      const langs = (opts.langs as string[]).filter(
        (lang) => !!lang && (lang in bundledLanguages)
      ) as BundledLanguage[]

      const h = await createHighlighter({ themes, langs })
      highlighter = h
      // Eagerly load all languages since createHighlighter doesn't sync load them
      for (const lang of langs) {
        await h.loadLanguage(lang);
      }
    })
    return highlighterPromise;
  }

  if (highlighterPromise) {
    return highlighterPromise;
  }
}

/**
 * Loads a theme if it's valid and not yet loaded.
 * @returns true or false depending on if it got loaded.
 */
export async function loadTheme(theme: BundledTheme): Promise<boolean> {
  const { bundledThemes } = await loadShikiModule()
  if (
    highlighter
    && !highlighter.getLoadedThemes().includes(theme)
    && !loadingThemes.has(theme)
    && theme in bundledThemes
  ) {
    loadingThemes.add(theme);
    await highlighter.loadTheme(theme);
    loadingThemes.delete(theme);
    return true;
  }

  return false;
}

/**
 * Loads a language if it's valid and not yet loaded
 * @returns true or false depending on if it got loaded.
 */
export async function loadLanguage(language: BundledLanguage): Promise<boolean> {
  const { bundledLanguages } = await loadShikiModule()
  if (
    highlighter
    && !highlighter.getLoadedLanguages().includes(language)
    && !loadingLanguages.has(language)
    && language in bundledLanguages
  ) {
    loadingLanguages.add(language)
    await highlighter.loadLanguage(language)
    loadingLanguages.delete(language)
    return true
  }

  return false
}

interface InitHighlighterOptions {
  doc: ProseMirrorNode
  name: string
  language: BundledLanguage | 'plaintext' | null
  theme: BundledTheme
  themes?: BundledTheme[]
}

/**
 * Initializes the highlighter based on the prose-mirror document,
 * with the themes and languages in the document.
 */
export async function initHighlighter({
  doc,
  name,
  language,
  theme,
  themes: extraThemes = []
}: InitHighlighterOptions) {
  const codeBlocks = findChildren(doc, node => node.type.name === name)
  if (codeBlocks.length === 0 && language === 'plaintext') return

  const themes = [
    ...codeBlocks.map(block => block.node.attrs.theme as BundledTheme),
    ...extraThemes,
    theme
  ]
  const languages = [
    ...codeBlocks.map(block => block.node.attrs.language as BundledLanguage),
    language
  ]

  if (!highlighter) {
    const loader = loadHighlighter({ langs: languages as BundledLanguage[], themes: themes as BundledTheme[] })
    await loader
  } else {
    await Promise.all([
      ...themes.flatMap(theme => loadTheme(theme)),
      ...languages.flatMap(language =>
        language && language !== 'plaintext' ? loadLanguage(language) : []
      )
    ])
  }
}
