import { openUrl } from "@tauri-apps/plugin-opener";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type {
  EditorView,
  NodeView as ProseMirrorNodeView,
} from "@tiptap/pm/view";
import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BadgeHoverCard } from "@features/editor/extensions/agent-thread-card/badge-hover-card";
import {
  useChatStore,
  type ThreadState,
} from "@features/agent/store/chat-store";
import {
  type AgentConversationRun,
  useAgentConversationStore,
} from "@features/agent/store/agent-conversation-store";
import { selectRenderableThreadMessages } from "@features/agent/store/thread-render-messages";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { useAgentRuntimeStore } from "@features/agent/store/agent-runtime-store";
import { useMemoStore } from "@features/memo";
import { Tooltip } from "@shared/ui/tooltip";
import { translate, type AppLanguage, type I18nKey } from "@features/i18n";
import type { AgentTypeKey } from "@/types/agent";
import { stripSystemBlock } from "@features/agent/message";
import { openNoteByDeepLink } from "@platform/open-target";
import { isWindowsPlatform } from "@features/shortcuts";
import { normalizePlainLinkHref } from "@features/editor/extensions/markdown-link";
import {
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import type { AgentRuntimeSettingKind } from "@features/agent/runtime/agent-runtime-spec";
import {
  applyResolvedExternalSession,
  createExternalAgentRuntimeHandle,
  getExternalAgentRuntimeThreadId,
  getResolvedExternalSessionId,
  isLocalExternalThreadId,
  resolveExternalSessionId,
  stopExternalAgentThreadCardRun,
} from "@features/agent/services/external-agent-runtime-service";
import { loadAgentThreadCardCache } from "@features/editor/extensions/agent-thread-card/agent-thread-card-cache";
import {
  selectAgentThreadCardRunStatus,
  selectAgentThreadCardSendButtonState,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-selectors";
import { submitAgentThreadCardConversation } from "@features/editor/extensions/agent-thread-card/agent-thread-card-submit-controller";
import {
  ICON_STOP_PATH,
  createChevronIcon,
  createFullscreenIcon,
  createTrashIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";
import { AccessPopoverController } from "@features/editor/extensions/agent-thread-card/access/access-popover-controller";
import { ExternalAgentSettingsController } from "@features/editor/extensions/agent-thread-card/settings/external-agent-settings-controller";
import { AgentRolePickerController } from "@features/editor/extensions/agent-thread-card/role/agent-role-picker-controller";
import { FullscreenLayoutController } from "@features/editor/extensions/agent-thread-card/fullscreen/fullscreen-layout-controller";
import { getPersistableInputDraft } from "@features/editor/extensions/agent-thread-card/composer/composer-draft";
import { ComposerDraftController } from "@features/editor/extensions/agent-thread-card/composer/composer-draft-controller";
import { getAgentThreadCardUserHistoryMessagesFromMessages } from "@features/editor/extensions/agent-thread-card/composer/composer-history";
import { createThreadCacheSkeleton } from "@features/editor/extensions/agent-thread-card/messages/thread-cache-skeleton";
import {
  appendRenderedAgentMessagesToTail,
  createRenderedAgentMessageList,
  getRenderedAgentMessages,
  patchLastRenderedAgentMessage,
  type AgentThreadCardMessageRenderContext,
} from "@features/editor/extensions/agent-thread-card/messages/message-list-renderer";
import { getCurrentThreadCardSource } from "@features/editor/extensions/agent-thread-card/runtime/thread-card-source";
import {
  canSkipMessageRebuild,
  consumeEditorPopoverDismissPointer,
  extractDocumentContext,
  focusWithoutScroll,
  getEventElement,
  isAgentThreadCardInteractiveTarget,
  isAgentThreadCardSelectableMessageText,
  type ScrollSnapshot,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-dom";
import {
  cancelBlockDragForView,
  dropBlockDragAtForView,
  startBlockDragForView,
  updateBlockDragPositionForView,
} from "@features/editor/extensions/block-drag";

/** Schema default 用的静态字面量 ── Tiptap schema 不依赖语言, 这里
 * 写死空串; 用户创建卡片后 title 会由 buildTitle() 用 prompt 覆盖,
 * prompt 为空时也走空串兜底, 不再渲染 "AI 对话" 等默认文案。
 * 运行期 title getter 用 `this.t('editor.threadCard.title')` 走 i18n (目前为空)。 */
// DEFAULT_TITLE_KEY ── 卡片标题为空时的回落 i18n key, 实际取值在每处
// 取数前 translate(language, DEFAULT_TITLE_KEY)。 在 schema default 里
// 也直接用静态 fallback (空串), 因为 schema 不依赖语言 ── 用户
// 创建卡片后这个 default 立即会被 buildTitle() 覆盖, 不会被长时间展示。

// OS 顶部控件区高度 ── AgentThreadCard 全屏时把卡片向上探出这条带状区
// 高度, 覆盖到 webview 顶端 (而不是停在文档区顶边)。
//
//   - Windows: 36px (h-9), 来自 components/windows-titlebar-controls.tsx
//     ── 那是一个 `position: fixed; top: 0; h-9` 的覆盖层, 实际占
//     据 webview 内容顶部的 36px 高度。
//   - macOS / Linux: 0px ── OS 自带的 traffic-light / GTK decoration
//     在 webview 之外, 不占内容区。Mac 上确实有 flowix 自己的
//     document-titlebar-mac (h-12 = 48px), 但它属于"文档区内部的
//     标题栏", 全屏卡片向上探出去就把它压住了 ── 不算 OS 顶部控件区。
//
// 用 px 写死而非 var 是有意: h-9 是 Tailwind 直接出 36px 的常量, 改
// 一边就要同步改另一边, 这里保留纯数字 + 注释避免魔法值漂移。
const WINDOWS_TITLEBAR_HEIGHT_PX = 36;
const BOTTOM_FOLLOW_THRESHOLD_PX = 96;
const TOP_HISTORY_LOAD_THRESHOLD_PX = 48;
const FULLSCREEN_EXIT_FALLBACK_MIN_TOP_PX = 24;
const FULLSCREEN_EXIT_FALLBACK_MAX_TOP_PX = 160;
const FULLSCREEN_EXIT_FALLBACK_TOP_RATIO = 0.28;
const SCROLL_DELTA_EPSILON_PX = 0.5;
const AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT =
  "flowix:agent-thread-card-fullscreen-change";
const AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT =
  "flowix:agent-thread-card-request-fullscreen";
const AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS = 500;
// inputDraft 落盘 debounce ── 1s 静默期后把本地草稿写入 ProseMirror attrs。
// 见 AgentThreadCardView.scheduleDraftPersist 注释。 必须 flush 的时机:
// submit / destroy / input blur / 窗口 hidden ── 否则会丢稿 (ProseMirror
// attr 是 input 重新挂载时回填 input.value 的唯一来源)。
const AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS = 1000;

// 注: 二级弹窗走纯 CSS 定位 (right: 100% / top: 0), 不需要 JS
// 计算坐标所需的 viewport padding / offset / hide-delay 常量。

function buildTitle(prompt: string, fallback: string = ""): string {
  const title = stripSystemBlock(prompt).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 28) : fallback;
}

function getConversationRunLastRunAt(
  run: AgentConversationRun,
): number | undefined {
  return run.lastRunAt ?? run.endedAt ?? run.startedAt;
}

// 工具摘要: 解析" ```lang\ncode\n``` "围栏 / 行内 `code` / 优先取 language-x
// 类, 把 fenced code 渲染成与面板等效的 <pre><code class="lang-x">。
// marked 17 默认开启 GFM, 不用再注册 remark-gfm。
//
// 安全性: marked.parse() 直接走 HTML 输出, 对不可信输入要先 sanitize。
// 当前 ChatMessage.content 来源是后端 rllm agent 输出 (受控), 但仍
// 走一道最小过滤 ── 移除 <script> / on* 属性 / javascript: href。
// user 消息里的隐藏上下文由 messageView.visibleContent 提前剥离。
// 提取编辑器全文档作为'技能'上下文 ── ProseMirror doc 遍历, 跳过
// agentThreadCard 节点 (避免把卡片自身的内容 / metadata 当成笔记内容
// 喂给 LLM, 也避免 LLM 看到自己的 prompt 历史造成循环)。
//
// 实现要点:
//   - 用 view.state.doc.descendants 递归遍历, 在 callback 里
//     跳过 type.name === 'agentThreadCard' 的节点 (返回 false 不下钻)
//   - 收集每个 block 节点的 textContent, 用 '\n\n' 拼成 markdown-like 文本
//   - 保留原始块结构, 文本顺序与编辑器视觉顺序一致
//   - 空文档 / 全部是 card 的文档返回空字符串
//
// 简化: 不区分 heading / paragraph / list 等 markdown 语义, 全部按
// textContent 拼接 ── LLM 拿到的是'纯文本 + 双换行分块', 足够作为
// '当前笔记的技能/上下文'使用。markdown 完美序列化需要走 Tiptap 的
// renderMarkdown, 但那会把 agent card 也序列化 (前面讨论过), 改起来
// 工作量不成比例; 当前实现是 LLM 友好 + 维护简单的折中。
const AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX = 4;

interface AgentThreadCardHeaderDragState {
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
}

export class AgentThreadCardView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;

  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  private input: HTMLTextAreaElement;
  private sendButtonMount: HTMLSpanElement;
  private sendButtonRoot: Root;
  private body: HTMLElement;
  private composer: HTMLElement;
  // 输入框左侧 role 图标 ── 升级为 button (之前是 span), 让点击直接打开
  // 「选择角色」弹窗。 字段类型用 HTMLButtonElement, 以便调用 `.type = 'button'`
  // 等 button 专属 API (HTMLElement 上没有)。 HTMLElement 的所有 API
  // (replaceChildren / classList / setAttribute / addEventListener) 在 button
  // 上仍然可用 ── 不影响其它调用方。
  private composerRoleIcon: HTMLButtonElement;
  private container: HTMLDivElement;
  private header: HTMLDivElement;
  private headerDragState: AgentThreadCardHeaderDragState | null = null;
  private suppressNextHeaderClick = false;
  private titleEl: HTMLElement;
  private titleInput: HTMLInputElement | null = null;
  private titleBeforeEdit: string | null = null;
  // Agent 类型徽章 ── span (icon | type.name), 1.3rem 高, 1px 描边。
  // 详情与样式见 css/editor-agent-thread-card.css (.agent-type-badge 块,
  // 位于文件顶部、未加 .markdown-editor 限定)。这里三件套 (badge / icon / name)
  // 在构造器一次性创建并挂到 agentWrap, refreshAttrs 时只更新 src / alt /
  // textContent, 不重建 DOM (避免重渲染期间图标 src 短暂为空造成闪烁)。
  private badgeEl: HTMLSpanElement;
  private badgeIcon: HTMLImageElement;
  private badgeName: HTMLSpanElement;
  // 全屏时,hover Agent 类型徽章弹出 HoverCard(显示 SESSION ID + 复制按钮)。
  // React 挂载点 ── 与 badgeEl 并列放在 agentWrap, 全屏时由
  // syncBadgeHoverCardPosition 设为 absolute 定位覆盖到 badge 区域。
  // 不包 badgeEl: React.render(null) 会清空 mount 所有子节点。
  private badgeHoverCardMount: HTMLSpanElement;
  private badgeHoverCardRoot: Root;
  private badgeHoverCardTimer: ReturnType<typeof setInterval> | null = null;
  private metaEl: HTMLElement;
  private runStatusEl: HTMLSpanElement;
  private errorEl: HTMLElement;
  // 消息区底部 loading 指示器 ── 24px 固定高度, 始终挂在 body 末尾。
  // 容器永远在 DOM 里 (保证 24px 空间不被流式更新挤掉), 内部的文字
  // "思考中" 仅在 isLoading 为 true 时显示 ── 与面板 agent-thinking-indicator
  // 反馈保持一致。
  private loadingIndicator: HTMLDivElement;
  private collapseButton: HTMLButtonElement;
  private deleteButton: HTMLButtonElement;
  private fullscreenButton: HTMLButtonElement;
  private fullscreenLayout: FullscreenLayoutController;
  private composerDraft: ComposerDraftController;
  // 全屏 / 删除按钮之间的竖向分割线 ── 非交互元素, aria-hidden 让屏幕
  // 阅读器跳过; 视觉与按钮同高 (28px), 1px var(--border) 着色。
  // 可见性与 fullscreenButton 同步 (renderFullscreenState 一起切 hidden)。
  private actionsDivider: HTMLSpanElement;
  private accessButton: HTMLButtonElement;
  private accessPopover: HTMLDivElement;
  private accessPopoverController: AccessPopoverController;
  private externalAgentSettings: ExternalAgentSettingsController;
  private externalSettingsLoadedTypeKey: AgentTypeKey | null = null;
  private agentRolePicker: AgentRolePickerController;
  private unsubscribe?: () => void;
  private unsubscribeConversation?: () => void;
  private unsubscribeAccess?: () => void;
  private unsubscribeRuntime?: () => void;
  private unsubscribeNotebooks?: () => void;
  private readonly runtimeHandleId = createExternalAgentRuntimeHandle();
  private isCreating = false;
  private isComposing = false;
  // 输入历史导航游标 ── null = 不在导航态 (input 是当前草稿)。
  // 数组下标对应 user 消息在 currentThreadState().messages 中按 role=user
  // 过滤后、按时间顺序 (旧 → 新) 的索引。 Up/Down 跨边界时 clamp / 回到
  // preNavDraft 代表的"虚拟最新一条"。
  private historyCursor: number | null = null;
  // Draft captured before entering history navigation. It remains available
  // after returning to the virtual newest entry, so repeated Up/Down cycles and
  // extra Down presses do not replace the draft with a previewed history item.
  // It is cleared only when the user actually edits/submits the composer.
  private preNavDraft: string | null = null;
  private isLoadingThreadCache = false;
  private loadedThreadCacheFor: string | null = null;
  private loadingThreadCacheFor: string | null = null;
  private loadThreadCacheTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadThreadCacheIdleId: number | null = null;
  private isThreadCacheSettling = false;
  private threadCacheRevealFrame: number | null = null;
  private threadCacheVisibilityObserver: IntersectionObserver | null = null;
  private isThreadCacheViewportReady =
    typeof window === "undefined" || !("IntersectionObserver" in window);
  private renderedMessagesList: HTMLDivElement | null = null;
  private renderedMessageRefs: ThreadState["messages"] = [];
  private isDestroyed = false;
  private isFullscreen = false;
  private reasoningCollapsedOverrides = new Map<string, boolean>();
  private appliedResolvedSessionKeys = new Set<string>();
  // 上一帧折叠态, 仅用于识别'折叠→展开'瞬时事件触发置顶。
  private prevCollapsed: boolean = false;
  private shouldFollowBottom = true;
  private pendingHistoryScrollRestore: {
    threadId: string;
    scrollHeight: number;
    scrollTop: number;
  } | null = null;
  private boundHandleBodyScroll = (): void => {
    this.shouldFollowBottom = this.isBodyNearBottom();
    this.requestMoreHistoryIfNeeded();
    this.scheduleAccessPopoverPosition();
  };
  private boundHandleFullscreenKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.isFullscreen) {
      event.stopPropagation();
      this.setFullscreen(false);
    }
  };
  private boundHandleRequestFullscreen = (event: Event): void => {
    const detail = (event as CustomEvent<{
      element?: HTMLElement;
      threadId?: string | null;
      exitOthers?: boolean;
    }>).detail;
    const isTarget =
      detail?.element === this.dom ||
      (!!detail?.threadId && detail.threadId === this.threadId);

    if (isTarget) {
      this.setFullscreen(true);
      return;
    }

    if (detail?.exitOthers !== false && this.isFullscreen) {
      this.setFullscreen(false);
    }
  };
  private boundHandleCardMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || this.isFullscreen) return;
    const target = getEventElement(event);
    if (!target || !this.dom.contains(target)) return;

    const titleInput = this.titleInput;
    if (titleInput && target !== titleInput && !titleInput.contains(target)) {
      event.preventDefault();
      event.stopPropagation();
      this.dom.classList.remove("ProseMirror-selectednode");
      titleInput.blur();
      return;
    }

    if (isAgentThreadCardInteractiveTarget(target)) {
      event.stopPropagation();
      return;
    }

    if (isAgentThreadCardSelectableMessageText(target)) {
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  };
  private boundHandleHeaderPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.isFullscreen) return;
    const target = getEventElement(event);
    if (!target || !this.header.contains(target)) return;
    if (isAgentThreadCardInteractiveTarget(target)) return;
    if (target.closest(".agent-thread-card__title")) return;

    this.headerDragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    this.header.setPointerCapture(event.pointerId);
  };
  private boundHandleHeaderPointerMove = (event: PointerEvent): void => {
    const drag = this.headerDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.started) {
      if (
        Math.hypot(dx, dy) < AGENT_THREAD_CARD_HEADER_DRAG_THRESHOLD_PX
      )
        return;
      const pos = this.getPos?.();
      if (pos === undefined) {
        this.headerDragState = null;
        this.releaseHeaderPointerCapture(event.pointerId);
        return;
      }
      if (
        !startBlockDragForView(this.view, {
          pos,
          nodeSize: this.node.nodeSize,
        })
      ) {
        this.headerDragState = null;
        this.releaseHeaderPointerCapture(event.pointerId);
        return;
      }
      drag.started = true;
      this.dom.classList.add("agent-thread-card--dragging");
      this.setAccessPopoverOpen(false);
      this.setCodexSettingsPopoverOpen(false);
      this.setComposerRolePopoverOpen(false);
    }

    updateBlockDragPositionForView(this.view, event.clientX, event.clientY);
    event.preventDefault();
    event.stopPropagation();
  };
  private boundHandleHeaderPointerUp = (event: PointerEvent): void => {
    const drag = this.headerDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.headerDragState = null;
    if (drag.started) {
      dropBlockDragAtForView(this.view, event.clientX, event.clientY);
      this.finishHeaderDragInteraction();
      event.preventDefault();
      event.stopPropagation();
    }
    this.releaseHeaderPointerCapture(event.pointerId);
  };
  private boundHandleHeaderPointerCancel = (event: PointerEvent): void => {
    const drag = this.headerDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;

    this.headerDragState = null;
    if (drag.started) {
      cancelBlockDragForView(this.view);
      this.finishHeaderDragInteraction();
      event.preventDefault();
      event.stopPropagation();
    }
    this.releaseHeaderPointerCapture(event.pointerId);
  };
  private boundHandleHeaderClick = (event: MouseEvent): void => {
    if (!this.suppressNextHeaderClick) return;
    this.suppressNextHeaderClick = false;
    event.preventDefault();
    event.stopPropagation();
  };
  private releaseHeaderPointerCapture(pointerId: number): void {
    if (this.header.hasPointerCapture(pointerId)) {
      this.header.releasePointerCapture(pointerId);
    }
  }

  private finishHeaderDragInteraction(): void {
    this.dom.classList.remove("agent-thread-card--dragging");
    this.suppressNextHeaderClick = true;
    window.setTimeout(() => {
      this.suppressNextHeaderClick = false;
    }, 0);
  }

  private boundHandleOutsidePointerDown = (event: PointerEvent): void => {
    this.blurOwnedFocusForOutsidePointer(event);
  };
  /** 当前 AppLanguage ── NodeView 不在 React 树里, 不能用 useI18n,
   *  走 user-settings-store 读最新值 (跨窗口同步跟 I18nProvider 一致)。 */
  private get language(): AppLanguage {
    return useUserSettingsStore.getState().settings.language;
  }

  /** 翻译: NodeView 内部所有面向用户的字符串走这里, 切换语言时由
   *  rerender 文案刷新, 不依赖 React 重渲染整张卡片。 */
  private t(key: I18nKey): string {
    return translate(this.language, key);
  }

  /** 在语言切换后把卡片上的静态文案重新渲染 ── 状态/事件 (placeholder,
   *  aria-label, title, textContent 等) 需要手动同步。 默认 no-op, 子
   *  类按需覆盖 (这里是该方法的主要宿主, 因为它持有大量 DOM 元素)。 */
  protected syncLocalizedText(): void {
    // 子类按需覆盖
  }

  constructor(
    node: ProseMirrorNode,
    view: EditorView,
    getPos?: () => number | undefined,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("section");
    this.dom.className = "agent-thread-card";
    this.dom.contentEditable = "false";
    this.dom.tabIndex = -1;
    this.dom.dataset.agentThreadCard = "true";
    this.dom.addEventListener("mousedown", this.boundHandleCardMouseDown);

    // 内容容器 ── 卡片所有交互子元素 (header / body / error / composer) 都
    // 挂在 container 内, 由 container 负责 grid 布局 + max-height +
    // border (卡片根只承担背景色 + 圆角 + overflow 裁剪兜底, 不参与
    // 布局)。这层独立出来便于以后做"背景与内容分离"的样式调整 ──
    // 比如让根用图片背景, 内容层透传, 或者未来加 background-filter。
    this.container = document.createElement("div");
    this.container.className = "agent-thread-card__container";

    // 拦截 native selection 起手 ── 与 note-link/view-note.ts 卡片同源思路, 但
    // 用 document 捕获阶段 + this.dom.contains 二次过滤, 比挂 this.dom
    // 自身稳: 卡片内任何 descendant 节点起手都会被先一步拦下。
    //
    // 放行: textarea (composer 输入) / a (深链可拖选) / 消息文本
    // (用户拖拽选 AI 回复) ── 其余节点 (header 文字、按钮间空白、
    // 折叠态空 body) 一律不参与 native 文本选区。

    const header = document.createElement("div");
    header.className = "agent-thread-card__header";
    this.header = header;
    header.addEventListener("pointerdown", this.boundHandleHeaderPointerDown);
    header.addEventListener("pointermove", this.boundHandleHeaderPointerMove);
    header.addEventListener("pointerup", this.boundHandleHeaderPointerUp);
    header.addEventListener(
      "pointercancel",
      this.boundHandleHeaderPointerCancel,
    );
    header.addEventListener("click", this.boundHandleHeaderClick, true);

    const agentWrap = document.createElement("div");
    agentWrap.className = "agent-thread-card__agent";

    // 头部左侧: Agent 类型徽章 (icon + type.name) + 对话标题。
    // 徽章是通用 .agent-type-badge span ── 左 icon 右非加粗 type 名,
    // 总高 1.3rem, 1px var(--border) 描边。图标 src 从 agent-types.ts 集中
    // 管理 (Vite import 解析后的图片 URL), 按 typeKey 动态读取 ── 与
    // 与 thread card 头部 AgentTypeSwitcher 同源。
    //
    // 类型名从 title 移到 badge 里: badge 显式表达'当前 type', title 只
    // 承担对话标题 ── 避免'Flowix · Flowix · 我的对话'这种视觉重复。
    // 多 Agent 视觉区分配色方案在 chat-store 侧 message role 上做, 这里
    // 视觉区分通过 badge 自身 (type 图标 + name) 已经足够。
    this.badgeEl = document.createElement("span");
    this.badgeEl.className = "agent-type-badge";

    this.badgeIcon = document.createElement("img");
    this.badgeIcon.className = "agent-type-badge__icon";
    this.badgeIcon.draggable = false;
    this.badgeIcon.alt = "";

    // badge 改为纯 icon (h-6 w-6 视觉), 不再渲染 type 名称 ──
    // type 名已在 badgeHoverCard 的 content 里完整呈现 (全屏时 hover
    // 弹卡片), header 上不重复显示, 节省水平空间, 让对话标题更宽。
    this.badgeName = document.createElement("span");
    this.badgeName.className = "agent-type-badge__name";
    this.badgeName.hidden = true;

    this.badgeEl.append(this.badgeIcon, this.badgeName);

    this.titleEl = document.createElement("div");
    this.titleEl.className = "agent-thread-card__title";
    this.titleEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.startTitleEdit();
    });

    // React 挂载点 ── 与 badgeEl 并列放在 agentWrap,自身 absolute 定位
    // 到 badge 区域上方(覆盖层)。 不包 badgeEl: React.render(null) 会
    // 清空 mount 所有子节点,会让 badge 一起消失。
    this.badgeHoverCardMount = document.createElement("span");
    this.badgeHoverCardMount.className =
      "agent-thread-card__badge-hover-card-mount";
    this.badgeHoverCardMount.setAttribute("aria-hidden", "true");
    agentWrap.append(this.badgeEl, this.badgeHoverCardMount, this.titleEl);
    this.badgeHoverCardRoot = createRoot(this.badgeHoverCardMount);
    // 构造时非全屏, mount 默认 display: none (CSS 控制), 此处
    // render(null) 让 React 端不挂任何 trigger/content。
    this.renderBadgeHoverCard();

    this.metaEl = document.createElement("div");
    this.metaEl.className = "agent-thread-card__meta";

    this.runStatusEl = document.createElement("span");
    this.runStatusEl.className =
      "agent-thread-card__run-status agent-thread-card__run-status--idle";
    this.runStatusEl.textContent = "";
    this.runStatusEl.hidden = true;

    // 单独包一层让 meta 与按钮在视觉上"同组", 标题撑满剩余空间。
    const actions = document.createElement("div");
    actions.className = "agent-thread-card__actions";

    // 删除按钮 ── 放在折叠按钮左侧 (与折叠共同构成 header 右侧 actions 区)。
    //
    // 行为: 走 ProseMirror 标准 delete 范式 ── state.tr.delete(pos, pos+nodeSize)
    // + dispatch ── 与 image/video/file attachment 三个 NodeView
    // 的 deleteNode() 完全一致, 不引入新机制。deleteNode 钩子本身留给键盘 / slash menu
    // 等场景, 这里 UI 入口直接做同样的删除事务, 保证行为统一。
    //
    // 范围: 只删 ProseMirror 节点 (即这张卡片从笔记里消失), 不删后端 thread 数据。
    // thread 是后端资产, 可能在其他笔记中引用, 删卡片等同于'从这篇
    // 笔记里撤掉引用', 用户想清空 thread 数据走 thread 列表的'删除对话'。
    //
    // 视觉: lucide Trash2 (24x24 viewBox, stroke 2), 与 createChevronIcon 同款
    // stroke 风格, 14×14 渲染。aria-label 用'删除对话'。
    this.deleteButton = document.createElement("button");
    this.deleteButton.type = "button";
    this.deleteButton.className =
      "agent-thread-card__icon-btn agent-thread-card__delete";
    this.deleteButton.setAttribute(
      "aria-label",
      this.t("editor.threadCard.delete"),
    );
    this.deleteButton.append(createTrashIcon());
    this.deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const pos = this.getPos?.();
      if (pos === undefined) return;
      const tr = this.view.state.tr.delete(pos, pos + this.node.nodeSize);
      this.view.dispatch(tr);
    });

    this.fullscreenButton = document.createElement("button");
    this.fullscreenButton.type = "button";
    this.fullscreenButton.className =
      "agent-thread-card__icon-btn agent-thread-card__fullscreen";
    this.fullscreenButton.setAttribute(
      "aria-label",
      this.t("editor.threadCard.enterFullscreen"),
    );
    this.fullscreenButton.append(createFullscreenIcon("enter"));
    this.fullscreenButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleFullscreen();
    });

    // 全屏 / 删除按钮之间的竖向分割线 ── 1px 宽 × 16px 高, 视觉
    // 上把"视图操作 (全屏)"与"破坏性操作 (删除)"明确分组。CSS 用
    // background-color + var(--border) 着色 + 圆角, 不画边框, 避免
    // 28px 高的容器里 1px border 因 box-sizing 撑大尺寸。
    this.actionsDivider = document.createElement("span");
    this.actionsDivider.className = "agent-thread-card__actions-divider";
    this.actionsDivider.setAttribute("aria-hidden", "true");
    this.actionsDivider.hidden = true;

    this.collapseButton = document.createElement("button");
    this.collapseButton.type = "button";
    this.collapseButton.className =
      "agent-thread-card__icon-btn agent-thread-card__collapse";
    this.collapseButton.setAttribute(
      "aria-label",
      this.t("editor.threadCard.collapse"),
    );
    this.collapseButton.append(createChevronIcon("down"));
    this.collapseButton.addEventListener("click", (event) => {
      // 阻止事件冒泡, 避免与卡片根 mousedown 处理互相干扰。
      event.stopPropagation();
      this.toggleCollapsed();
    });

    // header 右侧 actions 顺序: meta | delete | 分割线 | fullscreen | collapse。
    // 调换: 删除按钮放到全屏左侧 ── 与"破坏性操作 (删除)" 隔一根分割线
    // 分组, 视图操作 (全屏) 与破坏性操作视觉上分开, 减少误删概率。
    actions.append(
      this.metaEl,
      this.deleteButton,
      this.actionsDivider,
      this.fullscreenButton,
      this.collapseButton,
    );
    header.append(agentWrap, actions);

    this.body = document.createElement("div");
    this.body.className = "agent-thread-card__body";
    // flowix:// 深链委托挂在容器层, 不随消息全量回放反复绑
    // (renderThreadState 会 this.body.replaceChildren(), 挂到子节点会泄漏)。
    this.body.addEventListener("click", this.handleBodyClick);
    this.body.addEventListener("scroll", this.boundHandleBodyScroll, {
      passive: true,
    });

    // 消息区底部 loading 指示器 ── 24px 固定高度, 始终挂 body 末尾。
    // 一次性创建, renderThreadState 里反复 append 是 DOM 复用 ── 与
    // 容器始终存在保证 24px 空间不被流式
    // 更新挤掉 (否则流式追加新消息时高度会跳一下)。
    //
    // 视觉 ── 与面板 agent-thinking-indicator 同源: 跳动小圆点 + 文字
    // "思考中"。圆点用 agentThinkingDot 关键帧 (styles/index.css 全局),
    // 文字 hidden 由 renderThreadState 切 isLoading 控制。
    this.loadingIndicator = document.createElement("div");
    this.loadingIndicator.className = "agent-thread-card__loading-indicator";

    const loadingDot = document.createElement("span");
    loadingDot.className = "agent-thread-card__loading-dot";
    loadingDot.setAttribute("aria-hidden", "true");

    const loadingText = document.createElement("span");
    loadingText.className = "agent-thread-card__loading-text";
    loadingText.textContent = this.t("editor.threadCard.thinking");
    loadingText.hidden = true;

    this.loadingIndicator.append(loadingDot, loadingText);

    this.errorEl = document.createElement("div");
    this.errorEl.className = "agent-thread-card__error";
    this.errorEl.hidden = true;

    const composer = document.createElement("div");
    composer.className = "agent-thread-card__composer";
    this.composer = composer;

    // 输入框左侧 role 图标 ── 升级为 button, 让点击直接打开「选择角色」弹窗。
    // 之前是 <span hidden=true>, 用户在未设置角色时看不到入口, 必须从右侧
    // `accessButton` 进入「可访问文件」弹窗再 hover「角色」才能选 ── 路径
    // 太深。 改成始终可见的 button, 未设置时显示 UserCircleDashedIcon (虚线
    // 占位), 设置后显示 memo 文档图标; 点击直接 toggleComposerRolePopover(),
    // 单级直达角色选择面板 (无二级展开)。
    //
    // aria-* 与文件内其它 trigger button (accessButton / collapseButton
    // 等) 完全同构: aria-haspopup="menu" 表达"打开的是菜单型弹窗",
    // aria-expanded 由 setComposerRolePopoverOpen 切换, 同步反映给屏幕阅读器。
    this.composerRoleIcon = document.createElement("button");
    this.composerRoleIcon.type = "button";
    this.composerRoleIcon.className = "agent-thread-card__composer-role-icon";
    this.composerRoleIcon.setAttribute("aria-haspopup", "menu");
    this.composerRoleIcon.setAttribute("aria-expanded", "false");
    this.composerRoleIcon.setAttribute(
      "aria-label",
      this.t("editor.threadCard.selectRole"),
    );
    this.composerRoleIcon.title = this.t("editor.threadCard.roleIconTooltip");

    this.input = document.createElement("textarea");
    this.input.rows = 1;
    this.input.placeholder = this.t("editor.threadCard.inputPlaceholder");
    this.input.value = this.inputDraft;
    this.input.addEventListener("keydown", (event) => {
      if (this.isComposing || event.isComposing || event.keyCode === 229)
        return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
          return;
        if (!this.shouldHandleHistoryKey(event.key)) return;
        event.preventDefault();
        this.navigateHistory(event.key === "ArrowUp" ? "up" : "down");
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      void this.submit();
    });
    this.input.addEventListener("compositionstart", () => {
      this.isComposing = true;
    });
    this.input.addEventListener("compositionend", () => {
      this.isComposing = false;
    });
    // 多行检测: 内容超过 min-height 时给 composer 切换 align-items (居中 → 贴底)。
    // 阈值比 min-height (48px) 略高, 留 2px 抗亚像素抖动。
    this.input.addEventListener("input", () => {
      // Only leave history navigation when the visible text diverges from the
      // selected history entry. Cursor movement and no-op input events should
      // keep the current history index as the Up/Down baseline.
      if (!this.isCurrentHistoryEntryUnmodified()) {
        this.resetHistoryNavigation();
      }
      this.persistInputDraft(this.input.value);
      this.updateMultiLineState();
    });
    // 失焦时立即落盘 ── 用户点别处时 (例如切去别的卡片 / 触发 send 按钮)
    // 不应等满 1s debounce。 这是 inputDraft 跨卡片挂载回填的最后保障。
    this.input.addEventListener("blur", () => {
      this.flushPendingDraft();
    });

    this.accessButton = document.createElement("button");
    this.accessButton.type = "button";
    this.accessButton.className = "agent-thread-card__access-trigger";
    this.accessButton.textContent = this.t("editor.threadCard.accessButton");
    this.accessButton.setAttribute("aria-haspopup", "menu");
    this.accessButton.setAttribute("aria-expanded", "false");
    this.accessButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setAccessPopoverOpen(!this.accessPopoverController.isOpen);
    });

    this.accessPopover = document.createElement("div");
    this.accessPopover.className = "agent-thread-card__access-popover";
    this.accessPopover.setAttribute("role", "menu");
    this.accessPopover.hidden = true;
    this.accessPopover.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    this.accessPopover.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    document.body.appendChild(this.accessPopover);

    const codexSettingsPopover = document.createElement("div");
    codexSettingsPopover.className =
      "agent-thread-card__codex-settings-popover";
    codexSettingsPopover.setAttribute("role", "menu");
    codexSettingsPopover.hidden = true;
    codexSettingsPopover.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    codexSettingsPopover.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    document.body.appendChild(codexSettingsPopover);
    this.externalAgentSettings = new ExternalAgentSettingsController({
      popover: codexSettingsPopover,
      getTypeKey: () => this.typeKey,
      getLanguage: () => this.language,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      isAccessPopoverOpen: () => this.accessPopoverController.isOpen,
      setAccessPopoverOpen: (open, anchor = null, preferBelow = false) => {
        this.setAccessPopoverOpen(open, anchor, preferBelow);
      },
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
    });

    // composerRolePopover ── 角色选择下拉弹窗, 直接挂在 composerRoleIcon
    // button 下方/上方, 不再嵌套在 accessPopover 里。 构造器一次性创建,
    // 挂到 document.body, 后续 renderRoleOptionsList 在它内部 replaceChildren
    // 复用 ── 与 accessPopover 同一套"单例 + replaceChildren"模式, 不
    // 每次重建节点 (避免反复 bind event listener / ResizeObserver)。
    const composerRolePopover = document.createElement("div");
    composerRolePopover.className =
      "agent-thread-card__composer-role-popover";
    composerRolePopover.setAttribute("role", "menu");
    composerRolePopover.hidden = true;
    // 阻止 mousedown / click 冒泡 ── 弹窗内部的点击不应该触发卡片根
    // mousedown 处理 (避免 composer mousedown 把焦点抢到 textarea), 也
    // 不应该冒泡到 outside-click listener 把"选角色"误判为 outside 而
    // 关闭弹窗。 boundHandleComposerRoleOutsidePointer 的 allowlist
    // 已包含 composerRolePopover 自身 ── 内部点击不会被判 outside。
    composerRolePopover.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    composerRolePopover.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    document.body.appendChild(composerRolePopover);
    this.agentRolePicker = new AgentRolePickerController({
      trigger: this.composerRoleIcon,
      popover: composerRolePopover,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      getCurrentMemoId: () => this.agentRoleMemoId,
      getCurrentName: () => this.agentRoleName,
      getMessageCount: () => this.currentMessages().length,
      updateRole: (role) => this.updateAgentRole(role),
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
    });
    this.accessPopoverController = new AccessPopoverController({
      button: this.accessButton,
      popover: this.accessPopover,
      t: (key) => this.t(key),
      isDestroyed: () => this.isDestroyed,
      isInsideRelatedTarget: (target) =>
        !!(
          this.externalAgentSettings.filesControl?.contains(target) ||
          this.composerRoleIcon.contains(target)
      ),
      consumeOutsidePointer: consumeEditorPopoverDismissPointer,
    });
    this.fullscreenLayout = new FullscreenLayoutController({
      dom: this.dom,
      isFullscreen: () => this.isFullscreen,
      isDestroyed: () => this.isDestroyed,
      getTitlebarHeight: () =>
        isWindowsPlatform() ? WINDOWS_TITLEBAR_HEIGHT_PX : 0,
      minExitTopPx: FULLSCREEN_EXIT_FALLBACK_MIN_TOP_PX,
      maxExitTopPx: FULLSCREEN_EXIT_FALLBACK_MAX_TOP_PX,
      exitTopRatio: FULLSCREEN_EXIT_FALLBACK_TOP_RATIO,
      scrollDeltaEpsilonPx: SCROLL_DELTA_EPSILON_PX,
    });
    this.composerDraft = new ComposerDraftController({
      persistDelayMs: AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS,
      persist: (draft) => this.updateAttrs({ inputDraft: draft }),
    });

    this.sendButtonMount = document.createElement("span");
    this.sendButtonMount.className = "agent-thread-card__send-tooltip";
    this.sendButtonRoot = createRoot(this.sendButtonMount);
    this.renderSendButton(false, true);

    composer.append(
      this.composerRoleIcon,
      this.input,
      this.accessButton,
      this.sendButtonMount,
    );
    // 点击 composer 空白区域 ── 自动聚焦 textarea; stopPropagation
    // 阻止冒泡到 card 根 mousedown 处理, 避免 focus 状态互相影响
    // 整张卡片 (与"聚焦输入"语义冲突)。textarea / button 自身的点击
    // 已经处理 focus / submit, 不需要额外逻辑 ── closest 短路放行。
    this.composer.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest("textarea, button")) return;
      event.stopPropagation();
      focusWithoutScroll(this.input);
    });
    this.dom.append(this.container);
    this.container.append(header, this.body, this.errorEl, composer);

    this.refreshAttrs();
    this.renderThreadState();
    window.addEventListener(
      AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT,
      this.boundHandleRequestFullscreen,
    );
    document.addEventListener(
      "pointerdown",
      this.boundHandleOutsidePointerDown,
      true,
    );
    this.subscribe();
    this.subscribeAccessPopover();
    this.updateMultiLineState();
    this.observeThreadCacheVisibility();
    this.requestThreadMessagesIfNeeded();
    this.runInitialPromptIfNeeded();
  }

  private get threadId(): string | null {
    return (
      this.instance?.threadId ||
      (this.node.attrs.threadId as string | null) ||
      null
    );
  }

  private get runtimeThreadId(): string | null {
    return getExternalAgentRuntimeThreadId(this.runtimeHandleId, this.threadId);
  }

  private get renderThreadId(): string | null {
    const threadId = this.runtimeThreadId;
    return getResolvedExternalSessionId(threadId) ?? threadId;
  }

  private get title(): string {
    const attrTitle = ((this.node.attrs.title as string | null) ?? "").trim();
    const typeKey = normalizeAgentTypeKey(this.node.attrs.typeKey as string | null);
    const instanceTitle = this.instance?.title;
    if (instanceTitle && !(attrTitle && this.isDefaultExternalTitle(instanceTitle, typeKey))) {
      return instanceTitle;
    }

    const threadId = this.threadId;
    if (threadId) {
      const state = useChatStore.getState();
      const listTitle = state.threadLists[typeKey]?.find(
        (item) => item.threadId === threadId,
      )?.title;
      if (listTitle && !(attrTitle && this.isDefaultExternalTitle(listTitle, typeKey))) {
        return listTitle;
      }
      if (state.activeThreadIds[typeKey] === threadId) {
        const activeTitle = state.currentThreadTitles[typeKey];
        if (activeTitle && !(attrTitle && this.isDefaultExternalTitle(activeTitle, typeKey))) {
          return activeTitle;
        }
      }
    }

    return attrTitle;
  }

  private isDefaultExternalTitle(title: string, typeKey: AgentTypeKey): boolean {
    const normalized = title.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) return false;
    if (typeKey === "codex") {
      return normalized === this.t("agent.codexSession.title").toLowerCase();
    }
    if (typeKey === "claude") {
      return normalized === this.t("agent.claudeSession.title").toLowerCase();
    }
    return normalized === `${getAgentType(typeKey).name} session`.toLowerCase();
  }

  private get typeKey(): AgentTypeKey {
    return this.instance?.agentType ?? normalizeAgentTypeKey(this.node.attrs.typeKey as string | null);
  }

  private get instanceId(): string | null {
    const value = this.node.attrs.instanceId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get instance() {
    return useAgentConversationStore.getState().getInstance(this.instanceId);
  }

  private get agentRoleMemoId(): string | null {
    const instanceValue = this.instance?.role?.memoId;
    if (typeof instanceValue === "string" && instanceValue.trim()) {
      return instanceValue.trim();
    }
    const value = this.node.attrs.agentRoleMemoId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get agentRoleName(): string | null {
    const instanceValue = this.instance?.role?.name;
    if (typeof instanceValue === "string" && instanceValue.trim()) {
      return instanceValue.trim();
    }
    const value = this.node.attrs.agentRoleName;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private get collapsed(): boolean {
    return !!this.node.attrs.collapsed;
  }

  private get inputDraft(): string {
    const value = this.node.attrs.inputDraft;
    return typeof value === "string" ? value : "";
  }

  private persistInputDraft(value: string): void {
    const { nextDraft, oversizedDomValue } = getPersistableInputDraft(
      value,
      AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS,
    );
    this.composerDraft.setOversizedValue(oversizedDomValue);
    if (nextDraft === this.inputDraft) return;
    this.scheduleDraftPersist(nextDraft);
  }

  // 把"待落盘的草稿"延后到 1s 静默期后批量写 ProseMirror attrs ──
  // 直接 updateAttrs 每个按键会触发 ProseMirror 事务 + update(node)
  // 全量重建 body 消息列表, 50 条对话下肉眼可见输入卡顿。 1s debounce
  // 把"密集按键"合并为单次落盘; 草稿本身在 input.value 里始终是"最新"
  // (ProseMirror 事务只持久化, 不参与实时编辑), 用户感知不到延迟。
  //
  // 边界 ──
  //   - inputDraft 落盘后才能跨卡片重新挂载时回填, 故 submit / destroy /
  //     blur / 不可见 时必须 flushPendingDraft(), 避免丢稿。
  //   - 落盘前如果 ProseMirror 派发了其它 update(node) (例如新消息到达),
  //     refreshAttrs 不覆写 input.value, 保护用户正在键入的 DOM 内容。
  //     对 input.value 的覆写, 保护用户正在键入的内容。
  private scheduleDraftPersist(nextDraft: string): void {
    this.composerDraft.schedule(nextDraft);
  }

  private flushPendingDraft(): void {
    this.composerDraft.flush();
  }

  private consumeInitialPrompt(): string | null {
    const initialPrompt =
      typeof this.node.attrs.initialPrompt === "string"
        ? this.node.attrs.initialPrompt.trim()
        : "";
    if (!initialPrompt || !this.node.attrs.autoSubmit) return null;

    this.updateAttrs({ initialPrompt: null, autoSubmit: false });
    return initialPrompt;
  }

  private runInitialPromptIfNeeded(): void {
    const initialPrompt = this.consumeInitialPrompt();
    if (!initialPrompt) return;

    this.input.value = initialPrompt;
    this.updateMultiLineState();

    requestAnimationFrame(() => {
      if (this.isDestroyed) return;
      void this.submit();
    });
  }

  private subscribe(): void {
    const unsubscribeThread = useChatStore.subscribe(
      (state) => {
        const threadId = this.runtimeThreadId;
        const renderThreadId = this.renderThreadId;
        const storedThreadId =
          (this.node.attrs.threadId as string | null) || null;
        const resolvedSessionId =
          getResolvedExternalSessionId(threadId) ??
          getResolvedExternalSessionId(storedThreadId);
        const localThreadId =
          threadId && isLocalExternalThreadId(threadId, this.typeKey)
            ? threadId
            : storedThreadId &&
                isLocalExternalThreadId(storedThreadId, this.typeKey)
              ? storedThreadId
              : null;
        return {
          threadId,
          renderThreadId,
          nextThreadState: renderThreadId
            ? state.threadStates[renderThreadId]
            : undefined,
          resolvedSessionId,
          localThreadId,
        };
      },
      (next) => {
        this.renderThreadState();
        if (
          (this.typeKey === "codex" || this.typeKey === "claude") &&
          next.localThreadId &&
          next.resolvedSessionId
        ) {
          this.applyResolvedExternalSessionId(
            next.localThreadId,
            next.resolvedSessionId,
            this.typeKey,
          );
        } else if (
          (this.typeKey === "codex" || this.typeKey === "claude") &&
          next.threadId &&
          isLocalExternalThreadId(next.threadId, this.typeKey) &&
          next.nextThreadState &&
          !next.nextThreadState.isLoading &&
          !next.nextThreadState.activeRunId
        ) {
          const localThreadId = next.threadId;
          void resolveExternalSessionId(localThreadId, this.typeKey).then(
            (sessionId) => {
              if (sessionId && sessionId !== localThreadId) {
                this.applyResolvedExternalSessionId(
                  localThreadId,
                  sessionId,
                  this.typeKey,
                );
              }
            },
          );
        }
      },
      {
        equalityFn: (a, b) =>
          a.threadId === b.threadId &&
          a.renderThreadId === b.renderThreadId &&
          a.nextThreadState === b.nextThreadState &&
          a.resolvedSessionId === b.resolvedSessionId &&
          a.localThreadId === b.localThreadId,
      },
    );

    const unsubscribeSettings = useChatStore.subscribe(
      (state) => ({
        agentPermissionMode: state.agentPermissionMode,
        agentCodexModel: state.agentCodexModel,
        agentCodexReasoningEffort: state.agentCodexReasoningEffort,
      }),
      () => {
        this.refreshExternalAgentEmptySettings();
        if (this.externalAgentSettings.isOpen) {
          this.renderCodexSettingsPopover();
        }
      },
      {
        equalityFn: (a, b) =>
          a.agentPermissionMode === b.agentPermissionMode &&
          a.agentCodexModel === b.agentCodexModel &&
          a.agentCodexReasoningEffort === b.agentCodexReasoningEffort,
      },
    );

    this.unsubscribe = () => {
      unsubscribeThread();
      unsubscribeSettings();
    };

    this.unsubscribeConversation = useAgentConversationStore.subscribe(
      (state) => {
        const instanceId = this.instanceId;
        const threadId = this.renderThreadId;
        return {
          instance: instanceId ? state.instances[instanceId] : undefined,
          messageState: threadId ? state.messageStates[threadId] : undefined,
        };
      },
      (next, previous) => {
        if (next.instance !== previous.instance) this.refreshAttrs();
        this.renderThreadState();
      },
      {
        equalityFn: (a, b) =>
          a.instance === b.instance && a.messageState === b.messageState,
      },
    );
  }

  private subscribeAccessPopover(): void {
    this.unsubscribeAccess = useAgentAccessStore.subscribe(() => {
      // agent-access 状态变化 (toggle / setWorkspace / addFolder /
      // removeFolder / loadInitial) 都可能改变主空间指向, 同步刷新 label。
      this.refreshExternalAgentEmptySettings();
      if (this.accessPopoverController.isOpen) this.renderAccessPopover();
    });
    this.unsubscribeRuntime = useAgentRuntimeStore.subscribe(() => {
      this.syncAgentRuntimeBadge();
    });
    this.unsubscribeNotebooks = useMemoStore.subscribe(() => {
      if (this.accessPopoverController.isOpen) this.renderAccessPopover();
    });
  }

  private loadCodexDefaultModel(): void {
    this.externalAgentSettings.loadDefaultModel();
  }

  private setAccessPopoverOpen(
    open: boolean,
    anchor: HTMLElement | null = null,
    preferBelow = false,
  ): void {
    this.accessPopoverController.setOpen(open, anchor, preferBelow);
  }

  private renderAccessPopover(): void {
    this.accessPopoverController.render();
  }

  private createExternalAgentEmptySettings(): HTMLElement {
    return this.externalAgentSettings.createEmptySettings();
  }

  private refreshExternalAgentEmptySettings(): void {
    this.externalAgentSettings.refreshEmptySettings();
  }

  private setCodexSettingsPopoverOpen(
    open: boolean,
    kind: AgentRuntimeSettingKind | null = null,
    anchor: HTMLButtonElement | null = null,
  ): void {
    this.externalAgentSettings.setSettingsPopoverOpen(open, kind, anchor);
  }

  private renderCodexSettingsPopover(): void {
    this.externalAgentSettings.renderPopover();
  }

  private updateAgentRole(role: { memoId: string; name: string }): void {
    this.updateAttrs({
      agentRoleMemoId: role.memoId,
      agentRoleName: role.name,
    });

    const instanceId = this.instanceId;
    if (!instanceId) return;
    useAgentConversationStore.getState().upsertInstance(instanceId, {
      role,
    });
  }

  private async loadAgentRoleBody(memoId: string): Promise<string | null> {
    return this.agentRolePicker.loadRoleBody(memoId);
  }

  private setComposerRolePopoverOpen(open: boolean): void {
    this.agentRolePicker.setOpen(open);
  }

  private refreshComposerRoleIcon(): void {
    this.agentRolePicker.refreshIcon();
  }

  private scheduleAccessPopoverPosition(): void {
    this.accessPopoverController.schedulePosition();
  }

  private applyResolvedExternalSessionId(
    threadId: string,
    sessionId: string,
    typeKey: AgentTypeKey = this.typeKey,
  ): void {
    const resolutionKey = `${threadId}->${sessionId}`;
    if (
      !sessionId ||
      sessionId === threadId ||
      this.appliedResolvedSessionKeys.has(resolutionKey) ||
      this.isDestroyed ||
      (
        this.runtimeThreadId !== threadId &&
        this.threadId !== sessionId &&
        (this.node.attrs.threadId as string | null) !== threadId
      )
    ) {
      return;
    }
    this.appliedResolvedSessionKeys.add(resolutionKey);
    applyResolvedExternalSession(
      this.runtimeHandleId,
      threadId,
      sessionId,
      typeKey,
    );
    if (this.instanceId) {
      useAgentConversationStore.getState().updateThread(this.instanceId, {
        agentType: typeKey,
        threadId: sessionId,
      });
    }
    this.updateAttrs({
      threadId: sessionId,
      typeKey,
    });
  }

  private scheduleLoadThreadCache(): void {
    const threadId = this.threadId;
    if (!threadId || this.isDestroyed || !this.shouldLoadThreadMessages())
      return;
    if (
      this.loadedThreadCacheFor === threadId ||
      this.loadingThreadCacheFor === threadId
    )
      return;

    this.loadingThreadCacheFor = threadId;
    this.isLoadingThreadCache = true;
    this.isThreadCacheSettling = false;
    this.cancelThreadCacheRevealFrame();
    this.renderThreadState();

    const run = async (): Promise<void> => {
      try {
        if (!this.isDestroyed && this.threadId === threadId) {
          const typeKey = this.typeKey;
          const result = await loadAgentThreadCardCache({ threadId, typeKey });
          if (result.resolvedSessionId) {
            this.applyResolvedExternalSessionId(
              threadId,
              result.resolvedSessionId,
              typeKey,
            );
            return;
          }
          this.loadedThreadCacheFor = threadId;
        }
      } finally {
        if (this.loadingThreadCacheFor === threadId) {
          this.loadingThreadCacheFor = null;
          this.isLoadingThreadCache = false;
        }
        if (!this.isDestroyed && this.threadId === threadId) {
          const hasLoadedMessages = this.currentMessages().length > 0;
          if (!hasLoadedMessages) {
            this.isThreadCacheSettling = false;
            this.renderThreadState();
            return;
          }
          this.isThreadCacheSettling = true;
          this.renderThreadState();
          this.cancelThreadCacheRevealFrame();
          this.threadCacheRevealFrame = window.requestAnimationFrame(() => {
            this.threadCacheRevealFrame = null;
            if (this.isDestroyed || this.threadId !== threadId) return;
            this.isThreadCacheSettling = false;
            this.renderThreadState();
          });
        }
      }
    };

    if ("requestIdleCallback" in window) {
      this.loadThreadCacheIdleId = window.requestIdleCallback(
        () => {
          this.loadThreadCacheIdleId = null;
          void run();
        },
        { timeout: 1200 },
      );
    } else {
      this.loadThreadCacheTimeout = globalThis.setTimeout(() => {
        this.loadThreadCacheTimeout = null;
        void run();
      }, 300);
    }
  }

  private shouldLoadThreadMessages(): boolean {
    return (
      (!this.collapsed || this.isFullscreen) &&
      (this.isThreadCacheViewportReady || this.isFullscreen)
    );
  }

  private requestThreadMessagesIfNeeded(): void {
    if (this.shouldLoadThreadMessages()) {
      this.scheduleLoadThreadCache();
      return;
    }
    this.cancelScheduledThreadCacheLoad();
  }

  private observeThreadCacheVisibility(): void {
    if (
      this.isThreadCacheViewportReady ||
      this.threadCacheVisibilityObserver ||
      typeof window === "undefined" ||
      !("IntersectionObserver" in window)
    ) {
      return;
    }

    this.threadCacheVisibilityObserver = new IntersectionObserver(
      (entries) => {
        if (this.isDestroyed || !entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        this.isThreadCacheViewportReady = true;
        this.threadCacheVisibilityObserver?.disconnect();
        this.threadCacheVisibilityObserver = null;
        this.requestThreadMessagesIfNeeded();
      },
      { root: null, rootMargin: "600px 0px", threshold: 0 },
    );
    this.threadCacheVisibilityObserver.observe(this.dom);
  }

  private cancelScheduledThreadCacheLoad(): void {
    const hadScheduledLoad =
      this.loadThreadCacheTimeout !== null ||
      this.loadThreadCacheIdleId !== null;
    if (this.loadThreadCacheTimeout !== null) {
      globalThis.clearTimeout(this.loadThreadCacheTimeout);
      this.loadThreadCacheTimeout = null;
    }
    if (this.loadThreadCacheIdleId !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(this.loadThreadCacheIdleId);
      this.loadThreadCacheIdleId = null;
    }
    if (hadScheduledLoad && this.loadingThreadCacheFor) {
      this.loadingThreadCacheFor = null;
      this.isLoadingThreadCache = false;
      this.isThreadCacheSettling = false;
      this.renderThreadState();
    }
  }

  private updateAttrs(attrs: Record<string, unknown>): void {
    const pos = this.getPos?.();
    if (pos === undefined) return;

    const nextAttrs = { ...this.node.attrs, ...attrs };
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs),
    );
    // 不再手动调 refreshAttrs / renderThreadState / requestThreadMessagesIfNeeded
    // ── ProseMirror 派发 update(node) 回调会做这些 (且会按 update(node) 里的
    // 消息影响检测决定走 lite / full 路径)。 旧代码这里手动调一次, 加上
    // ProseMirror 自己的回调, 等于每个 updateAttrs 双倍开销 ── 50 条对话
    // 下肉眼可见的输入卡顿的成因之一。
    //
    // this.node 也由 update(node) 内部统一刷新, 这里不再手动赋值, 避免
    // update(node) 拿到旧 this.node 做 attrs diff 时出现 false negative。
  }

  private startTitleEdit(): void {
    if (this.titleInput) return;

    const currentTitle = this.title;
    this.titleBeforeEdit = currentTitle;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "agent-thread-card__title-input";
    input.value = currentTitle;
    input.setAttribute("aria-label", "重命名对话");
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        void this.commitTitleEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.cancelTitleEdit();
      }
    });
    input.addEventListener("blur", () => {
      void this.commitTitleEdit();
    });

    this.titleInput = input;
    this.titleEl.replaceChildren(input);
    focusWithoutScroll(input);
    input.select();
  }

  private cancelTitleEdit(): void {
    const previousTitle = this.titleBeforeEdit ?? this.title;
    this.titleInput = null;
    this.titleBeforeEdit = null;
    this.titleEl.textContent = previousTitle;
  }

  private async commitTitleEdit(): Promise<void> {
    const input = this.titleInput;
    if (!input) return;

    const previousTitle = this.titleBeforeEdit ?? this.title;
    const nextTitle = input.value.replace(/\s+/g, " ").trim();
    this.titleInput = null;
    this.titleBeforeEdit = null;

    if (!nextTitle || nextTitle === previousTitle) {
      this.titleEl.textContent = previousTitle;
      return;
    }

    const threadId = this.threadId;
    const instanceId = this.instanceId;
    if (!threadId && !instanceId) {
      this.titleEl.textContent = previousTitle;
      return;
    }

    this.titleEl.textContent = nextTitle;
    this.updateAttrs({ title: nextTitle });

    await useChatStore
      .getState()
      .renameAgentConversation({
        instanceId,
        threadId,
        title: nextTitle,
        typeKey: this.typeKey,
      });
  }

  private refreshAttrs(): void {
    this.dom.dataset.threadId = this.threadId ?? "";
    this.dom.dataset.title = this.title;
    this.dom.dataset.instanceId = this.instanceId ?? "";
    // typeKey getter 每次访问都跑 normalizeAgentTypeKey → getAgentType.find ──
    // 本方法同一函数内访问 2 次, 缓存到局部变量避免重复计算 (在 ProseMirror node
    // update 高频路径上累计调用很多)。
    const typeKey = this.typeKey;
    // data-agent-type carries the Agent Type key; data-agent-role-* carries
    // the optional persona memo metadata.
    this.dom.dataset.agentType = typeKey;
    this.dom.dataset.agentRoleMemoId = this.agentRoleMemoId ?? "";
    this.dom.dataset.agentRoleName = this.agentRoleName ?? "";
    this.dom.dataset.collapsed = this.collapsed ? "true" : "false";
    this.dom.dataset.inputDraft = this.inputDraft;
    const type = getAgentType(typeKey);
    // type.name 已被 badge 承担, title 只显示对话标题 ── 避免与 badge 重复。
    if (!this.titleInput) {
      this.titleEl.textContent = this.title;
    }
    // 徽章内容与 typeKey 同步 ── 切换 type 或初次挂载时刷新,
    // 避免依赖外部组件级 mount 来确保 img 拿到正确 src。
    this.badgeIcon.src = type.icon;
    this.badgeIcon.alt = type.name;
    this.badgeName.textContent = type.name;
    this.syncAgentRuntimeBadge();
    if (this.externalSettingsLoadedTypeKey !== typeKey) {
      this.externalSettingsLoadedTypeKey = typeKey;
      this.loadCodexDefaultModel();
    }
    this.refreshComposerRoleIcon();
    if (
      this.composerDraft.oversizedValue !== null &&
      this.input.value === this.composerDraft.oversizedValue
    ) {
      // Oversized drafts are intentionally not persisted, but the user should
      // still be able to keep typing and send the current in-DOM value.
    }
    // 其它任何情形下, 都不在此处覆写 input.value ── 该 textarea 的内容
    // 由用户当下行为决定, 应当作 DOM 真值。 attr (inputDraft) 仅作持久化
    // 层, 由 scheduleDraftPersist / flushPendingDraft / submit 三条路径
    // 显式写出, 那三处已自行保证写 attr 那一刻 input.value 与新 attr 一致。
    //
    // 旧版此处有 `else if` 分支会在 guard 全部通过时把 input.value 复位
    // 到 inputDraft ── 在 oversized paste 后, 第一分支"恰好相等"的保护
    // 极窄, 任何微任务错位 (例如中间输入事件重设了 oversized draft guard,
    // pending snapshot 仍是 null, 且外部 updateAttrs 在 1s 窗口内到来)
    // 都会让这条分支静默吞掉用户粘贴内容。 删掉后:
    //   - 构造器已经 `this.input.value = this.inputDraft` (line 884)
    //     处理首次挂载同步;
    //   - submit / runInitialPromptIfNeeded / setComposerHistoryValue 三处
    //     显式改写 input.value 后, 都自行更新 pending draft 或 running state;
    //   - 任何 refreshAttrs 调用对 input.value 都是 no-op, 用户的 paste
    //     / typing / IME 都不会被吞。
    this.renderCollapseState();
    this.renderFullscreenState();
  }

  private syncAgentRuntimeBadge(): void {
    const type = getAgentType(this.typeKey);
    const status = useAgentRuntimeStore.getState().statusByType[type.key];
    const unavailable = status?.available === false;
    this.badgeEl.classList.toggle("agent-type-badge--unavailable", unavailable);
    this.badgeIcon.classList.toggle(
      "agent-type-badge__icon--unavailable",
      unavailable,
    );
    this.badgeEl.title = unavailable
      ? (status?.reason ?? `${type.name} is unavailable`)
      : type.desc;
  }

  // 同步折叠态: 切 .--collapsed 修饰类, 同步按钮的 aria-label。
  // 图标视觉切换交给 CSS ── 构造器一次性挂 chevron-down SVG, 折叠态
  // 由 .agent-thread-card--collapsed .agent-thread-card__chevron-icon
  // { transform: rotate(180deg) } 翻成 chevron-up, transition: 150ms
  // 给一个柔和的翻转动画。不在 TS 端 replaceChildren+append 重建节点 ──
  // 重建会导致折叠/展开瞬间 SVG 闪一下, 与 150ms transition 节奏冲突。
  private renderCollapseState(): void {
    const collapsed = this.collapsed;
    this.dom.classList.toggle("agent-thread-card--collapsed", collapsed);
    this.collapseButton.setAttribute(
      "aria-label",
      collapsed
        ? this.t("editor.threadCard.expand")
        : this.t("editor.threadCard.collapse"),
    );
  }

  // 切换折叠态: 走 updateAttrs 走 ProseMirror 事务, 状态持久化到 node.attrs,
  // 触发 update() 重渲染整个 NodeView (但本 NodeView 的 update() 只 refresh,
  // 所以这里手动 refreshAttrs + renderCollapseState)。
  private toggleCollapsed(): void {
    this.updateAttrs({ collapsed: !this.collapsed });
  }

  private toggleFullscreen(): void {
    this.setFullscreen(!this.isFullscreen);
  }

  private dispatchFullscreenChange(): void {
    window.dispatchEvent(
      new CustomEvent(AGENT_THREAD_CARD_FULLSCREEN_CHANGE_EVENT, {
        detail: {
          active: this.isFullscreen,
          element: this.dom,
          threadId: this.threadId,
        },
      }),
    );
  }

  private renderBadgeHoverCard(): void {
    if (!this.isFullscreen) {
      // 非全屏: 停掉计时器, 不渲染任何内容
      this.stopBadgeHoverCardTimer();
      this.badgeHoverCardRoot.render(null);
      return;
    }
    const sessionId = this.threadId ?? "";
    const { model, lastRunAt, totalTokens } = this.computeBadgeHoverCardData();
    this.badgeHoverCardRoot.render(
      React.createElement(BadgeHoverCard, {
        sessionId,
        model,
        lastRunAt,
        totalTokens,
      }),
    );
    this.startBadgeHoverCardTimer();
  }

  private startBadgeHoverCardTimer(): void {
    if (this.badgeHoverCardTimer !== null) return;
    // 每秒重渲染 BadgeHoverCard, 让 "上次运行" 的相对时间刷新
    this.badgeHoverCardTimer = setInterval(() => {
      if (!this.isFullscreen) return;
      const { model, lastRunAt, totalTokens } = this.computeBadgeHoverCardData();
      this.badgeHoverCardRoot.render(
        React.createElement(BadgeHoverCard, {
          sessionId: this.threadId ?? "",
          model,
          lastRunAt,
          totalTokens,
        }),
      );
    }, 1000);
  }

  private stopBadgeHoverCardTimer(): void {
    if (this.badgeHoverCardTimer === null) return;
    clearInterval(this.badgeHoverCardTimer);
    this.badgeHoverCardTimer = null;
  }

  /**
   * 收集 model / lastRunAt / totalTokens 供 BadgeHoverCard 展示。
   * 优先读实时 thread state;刷新后 thread state 会重建,再退到已持久化并
   * hydrate 回来的 conversation instance.run。
   */
  private computeBadgeHoverCardData(): {
    model: string | undefined;
    lastRunAt: number | undefined;
    totalTokens: number | undefined;
  } {
    const ts = this.currentThreadState();
    const persistedRun = this.instance?.run;
    let model: string | undefined;
    let lastRunAt: number | undefined;
    let totalTokens: number | undefined;
    // 来源 1: ts.lastRun (通用 metadata 协议快照) ── run 结束后仍可读
    const snapshot = ts?.lastRun;
    if (snapshot) {
      if (snapshot.model) model = snapshot.model;
      if (snapshot.status !== "running" && snapshot.tokenUsage) {
        totalTokens = snapshot.tokenUsage.total;
      }
      lastRunAt = snapshot.lastRunAt ?? snapshot.endedAt ?? snapshot.startedAt;
    }
    // 来源 2: 当前 active run(lastRun 尚未写入时的兜底)
    if (!snapshot && ts?.activeRunId && ts.runs[ts.activeRunId]) {
      const run = ts.runs[ts.activeRunId];
      if (run.model) model = run.model;
      if (run.status !== "running" && run.tokenUsage) {
        totalTokens = run.tokenUsage.total;
      }
      lastRunAt = run.lastRunAt ?? run.endedAt ?? run.startedAt;
    }
    // 来源 3: 最新 run(无 lastRun 也没 active run,例如 thread 迁移后)
    if (!snapshot && lastRunAt === undefined) {
      const runs = Object.values(ts?.runs ?? {});
      if (runs.length > 0) {
        const latest = runs.reduce((acc, r) =>
          r.startedAt > acc.startedAt ? r : acc,
        );
        if (latest.model) model = latest.model;
        if (latest.status !== "running" && latest.tokenUsage) {
          totalTokens = latest.tokenUsage.total;
        }
        lastRunAt = latest.lastRunAt ?? latest.endedAt ?? latest.startedAt;
      }
    }
    if (persistedRun) {
      if (!model && persistedRun.model) model = persistedRun.model;
      if (totalTokens === undefined && typeof persistedRun.totalTokens === "number") {
        totalTokens = persistedRun.totalTokens;
      }
      if (lastRunAt === undefined) {
        lastRunAt = getConversationRunLastRunAt(persistedRun);
      }
    }
    // run 没有 model 时, 退到全局 Codex 配置
    if (!model && this.typeKey === "codex") {
      const id = useChatStore.getState().agentCodexModel;
      if (id && id !== "inherit") model = id;
    }
    return { model, lastRunAt, totalTokens };
  }

  /**
   * 让 mount 覆盖 badge 区域 ── agentWrap 是 flex 容器,mount 设为
   * absolute 脱离流,然后用 inline style 把 top/left/width/height 对齐
   * badgeEl 当前位置。 全屏切换时由 setFullscreen + requestAnimationFrame
   * 触发同步, badge 位置稳定后无需持续追踪。 非全屏时 mount display: none。
   */
  private syncBadgeHoverCardPosition(): void {
    if (!this.isFullscreen) {
      this.badgeHoverCardMount.style.display = "none";
      return;
    }
    const badgeRect = this.badgeEl.getBoundingClientRect();
    const wrapRect = this.badgeEl.offsetParent?.getBoundingClientRect();
    if (!wrapRect) return;
    const top = badgeRect.top - wrapRect.top;
    const left = badgeRect.left - wrapRect.left;
    this.badgeHoverCardMount.style.position = "absolute";
    this.badgeHoverCardMount.style.top = `${top}px`;
    this.badgeHoverCardMount.style.left = `${left}px`;
    this.badgeHoverCardMount.style.width = `${badgeRect.width}px`;
    this.badgeHoverCardMount.style.height = `${badgeRect.height}px`;
    this.badgeHoverCardMount.style.display = "block";
  }

  private setFullscreen(fullscreen: boolean): void {
    if (this.isFullscreen === fullscreen) return;

    if (fullscreen) {
      this.captureFullscreenReturnAnchor();
    } else {
      this.blurFullscreenSurface();
    }

    this.isFullscreen = fullscreen;
    this.renderFullscreenState();
    this.dispatchFullscreenChange();
    this.renderBadgeHoverCard();
    // 下一帧同步 badge 位置 ── 布局(全屏 container 切换)在当帧不一定完成,
    // 立即 getBoundingClientRect 可能拿到旧值
    window.requestAnimationFrame(() => this.syncBadgeHoverCardPosition());

    if (fullscreen) {
      this.enterFullscreenMode();
      this.requestThreadMessagesIfNeeded();
      this.renderThreadState();
    } else {
      this.exitFullscreenMode();
    }
  }

  private renderFullscreenState(): void {
    this.fullscreenButton.hidden = false;
    this.actionsDivider.hidden = false;
    // 全屏模式下不展示删除按钮 ── 卡片铺满视口, 删除是破坏性操作,
    // 留出右上方空间给"退出全屏" 与"折叠" 等视图操作, 避免误删。
    this.deleteButton.hidden = this.isFullscreen;
    this.dom.classList.toggle(
      "agent-thread-card--fullscreen",
      this.isFullscreen,
    );
    if (this.isFullscreen) {
      this.dom.classList.remove("ProseMirror-selectednode");
      this.dom.setAttribute("role", "dialog");
      this.dom.setAttribute("aria-modal", "true");
    } else {
      this.dom.removeAttribute("role");
      this.dom.removeAttribute("aria-modal");
    }
    this.fullscreenButton.setAttribute(
      "aria-label",
      this.isFullscreen
        ? this.t("editor.threadCard.exitFullscreen")
        : this.t("editor.threadCard.enterFullscreen"),
    );
    this.fullscreenButton.replaceChildren(
      createFullscreenIcon(this.isFullscreen ? "exit" : "enter"),
    );
  }

  private enterFullscreenMode(): void {
    if (this.collapsed) {
      this.updateAttrs({ collapsed: false });
    }

    this.view.dom.blur();
    this.focusFullscreenSurface();
    this.fullscreenLayout.enter();
    window.addEventListener("keydown", this.boundHandleFullscreenKeydown, true);
  }

  private exitFullscreenMode(): void {
    window.removeEventListener(
      "keydown",
      this.boundHandleFullscreenKeydown,
      true,
    );
    this.fullscreenLayout.exit();
  }

  private captureScrollSnapshot(): ScrollSnapshot {
    return this.fullscreenLayout.captureScrollSnapshot();
  }

  private restoreScrollSnapshotAfterFocusChange(snapshot: ScrollSnapshot): void {
    this.fullscreenLayout.restoreScrollSnapshotAfterFocusChange(snapshot);
  }

  private ownsNode(target: globalThis.Node | null): boolean {
    return !!(
      target &&
      (this.dom.contains(target) ||
        this.accessPopoverController.popoverElement.contains(target) ||
        this.externalAgentSettings.popoverElement.contains(target) ||
        this.agentRolePicker.popoverElement.contains(target))
    );
  }

  private blurOwnedFocusForOutsidePointer(event: PointerEvent): void {
    if (this.isDestroyed || this.isFullscreen) return;
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement) || !this.ownsNode(activeElement))
      return;
    const target = event.target as globalThis.Node | null;
    if (this.ownsNode(target)) return;

    const snapshot = this.captureScrollSnapshot();
    activeElement.blur();
    this.restoreScrollSnapshotAfterFocusChange(snapshot);
  }

  private captureFullscreenReturnAnchor(): void {
    this.fullscreenLayout.captureReturnAnchor();
  }

  private focusFullscreenSurface(): void {
    window.requestAnimationFrame(() => {
      if (!this.isFullscreen || this.isDestroyed) return;
      this.input.focus({ preventScroll: true });
    });
  }

  private blurFullscreenSurface(): void {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      this.dom.contains(activeElement)
    ) {
      activeElement.blur();
    }
  }

  private currentThreadState(): ThreadState | undefined {
    const threadId = this.renderThreadId;
    return threadId
      ? useChatStore.getState().threadStates[threadId]
      : undefined;
  }

  private currentConversationMessageState() {
    const threadId = this.renderThreadId;
    return threadId
      ? useAgentConversationStore.getState().getMessageState(threadId)
      : null;
  }

  private currentMessages(): ThreadState["messages"] {
    return selectRenderableThreadMessages({
      typeKey: this.typeKey,
      threadId: this.renderThreadId,
    });
  }

  private getBodyBottomDistance(): number {
    return Math.max(
      0,
      this.body.scrollHeight - this.body.clientHeight - this.body.scrollTop,
    );
  }

  private isBodyNearBottom(): boolean {
    return this.getBodyBottomDistance() <= BOTTOM_FOLLOW_THRESHOLD_PX;
  }

  private requestMoreHistoryIfNeeded(): void {
    if (this.collapsed && !this.isFullscreen) return;
    if (this.body.scrollTop > TOP_HISTORY_LOAD_THRESHOLD_PX) return;

    const threadId = this.runtimeThreadId;
    if (!threadId) return;

    const state = this.currentConversationMessageState();
    if (
      !state ||
      state.loadingMore ||
      !state.hasMoreHistory ||
      state.oldestSequence === null
    ) {
      return;
    }

    this.pendingHistoryScrollRestore = {
      threadId,
      scrollHeight: this.body.scrollHeight,
      scrollTop: this.body.scrollTop,
    };
    void useAgentConversationStore
      .getState()
      .loadMoreMessages(this.typeKey, threadId);
  }

  private isThreadCachePresentationHidden(): boolean {
    const messages = this.currentMessages();
    return (
      !!this.threadId &&
      messages.length === 0 &&
      (this.isLoadingThreadCache || this.isThreadCacheSettling)
    );
  }

  private pruneReasoningCollapsedOverrides(
    messages: ThreadState["messages"],
  ): void {
    if (this.reasoningCollapsedOverrides.size === 0) return;

    const visibleReasoningIds = new Set(
      messages
        .filter((message) => message.role === "reasoning")
        .map((message) => message.id),
    );

    for (const id of this.reasoningCollapsedOverrides.keys()) {
      if (!visibleReasoningIds.has(id)) {
        this.reasoningCollapsedOverrides.delete(id);
      }
    }
  }

  private getReasoningCollapsed(
    message: ThreadState["messages"][number],
  ): boolean {
    return (
      this.reasoningCollapsedOverrides.get(message.id) ?? !!message.isCompleted
    );
  }

  private cancelThreadCacheRevealFrame(): void {
    if (this.threadCacheRevealFrame === null) return;
    window.cancelAnimationFrame(this.threadCacheRevealFrame);
    this.threadCacheRevealFrame = null;
  }

  private scrollBodyToBottom(): void {
    this.body.scrollTop = this.body.scrollHeight;
    this.shouldFollowBottom = true;
  }

  private preserveBodyScrollTop(scrollTop: number): void {
    this.body.scrollTop = scrollTop;
    this.shouldFollowBottom = this.isBodyNearBottom();
  }

  private applyBodyScrollAfterRender(options: {
    isLoading: boolean;
    previousScrollTop: number;
    shouldFollowStreaming: boolean;
  }): void {
    if (this.restoreBodyScrollAfterHistoryPrepend()) {
      return;
    }

    if (this.collapsed) {
      this.prevCollapsed = this.collapsed;
      return;
    }

    if (options.isLoading) {
      if (options.shouldFollowStreaming) {
        this.scrollBodyToBottom();
      } else {
        this.preserveBodyScrollTop(options.previousScrollTop);
      }
    } else if (this.prevCollapsed) {
      this.body.scrollTop = 0;
      this.shouldFollowBottom = this.isBodyNearBottom();
    } else {
      this.scrollBodyToBottom();
    }

    this.prevCollapsed = this.collapsed;
  }

  private restoreBodyScrollAfterHistoryPrepend(): boolean {
    const snapshot = this.pendingHistoryScrollRestore;
    if (!snapshot || snapshot.threadId !== this.runtimeThreadId) return false;

    const nextScrollHeight = this.body.scrollHeight;
    const delta = nextScrollHeight - snapshot.scrollHeight;
    if (delta > SCROLL_DELTA_EPSILON_PX) {
      this.body.scrollTop = snapshot.scrollTop + delta;
      this.shouldFollowBottom = false;
      this.pendingHistoryScrollRestore = null;
      return true;
    }

    this.body.scrollTop = snapshot.scrollTop;
    this.shouldFollowBottom = false;
    if (!this.currentConversationMessageState()?.loadingMore) {
      this.pendingHistoryScrollRestore = null;
    }
    return true;
  }

  private createThreadCacheSkeleton(): HTMLDivElement {
    return createThreadCacheSkeleton(
      this.t("editor.threadCard.loadingThreadCache"),
    );
  }

  private resetRenderedMessageCache(): void {
    this.renderedMessagesList = null;
    this.renderedMessageRefs = [];
  }

  private rememberRenderedMessages(
    list: HTMLDivElement,
    messages: ThreadState["messages"],
  ): void {
    this.renderedMessagesList = list;
    this.renderedMessageRefs = messages;
  }

  private createMessageRenderContext(): AgentThreadCardMessageRenderContext {
    return {
      language: this.language,
      getReasoningCollapsed: (message) => this.getReasoningCollapsed(message),
      setReasoningCollapsed: (messageId, collapsed) => {
        this.reasoningCollapsedOverrides.set(messageId, collapsed);
      },
    };
  }

  private canReuseRenderedMessages(messages: ThreadState["messages"]): boolean {
    const list = this.renderedMessagesList;
    if (!list || !this.body.contains(list)) return false;
    const renderedMessages = getRenderedAgentMessages(messages);
    if (
      renderedMessages.length !== this.renderedMessageRefs.length ||
      list.children.length !== renderedMessages.length
    ) {
      return false;
    }
    for (let i = 0; i < renderedMessages.length; i += 1) {
      if (renderedMessages[i] !== this.renderedMessageRefs[i]) return false;
    }
    return true;
  }

  private tryPatchLastRenderedMessage(
    messages: ThreadState["messages"],
    options: {
      isLoading: boolean;
      previousScrollTop: number;
      shouldFollowStreaming: boolean;
    },
  ): boolean {
    const nextRefs = patchLastRenderedAgentMessage(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  /**
   * "只在尾巴追加" lite 路径 ── 用户提交消息 / stream 推进到 tool_call /
   * tool_result / error 等"消息数组长度变长、且新条目都在尾部"的事件。
   *
   * 之所以需要它, 是因为 `tryPatchLastRenderedMessage` 要求 `length` 不变
   * 且只能原地修改最后一条 ── 一旦 append 新消息就会落到
   * `body.replaceChildren()` 全量重建。 user 消息 (optimistic set 后
   * `messages.length + 1`) 是这一类的高频来源, 全量重建 50 条对话的
   * DOM + 重跑 markdown 管线, 肉眼可见。
   *
   * 判据:
   *   1. 当前已渲染列表非空 (第一条消息无法 append; 让全量路径处理空 → 非空)
   *   2. 新 rendered 长度严格大于旧 (必须有可追加内容)
   *   3. list.children 长度与旧 refs 一致 (DOM 不变量, 失败就回退全量)
   *   4. 旧 refs 与 newRendered 的前缀逐项 `===` (中间 / 头部变化回退全量)
   *
   * 满足上述全部条件, 对 `newRendered` 的尾部子集逐一走
   * `createAgentThreadCardMessageElement`, append DOM, 用 `newRendered`
   * 整体替换 `renderedMessageRefs`。 任一环节抛错 / 工厂返 null → 返回
   * false, 不动 refs, 让 fallback 全量重建兜底 ── 失败语义与现有
   * lite-patch 完全一致, 不引入新的"看起来更新但其实不是"的状态。
   */
  private tryAppendMessagesToTail(
    messages: ThreadState["messages"],
    options: {
      isLoading: boolean;
      previousScrollTop: number;
      shouldFollowStreaming: boolean;
    },
  ): boolean {
    const nextRefs = appendRenderedAgentMessagesToTail(messages, {
      body: this.body,
      cache: {
        list: this.renderedMessagesList,
        refs: this.renderedMessageRefs,
      },
      context: this.createMessageRenderContext(),
      afterRender: () => this.applyBodyScrollAfterRender(options),
    });
    if (!nextRefs) return false;
    this.renderedMessageRefs = nextRefs;
    return true;
  }

  // 消息链接点击委托 ── AgentThreadCard 是只读 NodeView, 不使用编辑器正文的
  // link hover tooltip。这里本地接管点击, 保留 flowix:// 深链和普通外链打开能力。
  private handleBodyClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const a = target.closest<HTMLAnchorElement>("a[href]");
    if (!a) return;
    event.preventDefault();
    // 阻止冒泡到外层可能存在的 React handler (例如把 click 解读为'打开卡片')
    event.stopPropagation();
    const href = normalizePlainLinkHref(a.getAttribute("href"));
    if (!href) return;
    if (href.startsWith("flowix://")) {
      void openNoteByDeepLink(href);
      return;
    }
    void openUrl(href).catch((error) => {
      console.error("Failed to open agent thread card link:", error);
    });
  }

  private renderMetaState(
    state: ThreadState | undefined,
    isLoading: boolean,
  ): void {
    const statusView = selectAgentThreadCardRunStatus({
      state,
      isCreating: this.isCreating,
      isLoading,
      typeKey: this.typeKey,
    });
    const label = statusView.shouldShowStatus
      ? statusView.status === "running"
        ? statusView.supportsStreaming
          ? this.t("editor.threadCard.running")
          : this.t("editor.threadCard.running")
        : statusView.status === "failed"
          ? "失败"
          : statusView.status === "cancelled"
            ? "已取消"
            : ""
      : "";

    this.dom.classList.toggle(
      "agent-thread-card--running",
      statusView.status === "running",
    );
    this.runStatusEl.textContent = label;
    this.runStatusEl.hidden = !statusView.shouldShowStatus;
    this.runStatusEl.className = `agent-thread-card__run-status agent-thread-card__run-status--${statusView.statusClass}`;
    if (statusView.latestRun?.runId) {
      this.runStatusEl.title = `Run: ${statusView.latestRun.runId}`;
    } else {
      this.runStatusEl.removeAttribute("title");
    }

    this.metaEl.replaceChildren(this.runStatusEl);
  }

  private renderThreadState(): void {
    const state = this.currentThreadState();
    const shouldRenderMessages = !this.collapsed || this.isFullscreen;
    const messages = shouldRenderMessages ? this.currentMessages() : [];
    const isLoading = !!state?.isLoading || this.isCreating;
    const previousScrollTop = this.body.scrollTop;
    const wasNearBottom = this.isBodyNearBottom();
    const shouldFollowStreaming = this.shouldFollowBottom || wasNearBottom;
    this.dom.classList.toggle(
      "agent-thread-card--thread-cache-loading",
      this.isThreadCachePresentationHidden(),
    );
    this.dom.classList.toggle(
      "agent-thread-card--has-threadid",
      !!this.threadId,
    );

    // 输入框运行期不再 disabled ── 允许用户继续输入 / 改稿, 草稿保留
    // 在 this.input.value, 等运行结束后再次按 Enter 即可投递。 真正的
    // 拦截在 submit() 里: isBusy 时早返, 不清空 input.value, 也不触发
    // ensureAgentThreadCardThread / sendMessageToThread。
    //
    // send 按钮仍交给 setSendButtonState 处理 ── isLoading 时 wantStop=true,
    // 渲染 stop 图标 + 走 stopExternalAgentThreadCardRun, 不投递新消息。
    this.setSendButtonState(isLoading, this.input.value.trim());
    this.renderMetaState(state, isLoading);

    // 同步 loading 指示器 ── 容器始终挂 body 末尾 (24px 固定),
    // 仅切换文字 "思考中" 的 hidden。dot 与文字同步: 不显示文字时
    // dot 一起 hidden ── 否则空 24px 区域里"独自跳动的圆点"会
    // 看起来像装饰 bug, 而不是 loading 反馈。
    const loadingText = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-text",
    );
    const loadingDot = this.loadingIndicator.querySelector<HTMLSpanElement>(
      ".agent-thread-card__loading-dot",
    );
    if (loadingText) {
      loadingText.textContent = getAgentType(this.typeKey).capabilities
        .supportsTextStreaming
        ? this.t("editor.threadCard.thinking")
        : this.t("editor.threadCard.running");
      loadingText.hidden = !isLoading;
    }
    if (loadingDot) loadingDot.hidden = !isLoading;

    if (!shouldRenderMessages) {
      this.body.replaceChildren();
      this.resetRenderedMessageCache();
      this.shouldFollowBottom = true;
      return;
    }
    // 全量回放 ── 卡片有 max-height + body 内部滚动, 不再 slice 截断。
    // 用户要看到完整历史 (而非 4 条快照), 由 CSS max-height 限制卡片总高。
    const visibleMessages = messages;
    this.pruneReasoningCollapsedOverrides(visibleMessages);

    if (this.canReuseRenderedMessages(visibleMessages)) {
      return;
    }

    if (
      this.tryPatchLastRenderedMessage(visibleMessages, {
        isLoading,
        previousScrollTop,
        shouldFollowStreaming,
      })
    ) {
      return;
    }

    // "只在尾巴追加" lite 路径 ── 用户提交消息、tool_call、tool_result、
    // error 等"messages 数组尾部新增"的场景。 失败回退到下面的全量重建。
    //
    // 顺序: 必须放在 tryPatchLastRenderedMessage 之后, 因为后者处理
    // 流式 text_delta (长度不变)。 两者互斥, 谁先返回就由谁负责。
    if (
      this.tryAppendMessagesToTail(visibleMessages, {
        isLoading,
        previousScrollTop,
        shouldFollowStreaming,
      })
    ) {
      return;
    }

    // eslint-disable-next-line no-console
    this.body.replaceChildren();

    if (visibleMessages.length === 0) {
      this.resetRenderedMessageCache();
      if (this.isThreadCachePresentationHidden()) {
        this.body.append(this.createThreadCacheSkeleton(), this.loadingIndicator);
        this.shouldFollowBottom = true;
        return;
      }

      const empty =
        (this.typeKey === "codex" ||
          this.typeKey === "claude" ||
          this.typeKey === "hermes") &&
        !this.isLoadingThreadCache
          ? this.createExternalAgentEmptySettings()
          : document.createElement("div");
      if (!empty.classList.contains("agent-thread-card__empty")) {
        empty.className = "agent-thread-card__empty";
        empty.textContent = this.isLoadingThreadCache
          ? this.t("editor.threadCard.loadingThreadCache")
          : this.t("editor.threadCard.empty");
      }
      this.body.append(empty, this.loadingIndicator);
      this.shouldFollowBottom = true;
      return;
    }

    const { list, rememberedMessages } = createRenderedAgentMessageList(
      visibleMessages,
      this.createMessageRenderContext(),
    );

    this.body.append(list, this.loadingIndicator);
    this.rememberRenderedMessages(list, rememberedMessages);
    this.applyBodyScrollAfterRender({
      isLoading,
      previousScrollTop,
      shouldFollowStreaming,
    });
  }

  private setError(message: string | null): void {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? "";
  }

  private renderSendButton(wantStop: boolean, disabled: boolean): void {
    const label = wantStop
      ? this.t("editor.threadCard.stop")
      : this.t("editor.threadCard.send");
    const className = wantStop
      ? "agent-thread-card__send agent-thread-card__send--stop"
      : "agent-thread-card__send";

    flushSync(() => {
      this.sendButtonRoot.render(
        <Tooltip content={label}>
          <button
            type="button"
            className={className}
            disabled={disabled}
            aria-label={label}
            onClick={() => {
              if (wantStop) {
                void stopExternalAgentThreadCardRun(
                  this.runtimeHandleId,
                  this.threadId,
                );
                return;
              }
              void this.submit();
            }}
          >
            {wantStop ? (
              <svg
                aria-hidden="true"
                focusable="false"
                className="agent-thread-card__send-icon"
                viewBox="0 0 256 256"
              >
                <path d={ICON_STOP_PATH} fill="currentColor" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                focusable="false"
                className="agent-thread-card__send-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
            )}
          </button>
        </Tooltip>,
      );
    });
  }

  private setSendButtonState(isLoading: boolean, hasInput: string): void {
    const { wantStop, disabled } = selectAgentThreadCardSendButtonState({
      isLoading,
      inputValue: hasInput,
    });
    this.renderSendButton(wantStop, disabled);
  }

  // 切换 composer 的多行状态 ── 给容器加 .--multi-line 时, CSS 把
  // align-items 从 center 切到 flex-end, 按钮从居中变贴底。
  // 阈值与 textarea min-height (1.8rem ≈ 28.8px) 对齐: 内容未撑出 min-height
  // 视为单行 (按钮居中), 撑出后视为多行 (按钮贴底, 内容走 overflow-y 滚动)。
  // 空值短路: input 清空后 scrollHeight 还未 reflow, 直接 remove 类更稳。
  //
  // 同步刷新 send 按钮的 disabled ── 此前只在 renderThreadState 里调过
  // setSendButtonState, input 事件不会触发, 用户打字时按钮的 disabled
  // 卡在构造时的 true (input.value='') 上, 视觉永远走 muted 暗态, 即使
  // 已经输了内容也不会切到 primary 亮态。input 事件驱动'有内容 / 无内容'
  // 的 dim↔lit 切换, 与多行判定走同一时机, 一并刷新。
  private updateMultiLineState(): void {
    const isLoading = !!this.currentThreadState()?.isLoading || this.isCreating;
    if (this.input.value === "") {
      this.composer.classList.remove("agent-thread-card__composer--multi-line");
      this.setSendButtonState(isLoading, "");
      return;
    }
    const isMulti = this.input.scrollHeight > 30;
    this.composer.classList.toggle(
      "agent-thread-card__composer--multi-line",
      isMulti,
    );
    this.setSendButtonState(isLoading, this.input.value.trim());
  }

  // 提取当前 thread 的 user 消息列表 (按时间顺序, 旧 → 新) ──
  // 仅做"前端有"的范围, 不主动去后台拉历史 (hasMoreHistory / loadMoreHistory),
  // 也不读 agent role memo ── 用户的措辞是"次级需求", 用前端可见数据
  // 就够了, 拉历史会拖慢键盘响应。 跳过空 content 防止 typing 期
  // 的占位 user 消息污染历史。
  private getUserHistoryMessages(): string[] {
    return getAgentThreadCardUserHistoryMessagesFromMessages(
      this.currentMessages(),
    );
  }

  private shouldHandleHistoryKey(key: string): boolean {
    const direction = key === "ArrowUp" ? "up" : "down";
    if (this.getUserHistoryMessages().length === 0) return false;
    if (!this.isCaretCollapsed()) return false;

    if (direction === "up") {
      return this.isCaretOnFirstLine();
    }

    if (this.historyCursor === null) return false;
    return this.isCaretOnLastLine();
  }

  private isCaretCollapsed(): boolean {
    return this.input.selectionStart === this.input.selectionEnd;
  }

  private isCaretOnFirstLine(): boolean {
    const cursor = this.input.selectionStart ?? 0;
    return this.input.value.lastIndexOf("\n", Math.max(0, cursor - 1)) === -1;
  }

  private isCaretOnLastLine(): boolean {
    const cursor = this.input.selectionEnd ?? 0;
    return this.input.value.indexOf("\n", cursor) === -1;
  }

  private isCurrentHistoryEntryUnmodified(): boolean {
    if (this.historyCursor === null) return false;
    const messages = this.getUserHistoryMessages();
    return messages[this.historyCursor] === this.input.value;
  }

  private resetHistoryNavigation(): void {
    this.historyCursor = null;
    this.preNavDraft = null;
  }

  // Composer history navigation treats the current draft as a virtual entry
  // after the newest user message. History previews must not be persisted as
  // inputDraft; only the user's real draft is allowed to update node attrs.
  private navigateHistory(direction: "up" | "down"): void {
    const messages = this.getUserHistoryMessages();
    if (messages.length === 0) return;

    if (direction === "up") {
      if (this.historyCursor === null) {
        if (this.preNavDraft === null) {
          this.preNavDraft = this.input.value;
        }
      }
      const next =
        this.historyCursor === null
          ? messages.length - 1
          : Math.max(0, this.historyCursor - 1);
      this.historyCursor = next;
      this.setComposerHistoryValue(messages[next]);
      return;
    }

    if (this.historyCursor === null) return;
    const next = this.historyCursor + 1;
    if (next >= messages.length) {
      this.historyCursor = null;
      const draft = this.preNavDraft ?? "";
      this.setComposerHistoryValue(draft, { persistDraft: true });
      return;
    }
    this.historyCursor = next;
    this.setComposerHistoryValue(messages[next]);
  }

  private setComposerHistoryValue(
    content: string,
    options: { persistDraft?: boolean } = {},
  ): void {
    this.input.value = content;
    this.input.setSelectionRange(content.length, content.length);
    if (options.persistDraft) {
      this.persistInputDraft(content);
    }
    this.updateMultiLineState();
  }

  private async submit(): Promise<void> {
    // 落盘待写草稿 ── 提交时 input 即将被清空, 之前的 debounce 必须
    // 立刻写入 ProseMirror attr, 否则卡片重新挂载会丢稿。
    this.flushPendingDraft();
    const rawPrompt = this.input.value.trim();
    if (!rawPrompt) return;

    // 运行期 (thread state isLoading / 正在创建 thread) 阻止发送 ──
    // 输入框保持可用 (允许用户继续输入 / 改稿), 但 Enter 与 send 按钮
    // (按钮在 isLoading 时是 stop 图标) 都无法真正投递消息。 当前草稿
    // 保留在 this.input.value, 不调 persistInputDraft("") / input.value=""
    // 清空; 用户可在运行结束后再次按 Enter 投递同一段草稿。
    //
    // 注: 输入框不再设 disabled ── 见 renderThreadState 注释。
    const isBusy =
      !!this.currentThreadState()?.isLoading || this.isCreating;
    if (isBusy) return;

    // 提取全文档作为隐藏 LLM 上下文 ── 跳过本卡 (agentThreadCard), 避免把
    // LLM 自己之前的回答 / 工具结果当成'笔记内容'再喂回去造成循环。
    // 空文档 / 全部是 card 的笔记会得到空上下文。
    const documentContext = extractDocumentContext(this.view);

    this.input.value = "";
    this.resetHistoryNavigation();
    // 清空草稿是"已知终态", 不必走 1s debounce ── 直接 updateAttrs 同步
    // 落 ProseMirror attr, 避免后续 reload / 跨卡片挂载时拿到旧 draft。
    // 同时把 pending draft 清掉 (若之前有未触发的 debounce), 防止空 input
    // 被旧 snapshot 误保护。
    this.composerDraft.clear();
    this.updateAttrs({ inputDraft: null });
    this.updateMultiLineState();
    this.setError(null);
    this.renderThreadState();

    const source = getCurrentThreadCardSource();
    try {
      if (!this.threadId) {
        this.isCreating = true;
        this.renderThreadState();
      }
      await submitAgentThreadCardConversation({
        prompt: rawPrompt,
        fallbackTitle: this.t("editor.threadCard.title"),
        typeKey: this.typeKey,
        currentThreadId: this.threadId,
        currentInstanceId: this.instanceId,
        currentTitle: this.title,
        runtimeHandleId: this.runtimeHandleId,
        source,
        role: {
          memoId: this.agentRoleMemoId,
          name: this.agentRoleName,
        },
        isFirstMessage: this.currentMessages().length === 0,
        documentContext,
        buildTitle,
        loadAgentRoleBody: (memoId) => this.loadAgentRoleBody(memoId),
        onThreadBound: (binding) => {
          // Persist the card binding only after the optimistic user message has
          // entered the store. Otherwise the node attr update schedules history
          // cache loading while the message list is still empty, producing a
          // visible delay before the just-sent message appears.
          this.updateAttrs({
            instanceId: binding.instanceId,
            threadId: binding.threadId,
            typeKey: binding.typeKey,
          });
        },
      });
    } catch (err) {
      this.setError(
        typeof err === "string" ? err : this.t("editor.threadCard.sendFailed"),
      );
    } finally {
      this.isCreating = false;
      this.renderThreadState();
      focusWithoutScroll(this.input);
    }
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    const oldAttrs = this.node.attrs;
    const wasCollapsed = !!oldAttrs.collapsed;
    this.node = node;
    const isCollapsed = this.collapsed;
    this.refreshAttrs();
    // requestThreadMessagesIfNeeded 始终调用 ── shouldLoadThreadMessages
    // 自己会短路 (折叠态不加载, 已加载过不重复), 但"折叠→展开"这种
    // lite 路径下不能漏, 否则消息永远不被加载。
    this.requestThreadMessagesIfNeeded();
    if (wasCollapsed !== isCollapsed) {
      this.renderThreadState();
      return true;
    }
    // 仅"消息影响类" attrs 变化时才需要重建 body ── inputDraft /
    // title / collapsed / initialPrompt 等都不影响消息列表。 直接走
    // 轻量路径:
    //   - chrome (classes / send 按钮 / run status / loading 指示器) 由
    //     chat store subscription 驱动, 不依赖本次 update
    //   - body DOM 完全跳过, 长对话 (50+ 条) 下省掉 N 个消息节点重建
    //
    // 列表之外的 attrs 也覆盖到 ── 任何新加的"UI-only" attr 自动走 lite
    // 路径, 不会触发全量重建。
    if (canSkipMessageRebuild(oldAttrs, this.node.attrs)) {
      return true;
    }
    this.renderThreadState();
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = getEventElement(event);
    if (!target || !this.dom.contains(target)) return false;
    if (this.isFullscreen) return true;
    if (event.type.startsWith("composition")) return false;
    return isAgentThreadCardInteractiveTarget(target);
  }

  selectNode(): void {
    if (this.isFullscreen) return;
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    // 落盘待写草稿 ── 卡片销毁时 (例如删整张卡 / 切文档) 必须把 inputDraft
    // 写进 ProseMirror attrs, 否则下一个 mount 会用旧值回填, 看起来
    // "刚打的字凭空消失"。
    this.flushPendingDraft();
    this.setFullscreen(false);
    window.removeEventListener(
      AGENT_THREAD_CARD_REQUEST_FULLSCREEN_EVENT,
      this.boundHandleRequestFullscreen,
    );
    this.setAccessPopoverOpen(false);
    this.setCodexSettingsPopoverOpen(false);
    this.dom.removeEventListener("mousedown", this.boundHandleCardMouseDown);
    this.header.removeEventListener(
      "pointerdown",
      this.boundHandleHeaderPointerDown,
    );
    this.header.removeEventListener(
      "pointermove",
      this.boundHandleHeaderPointerMove,
    );
    this.header.removeEventListener("pointerup", this.boundHandleHeaderPointerUp);
    this.header.removeEventListener(
      "pointercancel",
      this.boundHandleHeaderPointerCancel,
    );
    this.header.removeEventListener("click", this.boundHandleHeaderClick, true);
    if (this.headerDragState) {
      cancelBlockDragForView(this.view);
      this.headerDragState = null;
      this.dom.classList.remove("agent-thread-card--dragging");
    }
    document.removeEventListener(
      "pointerdown",
      this.boundHandleOutsidePointerDown,
      true,
    );
    this.setComposerRolePopoverOpen(false);
    this.isDestroyed = true;
    if (this.loadThreadCacheTimeout !== null) {
      globalThis.clearTimeout(this.loadThreadCacheTimeout);
      this.loadThreadCacheTimeout = null;
    }
    if (this.loadThreadCacheIdleId !== null && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(this.loadThreadCacheIdleId);
      this.loadThreadCacheIdleId = null;
    }
    this.threadCacheVisibilityObserver?.disconnect();
    this.threadCacheVisibilityObserver = null;
    this.cancelThreadCacheRevealFrame();
    this.body.removeEventListener("scroll", this.boundHandleBodyScroll);
    this.unsubscribe?.();
    this.unsubscribeConversation?.();
    this.unsubscribeAccess?.();
    this.unsubscribeRuntime?.();
    this.unsubscribeNotebooks?.();
    this.sendButtonRoot.unmount();
    this.stopBadgeHoverCardTimer();
    this.badgeHoverCardRoot.unmount();
    this.accessPopoverController.dispose();
    this.externalAgentSettings.dispose();
    this.agentRolePicker.dispose();
    this.fullscreenLayout.dispose();
  }
}
