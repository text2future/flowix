import { Mark, mergeAttributes } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { isValidTagPath } from '@/lib/tag-path'

const TAG_REGEX = /(?<=^|\n|\s)#((?:(?:[-_]|[^/\s\p{P}])+\/)*(?:[-_]|[^/\s\p{P}])+)/gu

function createTagDecorations(state: { doc: ProseMirrorNode }): DecorationSet {
  let plainText = ''
  const charToPM: number[] = []
  const appendSep = (ch: string) => {
    if (plainText.length === 0) return
    charToPM.push(-1)
    plainText += ch
  }
  const hasCodeMark = (
    node: { marks: ReadonlyArray<{ type: { name: string } }> },
  ) => node.marks.some((mark) => mark.type.name === 'code')

  state.doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (hasCodeMark(node)) {
        appendSep('\n')
        return true
      }
      for (let index = 0; index < node.text.length; index += 1) {
        charToPM.push(pos + index)
      }
      plainText += node.text
    } else if (node.isBlock) {
      appendSep('\n')
      if (node.type.name === 'codeBlock') return false
    } else if (node.isLeaf) {
      appendSep(' ')
    }
    return true
  })

  const decorations: Decoration[] = []
  for (const match of plainText.matchAll(TAG_REGEX)) {
    if (!isValidTagPath(match[1])) continue
    const fromChar = match.index!
    const toChar = fromChar + match[0].length
    const fromPM = charToPM[fromChar]
    const toPM = charToPM[toChar - 1] + 1
    if (fromPM < 0 || toPM <= 0) continue
    decorations.push(Decoration.inline(fromPM, toPM, { class: 'tag-node' }))
    // Split the live range at `#` so its following gap can be styled without
    // inserting a real space or making the text an atom.
    decorations.push(Decoration.inline(fromPM, fromPM + 1, {
      class: 'tag-node-prefix',
    }))
    decorations.push(Decoration.inline(fromPM + 1, toPM, {
      class: 'tag-node-content',
    }))
  }
  return DecorationSet.create(state.doc, decorations)
}

const tagDecorationPluginKey = new PluginKey<DecorationSet>('tag-decoration')

export const Tag = Mark.create({
  name: 'tag',

  parseHTML() {
    return [{ tag: 'span.tag-node' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'tag-node' }), 0]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tagDecorationPluginKey,
        state: {
          init: (_, state) => createTagDecorations(state),
          apply: (transaction, value, _oldState, newState) => (
            transaction.docChanged ? createTagDecorations(newState) : value
          ),
        },
        props: {
          decorations(state) {
            return tagDecorationPluginKey.getState(state) ?? DecorationSet.empty
          },
        },
      }),
    ]
  },
})
