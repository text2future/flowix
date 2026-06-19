import type { NodeView, ViewMutationRecord } from '@tiptap/pm/view'
import type { NodeViewRendererProps } from '@tiptap/core'
import svgPanZoom from 'svg-pan-zoom'

// svg-pan-zoom 实例类型 ── 库本身没有导出类型, 用 ReturnType 推断。
// 用在 fullscreen overlay 内 ── 用户的 mermaid 流程图常因节点多而显示
// 过小, 提供画布站式 pan/zoom (滚轮缩放围绕鼠标点 + 拖拽平移 + 双击
// 放大), 阅读体验大幅好于"看缩小版全图"。
type SvgPanZoomInstance = ReturnType<typeof svgPanZoom>

type CodeBlockViewMode = 'preview' | 'code'

const MERMAID_LANGUAGE = 'mermaid'

const MERMAID_PREVIEW_ICON = `<svg class="code-block-mode-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 3h20"></path>
  <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"></path>
  <path d="m7 21 5-5 5 5"></path>
</svg>`

const MERMAID_CODE_ICON = `<svg class="code-block-mode-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="m18 16 4-4-4-4"></path>
  <path d="m6 8-4 4 4 4"></path>
  <path d="m14.5 4-5 16"></path>
</svg>`

// 全屏 / 退出全屏按钮图标 ── Phosphor 风格 (256×256 viewBox, fill=currentColor),
// 与 agent-thread-card 的 fullscreen 图标同源 (复用其 ICON_FULLSCREEN_PATH /
// ICON_FULLSCREEN_EXIT_PATH), 保证编辑器内两处全屏按钮的视觉一致。viewBox
// 在 14×14 渲染尺寸下, fill 渲染比 stroke 视觉量级更稳 (与 __send / __open-panel
// 等实心图标同族)。
const FULLSCREEN_ENTER_ICON = '<svg class="code-block-fullscreen-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="currentColor" d="M40,96a8,8,0,0,1-8-8V48A16,16,0,0,1,48,32H88a8,8,0,0,1,0,16H48V88A8,8,0,0,1,40,96ZM208,32H168a8,8,0,0,0,0,16h40V88a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32ZM88,208H48V168a8,8,0,0,0-16,0v40a16,16,0,0,0,16,16H88a8,8,0,0,0,0-16Zm128-48a8,8,0,0,0-8,8v40H168a8,8,0,0,0,0,16h40a16,16,0,0,0,16-16V168A8,8,0,0,0,216,160Z"></path></svg>'

const FULLSCREEN_EXIT_ICON = '<svg class="code-block-fullscreen-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="currentColor" d="M96,40V80A16,16,0,0,1,80,96H40a8,8,0,0,1,0-16H80V40a8,8,0,0,1,16,0Zm120,40H176V40a8,8,0,0,0-16,0V80a16,16,0,0,0,16,16h40a8,8,0,0,0,0-16ZM80,176v40a8,8,0,0,0,16,0V176a16,16,0,0,0-16-16H40a8,8,0,0,0,0,16Zm136-16H176a16,16,0,0,0-16,16v40a8,8,0,0,0,16,0V176h40a8,8,0,0,0,0-16Z"></path></svg>'

// 全屏 overlay 内的 pan/zoom 工具条图标 ── Phosphor Minus / Plus / CornersOut
// (256×256 viewBox, fill=currentColor), 与现有 fullscreen 图标同源; 14×14
// 渲染尺寸与其它全屏按钮一致。
const ZOOM_OUT_ICON = '<svg class="code-block-fullscreen-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="currentColor" d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128Z"></path></svg>'

const ZOOM_IN_ICON = '<svg class="code-block-fullscreen-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path fill="currentColor" d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"></path></svg>'

type BundledLanguageInfo = {
  id: string
  name: string
}

let bundledLanguagesInfoPromise: Promise<readonly BundledLanguageInfo[]> | null = null

function loadBundledLanguagesInfo(): Promise<readonly BundledLanguageInfo[]> {
  if (!bundledLanguagesInfoPromise) {
    bundledLanguagesInfoPromise = import('shiki').then((module) => module.bundledLanguagesInfo)
  }
  return bundledLanguagesInfoPromise
}

export interface CodeBlockShikiViewOptions {
  name: string
  language: string | null
  theme: string
  showLineNumbers?: boolean
  highlightLines?: number[]
}

