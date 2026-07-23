import { Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const TAG_REGEX = /(?<=^|\n|\s)#((?:[^/\s\p{P}]+\/)*[^/\s\p{P}]+)/gu

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
        key: new PluginKey('tag'),
        props: {
          decorations(state) {
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
              const fromChar = match.index!
              const toChar = fromChar + match[0].length
              const fromPM = charToPM[fromChar]
              const toPM = charToPM[toChar - 1] + 1
              if (fromPM < 0 || toPM <= 0) continue
              decorations.push(Decoration.inline(fromPM, toPM, { class: 'tag-node' }))
            }
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
