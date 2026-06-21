import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { BundledLanguage, BundledTheme } from 'shiki'

import { findChildren } from '@tiptap/core'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { getShiki } from '@features/editor/extensions/codeblock-shiki/shiki/shiki-highlighter'

// ── 非 shiki 语言白名单 ──────────────────────────────────────────────
//
// 这些语言有自己的渲染管线 (NodeView), 不消费 shiki 的颜色 token ──
// 跳过 tokenize + 颜色 inline decoration 构造, 纯省 work。当前只有
// mermaid, 用 Set 数据驱动, 未来加 plantuml / vega-lite 等同族语言
// 直接扩 Set 即可, 不需要分散改条件分支。
const NON_SHIKI_LANGUAGES = new Set(['mermaid'])

interface DecorationsOptions {
  doc: ProseMirrorNode
  name: string
  defaultTheme: BundledTheme
  defaultLanguage: BundledLanguage | 'plaintext' | null | undefined
}

// ── --shiki-theme CSS var 缓存 ────────────────────────────────────
//
// 该 var 由 useApplyTheme 在 app 主题切换时改写, 编辑过程中静态。
// 旧实现每次 getDecorations() 都直接 getComputedStyle(documentElement),
// 而该调用在存在 pending layout 的场景会强制同步 reflow ──
//
//   keystroke → transaction → apply() → getDecorations() → getComputedStyle
//   ────────────────── 同一调用栈, reflow 阻断后续代码 ──────────────────
//
// 1000 行代码块连续输入时, reflow 跟 tokenize 串联叠加, 主线程被
// 长时间占用。缓存读取结果, 把读路径退化成一个普通变量访问, 消
// 除 reflow。
//
// 失效时机 ── 由 shiki-plugin.ts 在 view() 挂载时挂 per-editor
// 'app-theme-changed' 监听器, 切主题时同步 invalidate + dispatch
// forceDecoration 触发 apply 重算。本模块自身不挂监听器 ── 缓存
// 与失效职责分离: 本文件管「读 + 缓存 + 暴露失效接口」, plugin
// 决定「何时失效」(只有 plugin 持有 editorView 引用, 才能在失
// 效后强制刷新装饰)。
let cachedCssTheme: string | null | undefined = undefined

function readCssTheme(): string {
  if (cachedCssTheme !== undefined) return cachedCssTheme ?? ''
  if (typeof document === 'undefined') {
    cachedCssTheme = null
    return ''
  }
  cachedCssTheme = getComputedStyle(document.documentElement)
    .getPropertyValue('--shiki-theme')
    .trim()
  return cachedCssTheme ?? ''
}

/** 失效缓存 ── 由 shiki-plugin 在收到 app-theme-changed 时调用,
 *  并伴随一次 shikiPluginForceDecoration dispatch 强制刷新装饰。
 *  Export 是因为 plugin 是同模块的兄弟文件, 需要 import 这个
 *  失效函数。 */
export function invalidateShikiThemeCache() {
  cachedCssTheme = undefined
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
    // Mermaid 等非 shiki 语言走 NodeView 自己的渲染管线, 不消费
    // shiki 的颜色 token ── 早 return 跳过 tokenize + 颜色 inline
    // decoration 构造, 纯省 work。
    if (NON_SHIKI_LANGUAGES.has((block.node.attrs.language || '').toLowerCase())) return

    const highlighter = getShiki()
    if (!highlighter) return

    const highlightLines = new Set<string>(block.node.attrs.highlightLines || [])
    // 行号显示开关 ── 节点未声明 showLineNumbers 时 (当前 @tiptap/
    // extension-code-block 默认不提供此 attr), 视为 true 保持
    // 现状; 显式 false 时跳过 widget 创建, 让 1000 行块少 1000
    // 个 widget DOM 节点 + 1000 次 cloneNode, 直接减半。
    const showLineNumbers = block.node.attrs.showLineNumbers !== false
    let language = block.node.attrs.language || defaultLanguage

    if (!highlighter.getLoadedLanguages().includes(language)) {
      language = 'plaintext'
    }

    let theme = block.node.attrs.theme || defaultTheme
    // Theme resolution: CSS var (app theme) > node attr (per-block override) > hardcoded default.
    // Reading --shiki-theme from :root lets useApplyTheme drive code-block colors;
    // node.attrs.theme remains in the schema for forward-compat (future per-block picker).
    // 读路径走 readCssTheme() 缓存, 避免每个 keystroke 触发 getComputedStyle 强制 reflow。
    const cssTheme = readCssTheme()
    if (cssTheme) theme = cssTheme as BundledTheme
    const themeToApply = highlighter.getLoadedThemes().includes(theme)
      ? theme
      : highlighter.getLoadedThemes()[0]

    const lines = highlighter.codeToTokensBase(block.node.textContent, {
      lang: language,
      theme: themeToApply
    })

    let from = block.pos + 1

    lines.forEach((lineTokens, index) => {
      const lineIndex = String(index + 1)
      const highlighted = highlightLines.has(lineIndex)

      // 行号 widget ── 用 spec.key 让 ProseMirror 跨 getDecorations()
      // 调用复用 DOM, 避免每帧重建 1000 个 widget 节点。key 由「行
      // 文本 + highlight 状态」组成 ── 未编辑的行 key 稳定, ProseMirror
      // 走 placeWidget 的「matchesWidget」分支直接 move DOM, 不调
      // factory, 不创建新 span; 只有被编辑的行 (lineText 变化)
      // 或 highlight 状态变化的行才触发 unmount+mount。
      //
      // 1000 行块连续输入时从「每帧 1000 unmount+mount」降到「每
      // 帧 1 次 (被编辑的行) + 999 次 DOM move」。
      if (showLineNumbers && typeof document !== 'undefined') {
        const lineText = lineTokens.map(t => t.content).join('')
        const widgetKey = `${lineText}|${highlighted ? 1 : 0}`

        decorations.push(Decoration.widget(
          from,
          () => {
            const span = document.createElement('span')
            span.classList.add('line-number')
            span.setAttribute('line', lineIndex)
            if (highlighted) span.classList.add('highlighted')
            return span
          },
          {
            key: widgetKey,
            side: -1,
            ignoreSelection: true,
            // 通用 destroy ── 接收 ProseMirror 挂载的实际 DOM, 不
            // 闭包捕获 span (避免每帧保留旧 span 引用, 让 GC 回收)。
            destroy: (dom: Node) => { dom.parentNode?.removeChild(dom) },
          }
        ))
      }

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