class CodeBlockShikiView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  view: NodeViewRendererProps['view']
  node: NodeViewRendererProps['node']
  options: CodeBlockShikiViewOptions
  getPosFn: () => number | null | undefined
  private isDropdownOpen: boolean = false
  private boundOutsideClickHandler: ((e: Event) => void) | null = null

  private header: HTMLElement | null = null
  private languageBtn: HTMLButtonElement | null = null
  private copyBtn: HTMLButtonElement | null = null
  private modeTabs: HTMLElement | null = null
  private previewTabBtn: HTMLButtonElement | null = null
  private codeTabBtn: HTMLButtonElement | null = null
  private dropdown: HTMLElement | null = null
  private dropdownPopulated = false
  private dropdownSearchInput: HTMLInputElement | null = null
  private dropdownList: HTMLElement | null = null
  private dropdownEmpty: HTMLElement | null = null
  private previewDOM: HTMLElement | null = null
  private actions: HTMLElement | null = null
  private fullscreenButton: HTMLButtonElement | null = null
  private viewMode: CodeBlockViewMode = 'code'
  private renderVersion = 0
  private lastRenderedSource: string | null = null
  private boundThemeChangeHandler: ((e: Event) => void) | null = null
  private boundSyncFullscreenBounds: (() => void) | null = null
  private boundHandleFullscreenKeydown: ((event: KeyboardEvent) => void) | null = null
  private isDestroyed = false
  private isFullscreen = false
  // 全屏 overlay ── 独立的 DOM 树, 挂在 document.body 上, 跟原
  // code-block-wrapper 解耦, 避免与 wrapper 自身的预览态 / 折叠态
  // 互相影响。fullscreenContainer 是 overlay 的"定位参照物"
  // (.document-container 的 bounds, 决定 overlay 覆盖哪片区域),
  // 不是 overlay 本身。fullscreenOverlay 才是真正的 DOM 节点。
  //
  // 全屏 DOM 树是两层 ── backdrop 是外层背景 (阻拦穿透点击, 提供
  // CSS vars), overlay 嵌在 backdrop 内 (实际可见的全屏卡片, 带
  // border / 圆角 / flex 居中)。backdrop 是位置的几何真源, 监听
  // resize 时 syncOverlayPositionTo 把 CSS vars 写到 backdrop 上,
  // overlay 沿 DOM 继承, 不再持有自己的位置信息。
  private fullscreenContainer: HTMLElement | null = null
  private fullscreenBackdrop: HTMLElement | null = null
  private fullscreenOverlay: HTMLElement | null = null
  private fullscreenResizeObserver: ResizeObserver | null = null
  // svg-pan-zoom 实例 ── 仅在全屏态下创建; destroy / NodeView 销毁 /
  // 退出全屏时调用 destroy() 解绑 SVG 上的 wheel / mouse / dblclick 监听。
  // zoomLabelBtn 是工具条中间按钮的引用, 用于 updateZoomLabel 在 onZoom
  // 回调里实时刷新百分比显示。toolbar 自身无需 JS 引用 ── overlay.remove()
  // 会带走所有子元素 (含 toolbar), 浏览器 GC 自动解绑其上 listener。
  private panZoomInstance: SvgPanZoomInstance | null = null
  private zoomLabelBtn: HTMLButtonElement | null = null

  constructor(props: NodeViewRendererProps) {
    const { view, node, getPos } = props
    this.view = view
    this.node = node
    this.getPosFn = getPos
    this.options = {
      name: node.type.name,
      showLineNumbers: node.attrs.showLineNumbers,
      highlightLines: node.attrs.highlightLines,
      language: node.attrs.language,
      theme: node.attrs.theme
    }

    this.dom = document.createElement('pre')
    this.contentDOM = document.createElement('code')

    this.createView()
    this.handleEvents()
  }

  private createView() {
    this.dom.classList.add('code-block-wrapper')
    this.dom.setAttribute('data-theme', this.options.theme || 'rose-pine-dawn')

    // Create header
    this.header = document.createElement('div')
    this.header.classList.add('code-block-header')
    // Chrome 元素声明 ── `contenteditable="false"` 阻断 ProseMirror 选区
    // / 文本光标从 contentDOM 渗入按钮 (e.g. languageBtn 内的 label span
    // 文本节点会被当成可编辑文本, 鼠标点选或方向键移动时 caret 落在按
    // 钮上); `tabindex="-1"` 让 Tab 不能聚焦到按钮 (避免键盘导航进
    // 入)。两者必须同设 ── contenteditable=false 不阻止 button 元素
    // 自身 focus, tabindex=-1 才彻底隔离。浏览器对 contenteditable=false
    // 的元素也不响应任何文本输入 / 选区 ── 这是规范层面而非 CSS 层面
    // 的"非可编辑"标记。
    this.header.contentEditable = 'false'

    // Language selector button
    this.languageBtn = document.createElement('button')
    this.languageBtn.classList.add('code-block-language-selector')
    this.languageBtn.type = 'button'
    this.languageBtn.tabIndex = -1
    this.languageBtn.innerHTML = `<span class="code-block-language-label">${this.node.attrs.language || 'plaintext'}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>`

    // Copy button
    this.copyBtn = document.createElement('button')
    this.copyBtn.classList.add('code-block-copy-btn')
    this.copyBtn.type = 'button'
    this.copyBtn.tabIndex = -1
    this.copyBtn.title = 'Copy code'
    this.copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>`

    // Mermaid preview/code tabs
    this.modeTabs = document.createElement('div')
    this.modeTabs.classList.add('code-block-mode-tabs')
    this.modeTabs.setAttribute('role', 'tablist')
    this.modeTabs.setAttribute('aria-label', 'Mermaid view mode')

    this.previewTabBtn = this.createModeTab('preview', '预览', MERMAID_PREVIEW_ICON)
    this.codeTabBtn = this.createModeTab('code', 'Code', MERMAID_CODE_ICON)
    this.modeTabs.append(this.previewTabBtn, this.codeTabBtn)

    this.actions = document.createElement('div')
    this.actions.classList.add('code-block-actions')

    // 全屏入口按钮 ── 仅在 mermaid 预览态下显示 (由 syncMermaidView 控制)。
    // 视觉与 copy / mode tab 同源 (28×28 方按钮, 14×14 图标, hover
    // var(--muted))。aria-label 跟随态切换 (进入 / 退出 全屏) 与
    // agent-thread-card 同源 ── 让屏幕阅读器与可访问性 tree 一致。
    //
    // 位置: 放在 modeTabs **左侧** ── 与"全屏"作为"当前视图(mermaid
    // 预览)的进一步放大"的产品语义一致: 用户先切到预览, 再点全屏把
    // 预览图放大; 视觉上全屏按钮紧贴 modeTabs 形成"一组" ── 跟
    // modeTabs 自己的 preview/code 切换一致, 都是对当前 mermaid
    // 视图的进一步操作。如果放右侧, copy 按钮会被全屏按钮 / modeTabs
    // 隔开, 失去"复制"作为"对代码块本身操作"的视觉归类。
    this.fullscreenButton = document.createElement('button')
    this.fullscreenButton.type = 'button'
    this.fullscreenButton.tabIndex = -1
    this.fullscreenButton.classList.add('code-block-fullscreen-btn')
    this.fullscreenButton.setAttribute('aria-label', '全屏展示')
    this.fullscreenButton.hidden = true
    this.fullscreenButton.innerHTML = FULLSCREEN_ENTER_ICON
    this.fullscreenButton.addEventListener('click', (event) => {
      event.stopPropagation()
      this.toggleFullscreen()
    })

    this.actions.appendChild(this.copyBtn)
    this.actions.appendChild(this.fullscreenButton)
    this.actions.appendChild(this.modeTabs)

    this.header.appendChild(this.languageBtn)
    this.header.appendChild(this.actions)
    this.dom.appendChild(this.header)

    this.dropdown = this.createLanguageDropdownShell()
    // 下拉面板整体也设 contenteditable=false ── dropdown 不在 header 内
    // (它在 dom 内但与 header / contentDOM 平级), 单独标记避免选区渗
    // 进 search input / 列表项。
    this.dropdown.contentEditable = 'false'
    this.dom.appendChild(this.dropdown)

    // Code content
    this.contentDOM.classList.add('code-block-content')
    this.dom.appendChild(this.contentDOM)

    // Mermaid preview surface
    // 同时挂 .code-block-mermaid-preview (容器几何: padding / border-radius /
    // min-height / 显示态切换) 和 .mermaid-surface (SVG 内部样式: 字号 /
    // 对齐 / 主题 ── 统一在 editor-mermaid.css 管理)。
    // 双类分层: 改 mermaid 视觉 → 改 editor-mermaid.css; 改容器几何 →
    // 改 editor-code-block.css ── 两层关注点解耦, 不会互相污染。
    this.previewDOM = document.createElement('div')
    this.previewDOM.classList.add('code-block-mermaid-preview', 'mermaid-surface')
    this.previewDOM.contentEditable = 'false'
    this.dom.appendChild(this.previewDOM)

    this.updateLanguageAttribute()
    this.syncMermaidView()
  }

  private createLanguageDropdownShell(): HTMLElement {
    const dropdown = document.createElement('div')
    dropdown.classList.add('code-block-language-dropdown')
    dropdown.style.display = 'none'
    return dropdown
  }

  private createLanguageSearchInput(): HTMLInputElement {
    const input = document.createElement('input')
    input.classList.add('code-block-language-search')
    input.type = 'search'
    input.placeholder = 'Search language'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.addEventListener('input', () => this.filterLanguageDropdown(input.value))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closeDropdown()
      }
    })
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('mousedown', (event) => event.stopPropagation())
    return input
  }

  private createLanguageDropdownItem(label: string, value: string): HTMLButtonElement {
    const item = document.createElement('button')
    item.classList.add('code-block-language-dropdown-item')
    item.type = 'button'
    item.textContent = label
    item.dataset.label = label.toLowerCase()
    item.dataset.value = value.toLowerCase()
    item.addEventListener('click', () => {
      this.updateLanguage(value)
      this.closeDropdown()
    })
    return item
  }

  private createModeTab(mode: CodeBlockViewMode, label: string, icon: string): HTMLButtonElement {
    const tab = document.createElement('button')
    tab.classList.add('code-block-mode-tab')
    tab.type = 'button'
    // chrome 按钮统一 tabIndex=-1 ── 不参与 Tab 序列, 跟 languageBtn /
    // copyBtn / fullscreenButton 同源处理; 用户在编辑器内 Tab 只会
    // 跨越真实内容节点, 不会卡在装饰按钮上。
    tab.tabIndex = -1
    tab.title = label
    tab.setAttribute('aria-label', label)
    tab.setAttribute('role', 'tab')
    tab.dataset.mode = mode
    tab.innerHTML = icon
    return tab
  }

  private filterLanguageDropdown(query: string): void {
    const list = this.dropdownList
    if (!list) return

    const needle = query.trim().toLowerCase()
    let visibleCount = 0

    for (const child of Array.from(list.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (child === this.dropdownEmpty) continue
      const haystack = `${child.dataset.label ?? ''} ${child.dataset.value ?? ''}`
      const visible = needle === '' || haystack.includes(needle)
      child.hidden = !visible
      if (visible) visibleCount += 1
    }

    if (this.dropdownEmpty) {
      this.dropdownEmpty.hidden = visibleCount > 0
    }
  }

  private async populateLanguageDropdown(dropdown: HTMLElement): Promise<void> {
    if (this.dropdownPopulated) return
    this.dropdownPopulated = true
    dropdown.replaceChildren()

    const search = this.createLanguageSearchInput()
    const list = document.createElement('div')
    list.classList.add('code-block-language-list')
    const loading = document.createElement('div')
    loading.classList.add('code-block-language-status')
    loading.textContent = 'Loading languages...'
    list.appendChild(loading)
    dropdown.append(search, list)

    this.dropdownSearchInput = search
    this.dropdownList = list

    let bundledLanguagesInfo: readonly BundledLanguageInfo[]
    try {
      bundledLanguagesInfo = await loadBundledLanguagesInfo()
    } catch (err) {
      this.dropdownPopulated = false
      loading.textContent = 'Failed to load languages'
      console.error('[CodeBlockShiki] failed to load language list:', err)
      return
    }

    if (this.isDestroyed) return
    list.replaceChildren()

    // Auto detect option
    list.appendChild(this.createLanguageDropdownItem('Auto Detect', ''))

    // Language options
    const languages = bundledLanguagesInfo.map(lang => ({
      label: lang.name,
      value: lang.id,
    }))

    languages.forEach(({ label, value }) => {
      list.appendChild(this.createLanguageDropdownItem(label, value))
    })

    const empty = document.createElement('div')
    empty.classList.add('code-block-language-status')
    empty.textContent = 'No languages found'
    empty.hidden = true
    list.appendChild(empty)
    this.dropdownEmpty = empty

    this.filterLanguageDropdown(search.value)
  }

  private ensureDropdown(): HTMLElement {
    if (!this.dropdown) {
      this.dropdown = this.createLanguageDropdownShell()
      this.dom.insertBefore(this.dropdown, this.contentDOM)
    }

    return this.dropdown
  }

  private toggleDropdown() {
    if (!this.languageBtn) return

    if (this.isDropdownOpen) {
      this.closeDropdown()
    } else {
      const dropdown = this.ensureDropdown()
      dropdown.style.display = 'block'
      this.isDropdownOpen = true
      this.attachOutsideClickHandler()
      void this.populateLanguageDropdown(dropdown)
      requestAnimationFrame(() => this.dropdownSearchInput?.focus())
    }
  }

  private closeDropdown() {
    if (this.dropdown) {
      this.dropdown.style.display = 'none'
      this.isDropdownOpen = false
    }
    this.detachOutsideClickHandler()
  }

  private attachOutsideClickHandler() {
    if (this.boundOutsideClickHandler) return

    // Close on any document click. The language button, copy button, mode tabs
    // and dropdown search input all call `event.stopPropagation()` themselves,
    // so their clicks never reach this handler. Dropdown items invoke
    // `closeDropdown()` synchronously in their own click handler, so by the
    // time a bubble reaches the document `isDropdownOpen` is already false.
    // Result: clicking anywhere — including inside the code block's
    // `contentDOM` to place the caret — closes the dropdown.
    this.boundOutsideClickHandler = (_e: Event) => {
      if (this.isDropdownOpen) {
        this.closeDropdown()
      }
    }
    document.addEventListener('click', this.boundOutsideClickHandler)
  }

  private detachOutsideClickHandler() {
    if (!this.boundOutsideClickHandler) return

    document.removeEventListener('click', this.boundOutsideClickHandler)
    this.boundOutsideClickHandler = null
  }

  private updateLanguage(language: string) {
    const { state, dispatch } = this.view
    const pos = this.getPos()

    if (pos === null) return

    const tr = state.tr.setNodeAttribute(pos, 'language', language)
    dispatch(tr)
    this.updateLanguageButton(language)
    // 切到非 mermaid 语言时强制退出全屏 ── 避免全屏态挂着 mermaid
    // SVG 但节点本身已不再是 mermaid, view 渲染可能与全屏态不一致
    // (e.g. preview 表面被 display: none 隐藏, 全屏 CSS 仍 fixed 显示
    // 一个空白容器)。syncMermaidView 在 isMermaid=false 时会隐藏
    // 入口按钮, 但全屏态的 exit 按钮仍可见 ── 在这里同步关掉。
    if (this.isFullscreen && language.toLowerCase() !== MERMAID_LANGUAGE) {
      this.setFullscreen(false)
    }
    this.syncMermaidView()
  }

  private updateLanguageButton(language: string) {
    if (!this.languageBtn) return

    const label = language || 'plaintext'
    const labelSpan = this.languageBtn.querySelector('.code-block-language-label')
    if (labelSpan) {
      labelSpan.textContent = label
    }
  }

  private updateLanguageAttribute() {
    if (this.node.attrs.language) {
      this.dom.setAttribute('data-language', this.node.attrs.language)
    } else {
      this.dom.removeAttribute('data-language')
    }
  }

  private isMermaidBlock() {
    return (this.node.attrs.language || '').toLowerCase() === MERMAID_LANGUAGE
  }

  private setViewMode(mode: CodeBlockViewMode) {
    this.viewMode = mode
    this.syncMermaidView()
  }

  private updateModeTabs() {
    if (!this.previewTabBtn || !this.codeTabBtn) return

    const isPreviewing = this.viewMode === 'preview'
    this.previewTabBtn.classList.toggle('active', isPreviewing)
    this.previewTabBtn.setAttribute('aria-selected', String(isPreviewing))
    this.previewTabBtn.tabIndex = isPreviewing ? 0 : -1

    this.codeTabBtn.classList.toggle('active', !isPreviewing)
    this.codeTabBtn.setAttribute('aria-selected', String(!isPreviewing))
    this.codeTabBtn.tabIndex = isPreviewing ? -1 : 0
  }

  private syncMermaidView() {
    const isMermaid = this.isMermaidBlock()

    this.dom.classList.toggle('code-block-is-mermaid', isMermaid)
    this.dom.classList.toggle('code-block-mermaid-previewing', isMermaid && this.viewMode === 'preview')

    if (this.modeTabs) {
      this.modeTabs.hidden = !isMermaid
      this.updateModeTabs()
    }

    // 全屏入口按钮 ── 仅在 mermaid 预览态下显示, 与产品需求"在预览
    // 状态下增加全屏按钮"对齐。非 mermaid 块 (e.g. tsx / python) 不展示,
    // 避免与 shiki 自身的全屏视觉无关 ── shiki 代码块的全屏是浏览器级
    // 缩放 (Ctrl+=), 不在编辑器内嵌控件职责内。已处于全屏态时按钮
    // 也保持显示 ── 视觉上 header 在全屏态被 CSS 隐藏, 不会被用户看到。
    if (this.fullscreenButton) {
      this.fullscreenButton.hidden = !(isMermaid && this.viewMode === 'preview')
    }

    if (isMermaid && this.viewMode === 'preview') {
      void this.renderMermaidPreview()
    }
  }

  private async renderMermaidPreview() {
    if (!this.previewDOM) return

    const source = this.node.textContent.trim()
    const version = ++this.renderVersion

    if (!source) {
      this.lastRenderedSource = source
      this.previewDOM.innerHTML = '<div class="code-block-mermaid-empty">Empty Mermaid diagram</div>'
      return
    }

    if (source === this.lastRenderedSource && this.previewDOM.querySelector('svg')) {
      return
    }

    this.previewDOM.replaceChildren()

    try {
      const { renderMermaidDiagram } = await import('./mermaid-renderer')
      const svg = await renderMermaidDiagram(source)
      if (version !== this.renderVersion) return
      this.lastRenderedSource = source
      this.previewDOM.innerHTML = svg
    } catch (error) {
      if (version !== this.renderVersion) return
      const isParseError = error instanceof Error && error.name === 'MermaidParseError'
      const message = isParseError
        ? 'Mermaid 格式解析异常，无法完成预览'
        : error instanceof Error ? error.message : 'Failed to render Mermaid diagram'
      this.lastRenderedSource = null
      this.previewDOM.innerHTML = ''
      const errorBox = document.createElement('div')
      errorBox.classList.add('code-block-mermaid-error')
      if (isParseError) {
        errorBox.classList.add('code-block-mermaid-parse-error')
      }
      errorBox.textContent = message
      this.previewDOM.appendChild(errorBox)
    }
  }

  private handleEvents() {
    // Language button click
    this.languageBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleDropdown()
    })

    // Copy button click
    this.copyBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.handleCopy()
    })

    this.previewTabBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setViewMode('preview')
    })

    this.codeTabBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setViewMode('code')
    })

    this.boundThemeChangeHandler = () => {
      this.lastRenderedSource = null
      if (this.isMermaidBlock() && this.viewMode === 'preview') {
        void this.renderMermaidPreview()
      }
    }
    window.addEventListener('app-theme-changed', this.boundThemeChangeHandler)
  }

  // ── 全屏模式 ──
  //
  // 设计要点 (对齐 agent-thread-card 的全屏实现 + 独立 overlay 改进):
  //   1. 触发: 仅在 mermaid 预览态下 (由 syncMermaidView 控制入口按钮可见性)。
  //   2. 布局: 全屏时挂一个独立 DOM overlay 到 document.body, 跟原
  //      code-block-wrapper 完全解耦 ── 不改 wrapper 自身的 class / position,
  //      避免与 .code-block-mermaid-previewing 互相干扰 (之前一版让 wrapper
  //      变 position: fixed, 跟 ProseMirror 的 contentEditable / mousedown
  //      选区处理打架, 出现"点击全屏后回退到代码视图"的视觉跳动)。
  //   3. 内容: overlay 内部把 preview 表面里渲染好的 SVG cloneNode 进来,
  //      走 flex 居中 + max-* + object-fit 视觉 ── 与直接读 previewDOM
  //      的 SVG 等效, 但因为是 overlay 独立 DOM, 不受 ProseMirror 重渲染
  //      影响 (例如用户切 mode tab 不会把全屏 SVG 弄丢)。
  //   4. 视觉: overlay 唯一可见的 UI 是右上角"退出全屏"按钮, 满足产品
  //      需求"全屏时仅展示退出按钮"。背景用 var(--background) + 阴影
  //      形成"在编辑器内弹层"的视觉感。
  //   5. 退出: 点退出按钮 / 按 ESC 都能退出, NodeView 销毁时强制退出。
  //   6. 生命周期: overlay 在 enterFullscreenMode 创建, 在
  //      exitFullscreenMode / destroy 移除并清掉所有监听器 ── 避免
  //      NodeView 节点被卸载时残留的 overlay 浮在屏幕上。

  private toggleFullscreen(): void {
    this.setFullscreen(!this.isFullscreen)
  }

  private setFullscreen(fullscreen: boolean): void {
    if (this.isFullscreen === fullscreen) return;
    this.isFullscreen = fullscreen;

    if (fullscreen) {
      this.enterFullscreenMode();
    } else {
      this.exitFullscreenMode();
    }
  }

  private enterFullscreenMode(): void {
    const container = this.getFullscreenContainer();
    if (!container) {
      // 拿不到定位参照物 (不在 document-container 内, 极端情况) ──
      // 直接回退, 不进全屏, 避免 overlay 漂浮在错误位置。
      this.isFullscreen = false;
      return;
    }
    this.fullscreenContainer = container;

    // 一次性创建 / 缓存 bound handlers ── 进入全屏可能频繁触发
    // (用户来回点), 复用同一函数引用避免 removeEventListener 失效。
    if (!this.boundSyncFullscreenBounds) {
      this.boundSyncFullscreenBounds = () => this.syncOverlayPosition();
    }
    if (!this.boundHandleFullscreenKeydown) {
      this.boundHandleFullscreenKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && this.isFullscreen) {
          event.stopPropagation();
          this.setFullscreen(false);
        }
      };
    }

    this.mountFullscreenOverlay();
    this.observeFullscreenContainer();

    window.addEventListener('resize', this.boundSyncFullscreenBounds);
    // 捕获阶段监听 ESC ── 与 agent-thread-card 同源: 防止 ESC 优先
    // 被编辑器其它快捷键 (e.g. slash menu) 消费掉。
    window.addEventListener('keydown', this.boundHandleFullscreenKeydown, true);
    window.requestAnimationFrame(() => this.syncOverlayPosition());
  }

  private exitFullscreenMode(): void {
    this.unmountFullscreenOverlay();
    this.fullscreenResizeObserver?.disconnect();
    this.fullscreenResizeObserver = null;
    this.fullscreenContainer = null;
    if (this.boundSyncFullscreenBounds) {
      window.removeEventListener('resize', this.boundSyncFullscreenBounds);
    }
    if (this.boundHandleFullscreenKeydown) {
      window.removeEventListener('keydown', this.boundHandleFullscreenKeydown, true);
    }
  }

  // 创建全屏 overlay ── 独立 DOM, 挂到 document.body。
  // 位置由 .document-container 的 bounding rect 决定 (与
  // agent-thread-card 全屏范围同源 ── 限定在文档区, 不越界盖
  // 左侧笔记列表 / 右侧 Agent 面板)。
  //
  // 结构 ── 渲染时挂两层 DOM:
  //   .code-block-fullscreen-backdrop  ← 外层背景 (阻拦穿透点击)
  //     .code-block-fullscreen-overlay ← 实际可见的全屏卡片
  // backdrop 位置 = 当前容器 + 48px 高 / -48px 顶偏移, 用于在
  // overlay 之外留出 48px 的"点击吸收带", 避免用户点在 overlay
  // 边缘外 48px 内仍触发底层元素 (e.g. 状态栏 / 笔记列表 hover)。
  // 详细几何见 editor-code-block.css 的 .code-block-fullscreen-backdrop。
  private mountFullscreenOverlay(): void {
    if (this.fullscreenOverlay) return;

    // 外层背景 ── 包裹 overlay, 整体上移 48px 且高度 +48px, 让
    // overlay 上下各有 48px 的"点击吸收带"。背景色 = var(--background)
    // (编辑器背景), 视觉上与编辑器背景融合 ── 用户感知不到 backdrop
    // 自身, 只感知到"全屏 overlay 的点击区域比看起来更大"。
    const backdrop = document.createElement('div');
    backdrop.classList.add('code-block-fullscreen-backdrop');

    const overlay = document.createElement('div');
    overlay.classList.add('code-block-fullscreen-overlay');
    overlay.setAttribute('data-mermaid-fullscreen', 'true');

    // SVG 容器 ── 居中 + 缩放, 跟原 preview 表面等效。
    // 同时挂 .code-block-fullscreen-svg-wrap (容器几何: flex 居中 +
    // 1.5rem padding) 和 .mermaid-surface (SVG 内部样式: 字号 / 对齐 /
    // 主题) ── 与原 previewDOM 一样的双类分层。SVG 内部样式在
    // editor-mermaid.css 一处管理, 全屏 / 非全屏永远一致。data-mermaid-fullscreen
    // 留给未来 (e.g. 调试 / 选区工具) 识别。
    const svgWrap = document.createElement('div');
    svgWrap.classList.add('code-block-fullscreen-svg-wrap', 'mermaid-surface');

    // 复制 previewDOM 里渲染好的 SVG ── 不用 innerHTML 抓字符串
    // 是为了保留 SVG 节点引用 (e.g. mermaid 内部的事件 listener、
    // foreignObject 子树), cloneNode(true) 走 shallow 拷贝不影响
    // SVG 的 display / 引用关系。
    const svg = this.previewDOM?.querySelector('svg');
    if (svg) {
      svgWrap.appendChild(svg.cloneNode(true));
    } else {
      // previewDOM 还没渲染 (e.g. 切到 preview 的瞬间用户立刻
      // 点全屏) ── 提示正在渲染, 让用户知道不是 bug。覆盖层
      // 退出再进时会重新 clone 最新 SVG, 所以这是 transient 状态。
      const placeholder = document.createElement('div');
      placeholder.classList.add('code-block-fullscreen-placeholder');
      placeholder.textContent = '正在渲染...';
      svgWrap.appendChild(placeholder);
    }
    overlay.appendChild(svgWrap);

    // 顶部 actions 容器 ── 把 zoom 工具条 (3 个按钮) + 退出按钮 (1 个
    // 按钮) 收纳到同一行浮窗, 整体定位在 overlay 右上角 ── 用户单眼
    // 扫到位置一致, 4 个控件视觉同组, 比"工具条在底 / 退出在顶"的
    // 对角布局更易触达。容器自挂 var(--card) 底 + var(--border) 边 +
    // 圆角, 4 个按钮在容器内共享一份边框底色 (toolbar 自己不再带
    // border / shadow, 退化为容器内纯按钮组)。
    const actions = document.createElement('div');
    actions.classList.add('code-block-fullscreen-actions');

    // pan/zoom 工具条 ── 提供"画布站"式浏览 mermaid 大图的体验:
    // 滚轮缩放 (svg-pan-zoom 默认, 围绕鼠标点)、拖拽平移、双击放大、
    // 工具条按钮 (放大 / 缩小 / 还原 fit)。非全屏态不挂 (previewDOM 在
    // ProseMirror 内, 引入 drag/zoom 会与编辑器选区 / 光标冲突) ── 全屏
    // overlay 才是 mermaid "看大图" 的唯一入口, 把 pan/zoom 限定在这里
    // 范围最干净。
    const toolbar = this.createFullscreenToolbar();
    actions.appendChild(toolbar);

    // 退出按钮 ── 跟工具条一起被 actions 容器收纳在右上角。视觉样式
    // 与入口全屏按钮 (.code-block-fullscreen-btn) 完全同源 ──
    // 同时挂 .code-block-fullscreen-btn + .code-block-fullscreen-exit
    // 两个类: 第一个类负责视觉 (size / 圆角 / hover 等), 第二个类
    // 之前负责 absolute 定位, 现在定位由父级 actions 容器接管, 本类
    // 仅作为"语义标记"保留 (DevTools 看到该类就知道是退出按钮)。
    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.classList.add('code-block-fullscreen-btn', 'code-block-fullscreen-exit');
    exitBtn.setAttribute('aria-label', '退出全屏展示');
    exitBtn.innerHTML = FULLSCREEN_EXIT_ICON;
    exitBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.setFullscreen(false);
    });
    actions.appendChild(exitBtn);

    overlay.appendChild(actions);

    // 顺序关键 ── CSS vars 写入 → 挂到 body → 再 init pan/zoom。
    // svg-pan-zoom 在 fit 阶段会读 svgWrap.clientWidth/Height 计算
    // 初始缩放比; 若此时 svgWrap 还没进 DOM (clientWidth/Height = 0),
    // fit 算出来是 NaN → 后续 transform matrix 全 NaN → SVG 不可见 +
    // 工具条百分比显示 NaN%。appendChild 后再 init, svg-pan-zoom 内部
    // 的 getBoundingClientRect() 强制触发布局, 拿到真实尺寸, fit 正常。
    //
    // CSS vars 写到 backdrop 而非 overlay ── backdrop 是 overlay 的
    // 祖先, CSS 自定义属性沿 DOM 树向下继承, overlay 内的
    // var(--ccb-fullscreen-*) 仍能解析到 backdrop 上写入的值。这样
    // backdrop 拥有"决定位置"的话语权, overlay 退化为"在 backdrop
    // 内做几何布局"的角色 (e.g. margin: 0.6rem)。
    this.syncOverlayPositionTo(backdrop);
    backdrop.appendChild(overlay);
    document.body.appendChild(backdrop);
    this.fullscreenBackdrop = backdrop;
    this.fullscreenOverlay = overlay;

    // SVG 已 clone 进来 → 初始化 svg-pan-zoom。svg-pan-zoom 给
    // SVG 注入自己的 <g class="svg-pan-zoom-viewport"> 包装 + transform,
    // 不破坏 mermaid 的 viewBox / preserveAspectRatio (由 CSS 控制 SVG
    // 容器几何)。
    this.initPanZoom(svgWrap);
  }

  // ── 全屏态 pan/zoom (svg-pan-zoom) ──
//
// 范围 ── 仅在全屏 overlay 内激活, 非全屏的 previewDOM 保持静态。
// previewDOM 在 ProseMirror 编辑区内, 任何 drag / wheel 监听都会
// 跟编辑器选区 / 光标打架; 全屏 overlay 是 detached DOM, 是"看
// mermaid 大图"的唯一入口, 把 pan/zoom 限定在这里范围最干净。
//
// 工作机制 ── svg-pan-zoom 给 SVG 注入自己的 <g class="svg-pan-zoom-viewport">
// 包装, 在该 <g> 上应用 transform="matrix(...)" 实现 scale / translate。
// SVG 自身的 viewBox / preserveAspectRatio / CSS 尺寸不受影响 ──
// mermaid 的渲染结构原样保留, 只是在内部多了一层可变换的 <g>。
//
// 选 svg-pan-zoom 而非手写 CSS transform ──
//   - 滚轮缩放围绕鼠标点 (手写 viewBox 要做 getScreenCTM().inverse()
//     矩阵反推, 体验细节差)
//   - 拖拽平移自带 momentum
//   - 双击智能放大 / pinch zoom / min/max clamp 全部内置
//   - 体积 ~14KB gzipped, GitHub / GitLab / Gitea 等都直接用它
//
// 不在 SVG 元素自身做 CSS transform ── 那会跟 mermaid 内部的 SVG
// 坐标系和 svg-pan-zoom 的 transform 计算打架, 导致 wheel 缩放中心
// 漂移。改 SVG 元素 CSS 尺寸 (width/height: 100%) 即可 ── SVG 元素
// 的 box 跟 svgWrap 内容盒对齐, svg-pan-zoom 的 viewport transform
// 完全在自己的 <g> 坐标系内, 互不干扰。

private createFullscreenToolbar(): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.classList.add('code-block-fullscreen-toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Mermaid 缩放与平移');

  const zoomOutBtn = this.createToolbarButton(ZOOM_OUT_ICON, '缩小', () => {
    this.panZoomInstance?.zoomOut();
  });
  toolbar.appendChild(zoomOutBtn);

  // 中间按钮 ── 纯文本显示当前缩放百分比, 点击触发 fit-to-container。
  // 双语义合一: 既是指示器 (当前缩放) 又是还原按钮 (点一下回到 fit)。
  // 视觉宽度比两侧按钮大, 让百分比文字 (e.g. "125%") 有足够水平空间。
  // 早期版本内嵌 fit 图标 + 百分比双段, 现在去掉左侧图标, 只显示
  // 文字, 视觉重量跟两侧 +/- 图标按钮风格统一。
  const labelBtn = document.createElement('button');
  labelBtn.type = 'button';
  labelBtn.classList.add(
    'code-block-fullscreen-btn',
    'code-block-fullscreen-toolbar-label'
  );
  labelBtn.setAttribute('aria-label', '重置缩放');
  labelBtn.title = '重置缩放';
  // 初始内容是 "100%" 兜底占位; 首次 zoom 完成后会被 updateZoomLabel
  // 覆盖成实际百分比 (e.g. "125%")。
  labelBtn.textContent = '100%';
  labelBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    this.panZoomInstance?.reset();
  });
  toolbar.appendChild(labelBtn);
  this.zoomLabelBtn = labelBtn;

  const zoomInBtn = this.createToolbarButton(ZOOM_IN_ICON, '放大', () => {
    this.panZoomInstance?.zoomIn();
  });
  toolbar.appendChild(zoomInBtn);

  return toolbar;
}

private createToolbarButton(
  iconHTML: string,
  ariaLabel: string,
  onClick: () => void
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.classList.add('code-block-fullscreen-btn');
  btn.setAttribute('aria-label', ariaLabel);
  btn.title = ariaLabel;
  btn.innerHTML = iconHTML;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

private initPanZoom(svgWrap: HTMLElement): void {
  const svg = svgWrap.querySelector('svg');
  if (!svg) return;
  // placeholder 状态 (svgWrap 没 svg) ── 不初始化, 退出重进时再试。
  // svg-pan-zoom 必须有 SVG 元素才能挂 transform group。
  this.destroyPanZoom();
  this.panZoomInstance = svgPanZoom(svg, {
    // fit: true + center: true 让 SVG 内容初始铺满 svgWrap 容器 (居中)。
    // contain: true 配合 preserveAspectRatio="xMidYMid meet" 等效, 保证
    // 内容缩放时不变形不溢出 ── 这是 SVG 矢量标准 "meet" 行为。
    fit: true,
    contain: true,
    center: true,
    // minZoom 0.3 (30%) ── 缩到 30% 已经能看清单张流程图全貌, 再往下
    // 缩只会让文字糊成一片, 没意义。maxZoom 5 (500%) ── 放大 5 倍
    // 已能看清 mermaid 节点内的每个字符, 10 倍以上既糊且无场景。
    // 收窄范围避免用户拖出"看不清但能拖"的鬼畜缩放。
    minZoom: 0.3,
    maxZoom: 5,
    // 灵敏度比默认 0.2 高一档 (0.3) ── 滚轮一次缩放更明显, 减少
    // 反复滚轮才能看清细节的疲劳。
    zoomScaleSensitivity: 0.3,
    // onZoom 回调用来刷新中间按钮的百分比显示 ── svg-pan-zoom 在
    // wheel / 按钮 / dblclick / fit / reset 等所有改变缩放的路径都会
    // 触发, 所以一处更新覆盖全场景。
    onZoom: (newScale: number) => this.updateZoomLabel(newScale),
  });
  // 立即同步一次 ── fit 触发的 zoom 回调可能在某些版本/路径上
  // 漏掉, 这里手动更新保证按钮文字 = 当前 zoom。
  this.updateZoomLabel(this.panZoomInstance.getZoom());
}

private destroyPanZoom(): void {
  if (!this.panZoomInstance) return;
  this.panZoomInstance.destroy();
  this.panZoomInstance = null;
}

private updateZoomLabel(scale: number): void {
  if (!this.zoomLabelBtn) return;
  // label 按钮本身是纯文本节点, 直接 set textContent ── 之前是
  // 双段结构 (icon span + text span), 现在统一为单段文本, set
  // textContent 同时清掉旧内容, 不会有残留。
  this.zoomLabelBtn.textContent = `${Math.round(scale * 100)}%`;
}

private unmountFullscreenOverlay(): void {
    if (!this.fullscreenBackdrop) return;
    // 先解绑 svg-pan-zoom ── 它在 SVG 元素上挂了 wheel / mousedown /
    // dblclick 等监听, 不在 backdrop.remove() 之前 destroy 会在
    // detached DOM 上残留 listener 引用 ── NodeView 多次重建时累积。
    this.destroyPanZoom();
    // 移除 backdrop (overlay 作为其子节点会一起被 GC 回收) ── 不要
    // 直接 remove overlay 再 remove backdrop, 后者会先于前者
    // 走 detach 流程, 触发 SVG 节点上的 listener 试图访问已经
    // 找不到的祖先。统一从最外层 (backdrop) remove 即可。
    this.fullscreenBackdrop.remove();
    this.fullscreenBackdrop = null;
    this.fullscreenOverlay = null;
    this.zoomLabelBtn = null;
  }

  private observeFullscreenContainer(): void {
    this.fullscreenResizeObserver?.disconnect();
    if (!this.fullscreenContainer || !('ResizeObserver' in window)) return;

    this.fullscreenResizeObserver = new ResizeObserver(() => {
      this.syncOverlayPosition();
    });
    this.fullscreenResizeObserver.observe(this.fullscreenContainer);
  }

  private syncOverlayPosition(): void {
    if (!this.fullscreenBackdrop) return;
    this.syncOverlayPositionTo(this.fullscreenBackdrop);
    // overlay bounds 变了 → svg-pan-zoom 缓存的容器尺寸失效, 调
    // resize() 让它重读 svgWrap.clientWidth/Height, 后续 wheel 缩放
    // 才能正确围绕鼠标点 (用旧的容器尺寸会"跳")。fit zoom 保持不变 ──
    // 用户当前的缩放/平移不会被 reset。
    this.panZoomInstance?.resize();
  }

  private syncOverlayPositionTo(target: HTMLElement): void {
    if (!this.fullscreenContainer) return;
    const rect = this.fullscreenContainer.getBoundingClientRect();
    // 用 CSS vars 写 bounds ── 与 agent-thread-card 同源 (--atc-fullscreen-*),
    // CSS 端走 calc() 加 1rem 左右外边距 (与 ATC 视觉一致)。不直接写
    // style.top/left/width/height 是为了让 CSS 拥有"决定外边距"的话语权 ──
    // 后续若想改外边距, 只动 CSS 不动 JS。
    //
    // 写到 backdrop 而非 overlay ── CSS vars 沿 DOM 树向下继承, overlay
    // 作为 backdrop 子节点, var(--ccb-fullscreen-*) 仍能解析到 backdrop
    // 上写入的值。这样 backdrop 是位置的几何真源, overlay 只负责
    // "在 backdrop 内做几何布局" (e.g. margin: 0.6rem)。
    target.style.setProperty('--ccb-fullscreen-top', `${rect.top}px`);
    target.style.setProperty('--ccb-fullscreen-left', `${rect.left}px`);
    target.style.setProperty('--ccb-fullscreen-width', `${rect.width}px`);
    target.style.setProperty('--ccb-fullscreen-height', `${rect.height}px`);
  }

  private getFullscreenContainer(): HTMLElement | null {
    // 与 agent-thread-card 同源 ── 找最近的 .document-container。
    // 这是编辑器中央文档区的根 div, 全屏范围限定在文档区, 不会
    // 越界盖到左侧笔记列表 / 右侧 Agent 面板 ── 与"在笔记内查看
    // mermaid 大图"的产品语义一致。
    const container = this.dom.closest('.document-container');
    return container instanceof HTMLElement ? container : null;
  }

  private handleCopy() {
    const code = this.node.textContent

    try {
      navigator.clipboard.writeText(code).then(() => {
        this.showCopySuccess()
      }).catch(() => {
        // Fallback for older browsers
        this.fallbackCopy(code)
      })
    } catch {
      this.fallbackCopy(code)
    }
  }

  private fallbackCopy(text: string) {
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.top = '-1000px'
    textArea.style.left = '-1000px'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    textArea.select()

    try {
      document.execCommand('copy')
      this.showCopySuccess()
    } catch (err) {
      console.error('Failed to copy:', err)
    }

    document.body.removeChild(textArea)
  }

  private showCopySuccess() {
    if (!this.copyBtn) return

    const originalHTML = this.copyBtn.innerHTML
    this.copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"></polyline>
    </svg>`
    this.copyBtn.classList.add('copied')

    setTimeout(() => {
      if (this.copyBtn) {
        this.copyBtn.innerHTML = originalHTML
        this.copyBtn.classList.remove('copied')
      }
    }, 2000)
  }

  private getPos(): number | null {
    return typeof this.getPosFn === 'function' ? (this.getPosFn() ?? null) : null
  }

  update(node: NodeViewRendererProps['node']) {
    if (node.type !== this.node.type) return false

    this.node = node

    // Update language button if changed externally
    const newLang = node.attrs.language || ''
    const currentLang = (this.languageBtn?.querySelector('.code-block-language-label') as HTMLElement)?.textContent || ''
    if (newLang !== currentLang && newLang !== currentLang.replace(/^\s+|\s+$/g, '')) {
      this.updateLanguageButton(newLang)
    }

    this.updateLanguageAttribute()
    this.syncMermaidView()
    return true
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    // Ignore mutations in chrome/preview DOM. Content edits inside contentDOM
    // must still be observed by ProseMirror.
    if (mutation.target === this.dom && mutation.type === 'attributes') return true
    if (mutation.target === this.contentDOM && mutation.type === 'attributes') return true
    if (this.dropdown?.contains(mutation.target)) return true
    if (this.header?.contains(mutation.target)) return true
    if (this.previewDOM?.contains(mutation.target)) return true
    return false
  }

  destroy() {
    this.setFullscreen(false)
    this.isDestroyed = true
    this.detachOutsideClickHandler()
    if (this.boundThemeChangeHandler) {
      window.removeEventListener('app-theme-changed', this.boundThemeChangeHandler)
      this.boundThemeChangeHandler = null
    }
  }
}

export { CodeBlockShikiView }

export function createCodeBlockShikiView(props: NodeViewRendererProps) {
  return new CodeBlockShikiView(props)
}
