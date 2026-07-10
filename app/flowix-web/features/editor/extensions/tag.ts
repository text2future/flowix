import { Mark, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

// A `#tag` is only a tag when the `#` is at the start of the line or follows
// a whitespace character. Inline `#` (e.g. "哈哈#哈哈") is not a tag.
// The `(?<=^|\n|\s)` lookbehind covers the three line-start cases:
//   ^  — first char of the document
//   \n — start of a new block / line
//   \s — any whitespace (space, tab, …) before the `#`
//
// **路径式 tag**: 允许用 `/` 分隔的多段 (e.g. `#旅行/泰国/曼谷`)。
// 结构: (?:level\/)*level, 每个 level 不能含空白 / `/` / Unicode 标点。
// 末段不能以 `/` 收尾 — 尾部多余的 `/` 触发 regex 回溯, 留在 body
// 变孤儿文本 (宽容解析, 配合 mid-edit 场景)。后端
// [extract_tags_from_body] 走同源 regex, 单测覆盖 [#旅行/泰国/曼谷/]、
// [a//b] 等边界。
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
            // Walk the doc once to build a plain-text view alongside a
            // char-index → PM-position map. Separators are only inserted
            // when there is content before them, so a single-paragraph
            // doc has no leading newline — the `(?<=^|\n|\s)` lookbehind
            // handles the doc-start case via `^`.
            //
            // Tag 排除区:
            //  - codeBlock 节点: 容器型, 内含纯文本. 整块作为一个 block 边界
            //    (追加 \n) 后跳过内部, 防止 #tag 在代码示例里被装饰/被误提取.
            //  - inline `code` mark: 用户视角是"代码"而非"标签", 即使前缀
            //    是空白也不应触发 tag-node, 跳过该 text 的相应字符.
            let plainText = ''
            const charToPM: number[] = []
            const appendSep = (ch: string) => {
              if (plainText.length === 0) return
              charToPM.push(-1)
              plainText += ch
            }
            // inline `code` mark 的文本视为代码, 不参与 #tag 匹配
            const hasCodeMark = (node: { marks: ReadonlyArray<{ type: { name: string } }> }) =>
              node.marks.some(m => m.type.name === 'code')
            state.doc.descendants((node, pos) => {
              if (node.isText && node.text) {
                if (hasCodeMark(node)) {
                  // inline code: 文本占位为 \n, 让代码行与上下文仍以换行断开,
                  // 但字符位置映射为空 (-1), 后续 TAG_REGEX 不会命中这些字符.
                  appendSep('\n')
                  return true
                }
                for (let i = 0; i < node.text.length; i++) {
                  charToPM.push(pos + i)
                }
                plainText += node.text
              } else if (node.isBlock) {
                appendSep('\n')
                if (node.type.name === 'codeBlock') {
                  // 整块跳过: codeBlock 内的 \n 仍由 appendSep + 自身 isBlock
                  // 闭合时再次 appendSep 形成了上下分隔; 内部文本不进入匹配.
                  return false
                }
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
