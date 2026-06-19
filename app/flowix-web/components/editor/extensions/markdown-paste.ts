import { Extension, markPasteRule, nodePasteRule, PasteRule, type Editor, type JSONContent } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { tryMatchPhysicalMemoPath } from './note-reference'

const FENCED_CODE_BLOCK_RE = /(^|\r?\n)(```|~~~)[^\r\n]*\r?\n[\s\S]*?\r?\n\2(?=\r?\n|$)/
const CODE_MARK = 'code'
const CODE_BLOCK = 'codeBlock'

/**
 * Patterns that signal "this plain text is actually markdown source".
 * Each entry looks for block-level markdown syntax at the start of a line.
 */
const MARKDOWN_BLOCK_PATTERNS: RegExp[] = [
  /(^|\r?\n)#{1,6}\s+\S/,                  // ATX headings: "# Heading"
  /(^|\r?\n)\s{0,3}[-*+]\s+\S/,             // unordered list items
  /(^|\r?\n)\s{0,3}\d+[.)]\s+\S/,           // ordered list items
  /(^|\r?\n)\s{0,3}[-*+]\s+\[[ xX]\]\s+/,   // task list items
  /(^|\r?\n)>\s+/,                          // blockquotes
  /(^|\r?\n)```/,                           // fenced code block (opening)
  /(^|\r?\n)~~~/,                           // fenced code block (opening)
  /(^|\r?\n)\s{0,3}[-*_]{3,}\s*(?:\r?\n|$)/, // horizontal rules
  /(^|\r?\n)\|.*\|/,                        // pipe tables
]

/**
 * Block-level HTML tags whose presence in the clipboard signals that the
 * source already provided rich-text formatting worth preserving. `<p>` and
 * `<br>` alone are intentionally excluded — most editors wrap any text in
 * them, so they don't carry real structural information.
 */
const RICH_HTML_RE = /<(?:h[1-6]|ul|ol|li|blockquote|pre|table|hr|img|figure)\b/i

function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_BLOCK_PATTERNS.some(pattern => pattern.test(text))
}

function normalizeCodeMarks(node: JSONContent, parentType?: string): JSONContent {
  const normalized: JSONContent = { ...node }

  if (parentType === CODE_BLOCK) {
    delete normalized.marks
  } else if (normalized.type === 'text' && normalized.marks?.some(mark => mark.type === CODE_MARK)) {
    normalized.marks = normalized.marks.filter(mark => mark.type === CODE_MARK)
  }

  if (normalized.content) {
    normalized.content = normalized.content.map(child => normalizeCodeMarks(child, normalized.type))
  }

  return normalized
}

function parseMarkdownForPaste(markdown: string, editor: Editor): JSONContent | string {
  const parsed = editor.markdown?.parse(markdown)
  return parsed ? normalizeCodeMarks(parsed) : markdown
}

export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('markdownPasteCodeBlock'),
        props: {
          handlePaste: (_view, event) => {
            const clipboardData = event.clipboardData
            if (!clipboardData) return false

            const text = clipboardData.getData('text/plain') ?? ''
            const html = clipboardData.getData('text/html') ?? ''

            if (!text) return false

            // 单行绝对路径且命中当前已知 notebook 中某条 memo → 转 noteReference 卡片。
            // 这一步走同步路径 (notebook 缓存在 App.tsx 顶层 prewarm), 拦截在所有
            // 其它粘贴规则之前; 不命中时 return false 把控制权交回原有链路。
            const trimmed = text.trim()
            if (trimmed && !/[\r\n]/.test(trimmed)) {
              const hit = tryMatchPhysicalMemoPath(trimmed)
              if (hit && this.editor.schema.nodes.noteReference) {
                event.preventDefault()
                this.editor.commands.insertContent({
                  type: 'noteReference',
                  attrs: hit,
                })
                return true
              }
            }

            // If the clipboard carries meaningful rich-text HTML (lists, tables,
            // headings, images, etc.) let Tiptap's default paste path render it,
            // preserving formatting from sources like web pages and rich editors.
            if (html.trim() && RICH_HTML_RE.test(html)) {
              return false
            }

            // Treat the plain text as markdown when it contains a complete fenced
            // code block, or any other block-level markdown syntax (headings,
            // lists, blockquotes, tables, hr, …). This is the path that turns
            // plain-text markdown pasted from a chat, .md file, or other editor
            // into a real structured document.
            if (!FENCED_CODE_BLOCK_RE.test(text) && !looksLikeMarkdown(text)) {
              return false
            }

            event.preventDefault()
            const markdown = text.replace(/\r\n/g, '\n')
            return this.editor.commands.insertContent(parseMarkdownForPaste(markdown, this.editor))
          },
        },
      }),
    ]
  },

  addPasteRules(): PasteRule[] {
    const schema = this.editor.schema
    const rules: PasteRule[] = [
      // Bold: **text**
      markPasteRule({
        find: /\*\*([^*]+)\*\*/g,
        type: schema.marks.strong,
      }),
      // Italic: *text* or _text_
      markPasteRule({
        find: /\*([^*]+)\*/g,
        type: schema.marks.em,
      }),
      markPasteRule({
        find: /_([^_]+)_/g,
        type: schema.marks.em,
      }),
      // Inline code: `code`
      markPasteRule({
        find: /`([^`]+)`/g,
        type: schema.marks.code,
      }),
      // Strikethrough: ~~text~~
      markPasteRule({
        find: /~~([^~]+)~~/g,
        type: schema.marks.strike,
      }),
    ]

    // File Card: [filename](asset://...) - must be before general link rule
    if (schema.nodes.uploadFileCard) {
      rules.push(nodePasteRule({
        find: /\[([^\]]+)\]\((asset:\/\/[^)]+)\)/g,
        type: schema.nodes.uploadFileCard,
        getAttributes: match => ({
          name: match[1],
          url: match[2],
        }),
      }))
    }

    // Image: ![alt](src) - but handle asset:// URLs separately
    if (schema.nodes.image) {
      rules.push(nodePasteRule({
        find: /!\[([^\]]*)\]\((?!asset:\/\/)([^)]+)\)/g,
        type: schema.nodes.image,
        getAttributes: match => ({
          src: match[2],
          alt: match[1],
        }),
      }))
    }

    // Image from asset URL: ![alt](asset://...)
    if (schema.nodes.image) {
      rules.push(nodePasteRule({
        find: /!\[([^\]]*)\]\((asset:\/\/[^)]+|https?:\/\/asset\.localhost\/[^)]+)\)/g,
        type: schema.nodes.image,
        getAttributes: match => ({
          src: match[2],
          alt: match[1] || null,
          title: null,
          storageMode: 'attachment',
          storageKey: decodeURIComponent(match[2].replace('asset://localhost/', '').replace('http://asset.localhost/', '').replace('https://asset.localhost/', '')),
        }),
      }))
    }

    return rules
  },
})

export default MarkdownPaste
