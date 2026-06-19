import type { BundledLanguage, BundledTheme } from 'shiki'

import { findChildren } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

import { getDecorations } from './shiki-decorations'
import { getShiki, initHighlighter } from './shiki-highlighter'

export interface PluginShikiOptions {
  name: string
  defaultLanguage: BundledLanguage | 'plaintext' | null | undefined
  defaultTheme: BundledTheme
  preloadThemes?: BundledTheme[]
}

export function proseMirrorPluginShiki(options: PluginShikiOptions) {
  const { name, defaultLanguage, defaultTheme, preloadThemes = [] } = options

  const shikiPlugin: Plugin = new Plugin({
    key: new PluginKey('codeBlockShiki'),

    state: {
      init: (_, { doc }) => {
        return getDecorations({ doc, name, defaultLanguage, defaultTheme })
      },

      apply: (transaction, decorationSet, oldState, newState) => {
        const oldNodeName = oldState.selection.$head.parent.type.name
        const newNodeName = newState.selection.$head.parent.type.name

        const oldNodes = findChildren(oldState.doc, node => node.type.name === name)
        const newNodes = findChildren(newState.doc, node => node.type.name === name)

        const didChangeSomeCodeBlock = transaction.docChanged && (
          [oldNodeName, newNodeName].includes(name)
          || newNodes.length !== oldNodes.length
          || transaction.steps.some((step: any) => {
            return (step.from !== undefined && step.to !== undefined
              && oldNodes.some((node) => {
                return (
                  node.pos >= step.from
                  && node.pos + node.node.nodeSize <= step.to
                )
              })
            )
          }))

        if (transaction.getMeta('shikiPluginForceDecoration') || didChangeSomeCodeBlock) {
          return getDecorations({
            doc: transaction.doc,
            name,
            defaultLanguage,
            defaultTheme
          })
        }

        return decorationSet.map(transaction.mapping, transaction.doc)
      }
    },

    props: {
      decorations(state) {
        return shikiPlugin.getState(state)
      }
    },

    // Lazy Shiki bootstrap: editor mount stays synchronous. Only documents that
    // actually contain code blocks import Shiki and load grammars/themes.
    view(editorView) {
      let cancelled = false
      let pending = false
      let needsRerun = false
      let idleId: number | null = null
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      const hasCodeBlocks = () => {
        return findChildren(editorView.state.doc, node => node.type.name === name).length > 0
      }

      const forceDecorations = () => {
        if (cancelled) return
        editorView.dispatch(
          editorView.state.tr.setMeta('shikiPluginForceDecoration', true)
        )
      }

      const loadForCurrentDoc = async () => {
        if (cancelled || pending || !hasCodeBlocks()) return
        pending = true
        needsRerun = false
        try {
          await initHighlighter({
            doc: editorView.state.doc,
            name,
            language: defaultLanguage ?? null,
            theme: defaultTheme,
            themes: preloadThemes,
          })
          forceDecorations()
        } catch (err) {
          console.error('[CodeBlockShiki] failed to initialize highlighter:', err)
        } finally {
          pending = false
          if (needsRerun) scheduleLoad()
        }
      }

      const scheduleLoad = () => {
        if (cancelled || !hasCodeBlocks()) return
        if (pending) {
          needsRerun = true
          return
        }
        if (idleId !== null || timeoutId !== null) return

        if ('requestIdleCallback' in window) {
          idleId = window.requestIdleCallback(() => {
            idleId = null
            void loadForCurrentDoc()
          }, { timeout: 1200 })
        } else {
          timeoutId = globalThis.setTimeout(() => {
            timeoutId = null
            void loadForCurrentDoc()
          }, 300)
        }
      }

      scheduleLoad()

      return {
        update(view, prevState) {
          const docChanged = prevState.doc !== view.state.doc
          if (!docChanged && getShiki()) return
          scheduleLoad()
        },
        destroy() {
          cancelled = true
          if (idleId !== null && 'cancelIdleCallback' in window) {
            window.cancelIdleCallback(idleId)
            idleId = null
          }
          if (timeoutId !== null) {
            globalThis.clearTimeout(timeoutId)
            timeoutId = null
          }
        }
      }
    }
  })

  return shikiPlugin
}
