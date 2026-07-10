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
import { agent } from "@platform/tauri/client";
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
import {
  getNotebookIconLetter,
  getNotebookIconMarkup,
} from "@features/memo/components/notebook-icon";
import {
  getPropertyIconOption,
} from "@features/document/properties/property-icons";
import { Tooltip } from "@shared/ui/tooltip";
import { translate, type AppLanguage, type I18nKey } from "@features/i18n";
import type {
  AgentCodexModel,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import { createAgentMessageViewModel, stripSystemBlock } from "@features/agent/message";
import { openNoteByDeepLink } from "@platform/open-target";
import { isWindowsPlatform } from "@features/shortcuts";
import { normalizePlainLinkHref } from "@features/editor/extensions/markdown-link";
import {
  getAgentType,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { useUserSettingsStore } from "@features/preferences/store/user-settings-store";
import { displayTitleFromFilename } from "@/lib/utils";
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
} from "@features/agent/config/codex-options";
import {
  getAgentAccessOptions,
  supportsAgentRuntimeSetting,
  type AgentRuntimeSettingKind,
} from "@features/agent/runtime/agent-runtime-spec";
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
import { ensureAgentThreadCardThread } from "@features/editor/extensions/agent-thread-card/agent-thread-card-submit";
import {
  createAnchoredPopoverController,
  type AnchoredPopoverController,
} from "@features/editor/extensions/agent-thread-card/anchored-popover-controller";
import {
  fillWithAgentThreadCardMarkdownHtml as fillWithMarkdownHtml,
  renderAgentThreadCardMarkdownToHtml as renderMarkdownToHtml,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-markdown";
import {
  ICON_STOP_PATH,
  createChevronIcon,
  createComposerRoleEmptyIcon,
  createFullscreenIcon,
  createPlusIcon,
  createRoleOptionsLoadingIcon,
  createTrashIcon,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-icons";
import {
  createAccessDivider,
  createAccessEntryRow,
  createAccessSectionLabel,
} from "@features/editor/extensions/agent-thread-card/access/access-entries";
import { attachAccessPopoverScrollbar } from "@features/editor/extensions/agent-thread-card/access/access-popover-scrollbar";
import {
  createCodexSettingsItem,
  createExternalAgentEmptyControl,
  updateExternalAgentEmptyControl,
  type ExternalAgentEmptyControlKind,
} from "@features/editor/extensions/agent-thread-card/settings/external-agent-settings";
import {
  appendRoleIconContent,
  type AgentRoleOption,
} from "@features/editor/extensions/agent-thread-card/agent-thread-card-role";
import {
  fallbackAgentRoleOptionsFromStore,
  listAgentRoleMemosWithTimeout,
  loadAgentRoleBodyFromMemo,
} from "@features/editor/extensions/agent-thread-card/role/role-options-loader";
import {
  adjustEditorScrollToCardTop as adjustEditorScrollToCardTopByDelta,
  captureAgentThreadCardScrollSnapshot,
  clearAgentThreadCardFullscreenBounds,
  getAgentThreadCardEditorScrollContainer,
  getAgentThreadCardFullscreenContainer,
  getFullscreenExitFallbackTop,
  restoreAgentThreadCardScrollSnapshotAfterFocusChange,
  syncAgentThreadCardFullscreenBounds,
} from "@features/editor/extensions/agent-thread-card/fullscreen/fullscreen-scroll";
import { getPersistableInputDraft } from "@features/editor/extensions/agent-thread-card/composer/composer-draft";
import { getAgentThreadCardUserHistoryMessagesFromMessages } from "@features/editor/extensions/agent-thread-card/composer/composer-history";
import { createThreadCacheSkeleton } from "@features/editor/extensions/agent-thread-card/messages/thread-cache-skeleton";
import { getRenderedAgentMessages as selectRenderedAgentMessages } from "@features/editor/extensions/agent-thread-card/messages/message-list-renderer";
import { createAgentThreadCardMessageElement } from "@features/editor/extensions/agent-thread-card/messages/message-item-renderer";
import {
  applyPopoverPosition,
  calculateAnchoredPopoverPosition,
} from "@features/editor/extensions/agent-thread-card/popover/popover-position";
import { getCurrentThreadCardSource } from "@features/editor/extensions/agent-thread-card/runtime/thread-card-source";
import { upsertAgentThreadCardConversationInstance } from "@features/editor/extensions/agent-thread-card/runtime/thread-card-conversation";
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
const ACCESS_POPOVER_OFFSET_ABOVE_PX = 15;
const ACCESS_POPOVER_OFFSET_BELOW_PX = 2;
const ACCESS_POPOVER_VIEWPORT_PADDING_PX = 8;
const ACCESS_POPOVER_WIDTH_PX = 208;
const ACCESS_POPOVER_MAX_HEIGHT_PX = 320;
const ACCESS_POPOVER_MIN_HEIGHT_PX = 96;
const CODEX_SETTINGS_POPOVER_WIDTH_PX = 220;
const CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX = 280;
const CODEX_SETTINGS_POPOVER_OFFSET_PX = 6;
const CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX = 8;
const AGENT_THREAD_CARD_INPUT_DRAFT_MAX_CHARS = 500;
// inputDraft 落盘 debounce ── 1s 静默期后把本地草稿写入 ProseMirror attrs。
// 见 AgentThreadCardView.scheduleDraftPersist 注释。 必须 flush 的时机:
// submit / destroy / input blur / 窗口 hidden ── 否则会丢稿 (ProseMirror
// attr 是 input 重新挂载时回填 input.value 的唯一来源)。
const AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS = 1000;

type AgentModelOption = {
  id: AgentCodexModel;
  label: string;
};

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
  // 全屏 / 删除按钮之间的竖向分割线 ── 非交互元素, aria-hidden 让屏幕
  // 阅读器跳过; 视觉与按钮同高 (28px), 1px var(--border) 着色。
  // 可见性与 fullscreenButton 同步 (renderFullscreenState 一起切 hidden)。
  private actionsDivider: HTMLSpanElement;
  private accessButton: HTMLButtonElement;
  private accessPopover: HTMLDivElement;
  private accessPopoverAnchor: HTMLElement | null = null;
  private accessPopoverPreferBelow = false;
  private externalEmptyModelButton: HTMLButtonElement | null = null;
  private externalEmptyReasoningButton: HTMLButtonElement | null = null;
  private externalEmptyPermissionButton: HTMLButtonElement | null = null;
  private externalEmptyFilesButton: HTMLButtonElement | null = null;
  private codexSettingsPopover: HTMLDivElement;
  private codexSettingsPopoverAnchor: HTMLButtonElement | null = null;
  private codexSettingsPopoverKind: AgentRuntimeSettingKind | null = null;
  private isCodexSettingsPopoverOpen = false;
  private codexSettingsPopoverResizeObserver: ResizeObserver | null = null;
  private codexSettingsPopoverPositionFrame: number | null = null;
  private codexDefaultModel = "";
  private localSupportedModelsTypeKey: AgentTypeKey | null = null;
  private localSupportedModels: AgentModelOption[] = [];
  // 角色选择下拉弹窗 ── 直接挂在 composerRoleIcon button 下方/上方, 取代
  // 之前 accessPopover → 「角色」按钮 → typeSettingsPopover 的两级展开。
  // 一次性创建, 构造器挂到 document.body, 后续 renderRoleOptionsList
  // 复用, 不再频繁重建节点。 与 accessPopover 同一套 fixed 定位范式 ──
  // 详见 CSS .agent-thread-card__composer-role-popover 块。
  private composerRolePopover: HTMLDivElement;
  private isComposerRolePopoverOpen = false;
  private composerRolePopoverController: AnchoredPopoverController | null =
    null;
  private agentRoleOptions: AgentRoleOption[] | null = null;
  private isLoadingAgentRoleOptions = false;
  private agentRoleOptionsRequestSeq = 0;
  // Agent Role memo body 缓存 ── 提交首条消息时把 role 文档拼到 user
  // 消息末尾, body 需走 IPC 拉。 同一 memoId 后续提交直接复用, 避免
  // 每次发消息都触发 read_document 往返。 null = 拉过但失败 / 文档
  // 已被删, 与"未拉过"(key 缺失)区分, 失败不重试 (角色文档被删是
  // 显式操作, 让用户重选 role 才是正确恢复路径)。
  private cachedAgentRoleBodies: Map<string, string | null> = new Map();
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
  private isAccessPopoverOpen = false;
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
  // 草稿落盘 debounce 状态 ── 详见 scheduleDraftPersist / flushPendingDraft。
  // draftSnapshot 是"待落盘"的值, 在 debounce 期间充当本地真值, 阻止
  // refreshAttrs 把 input.value 错误地覆写回 ProseMirror attr 旧值。
  private draftPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private draftSnapshot: string | null = null;
  private oversizedInputDraftDomValue: string | null = null;
  private isFullscreen = false;
  private reasoningCollapsedOverrides = new Map<string, boolean>();
  private appliedResolvedSessionKeys = new Set<string>();
  private fullscreenContainer: HTMLElement | null = null;
  private fullscreenReturnAnchor: {
    scrollContainer: HTMLElement;
    topWithinContainer: number;
  } | null = null;
  private fullscreenResizeObserver: ResizeObserver | null = null;
  private accessPopoverResizeObserver: ResizeObserver | null = null;
  private accessPopoverPositionFrame: number | null = null;
  private detachAccessPopoverScrollbar: (() => void) | null = null;
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
  private boundSyncFullscreenBounds = (): void => {
    this.syncFullscreenBounds();
  };
  private boundPositionAccessPopover = (): void => {
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
  private boundHandleAccessOutsidePointer = (event: PointerEvent): void => {
    if (!this.isAccessPopoverOpen) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.accessPopover.contains(target) ||
        this.accessButton.contains(target) ||
        this.externalEmptyFilesButton?.contains(target) ||
        this.composerRoleIcon.contains(target))
      )
      return;
    this.setAccessPopoverOpen(false);
    consumeEditorPopoverDismissPointer(event);
  };
  private boundHandleCodexSettingsOutsidePointer = (
    event: PointerEvent,
  ): void => {
    if (!this.isCodexSettingsPopoverOpen) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.codexSettingsPopover.contains(target) ||
        this.codexSettingsPopoverAnchor?.contains(target))
      )
      return;
    this.setCodexSettingsPopoverOpen(false);
    consumeEditorPopoverDismissPointer(event);
  };
  private boundPositionCodexSettingsPopover = (): void => {
    this.scheduleCodexSettingsPopoverPosition();
  };
  // 独立 outside-click 处理 ── 与 accessPopover 完全独立, 因为现在是
  // 两套独立的下拉弹窗, 一开一关互不干扰。 同样把 click 目标在
  // composerRoleIcon / composerRolePopover 内部的情况判作"内部", 不关
  // 弹窗。
  private boundHandleComposerRoleOutsidePointer = (
    event: PointerEvent,
  ): void => {
    if (!this.isComposerRolePopoverOpen) return;
    const target = event.target as globalThis.Node | null;
    if (
      target &&
      (this.composerRolePopover.contains(target) ||
        this.composerRoleIcon.contains(target))
      )
      return;
    this.setComposerRolePopoverOpen(false);
    consumeEditorPopoverDismissPointer(event);
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
    this.composerRoleIcon.addEventListener("click", (event) => {
      // 与同文件其它 trigger button (accessButton 等) 一致 ── stopPropagation
      // 阻止冒泡到卡片根 mousedown, 避免卡片被 selected / focus 状态接管,
      // 同时不让 document 级 outside-click listener 把"打开弹窗"那一下误判
      // 为 outside 而立即关闭。 boundHandleComposerRoleOutsidePointer 的
      // allowlist 已包含 this.composerRoleIcon, 见构造函数上方的 handler。
      event.stopPropagation();
      this.toggleComposerRolePopover();
    });

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
      this.setAccessPopoverOpen(!this.isAccessPopoverOpen);
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

    this.codexSettingsPopover = document.createElement("div");
    this.codexSettingsPopover.className =
      "agent-thread-card__codex-settings-popover";
    this.codexSettingsPopover.setAttribute("role", "menu");
    this.codexSettingsPopover.hidden = true;
    this.codexSettingsPopover.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    this.codexSettingsPopover.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    document.body.appendChild(this.codexSettingsPopover);

    // composerRolePopover ── 角色选择下拉弹窗, 直接挂在 composerRoleIcon
    // button 下方/上方, 不再嵌套在 accessPopover 里。 构造器一次性创建,
    // 挂到 document.body, 后续 renderRoleOptionsList 在它内部 replaceChildren
    // 复用 ── 与 accessPopover 同一套"单例 + replaceChildren"模式, 不
    // 每次重建节点 (避免反复 bind event listener / ResizeObserver)。
    this.composerRolePopover = document.createElement("div");
    this.composerRolePopover.className =
      "agent-thread-card__composer-role-popover";
    this.composerRolePopover.setAttribute("role", "menu");
    this.composerRolePopover.hidden = true;
    // 阻止 mousedown / click 冒泡 ── 弹窗内部的点击不应该触发卡片根
    // mousedown 处理 (避免 composer mousedown 把焦点抢到 textarea), 也
    // 不应该冒泡到 outside-click listener 把"选角色"误判为 outside 而
    // 关闭弹窗。 boundHandleComposerRoleOutsidePointer 的 allowlist
    // 已包含 composerRolePopover 自身 ── 内部点击不会被判 outside。
    this.composerRolePopover.addEventListener("mousedown", (event) =>
      event.stopPropagation(),
    );
    this.composerRolePopover.addEventListener("click", (event) =>
      event.stopPropagation(),
    );
    document.body.appendChild(this.composerRolePopover);
    this.composerRolePopoverController = createAnchoredPopoverController({
      isOpen: () => this.isComposerRolePopoverOpen,
      isDestroyed: () => this.isDestroyed,
      isHidden: () => this.composerRolePopover.hidden,
      position: () => this.positionComposerRolePopover(),
      observe: () => [this.composerRoleIcon],
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
    this.oversizedInputDraftDomValue = oversizedDomValue;
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
  //     refreshAttrs 里的 sync 逻辑会因为 draftSnapshot !== null 跳过
  //     对 input.value 的覆写, 保护用户正在键入的内容。
  private scheduleDraftPersist(nextDraft: string): void {
    this.draftSnapshot = nextDraft;
    if (this.draftPersistTimer !== null) {
      clearTimeout(this.draftPersistTimer);
    }
    this.draftPersistTimer = setTimeout(() => {
      this.draftPersistTimer = null;
      const snapshot = this.draftSnapshot;
      this.draftSnapshot = null;
      if (snapshot === null) return;
      this.updateAttrs({ inputDraft: snapshot || null });
    }, AGENT_THREAD_CARD_DRAFT_PERSIST_DEBOUNCE_MS);
  }

  private flushPendingDraft(): void {
    if (this.draftPersistTimer === null) return;
    clearTimeout(this.draftPersistTimer);
    this.draftPersistTimer = null;
    const snapshot = this.draftSnapshot;
    this.draftSnapshot = null;
    if (snapshot === null) return;
    // 直接走 ProseMirror 事务 (不再次 scheduleDraftPersist) ── 否则会
    // 形成 schedule 链, 永远延后。
    this.updateAttrs({ inputDraft: snapshot || null });
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
    let previousThreadId = this.renderThreadId;
    let previousThreadState = this.currentThreadState();
    let previousResolvedSessionId = this.runtimeThreadId
      ? useChatStore.getState().externalSessionResolutions[this.runtimeThreadId]
      : undefined;
    let previousPermissionMode = useChatStore.getState().agentPermissionMode;
    let previousCodexModel = useChatStore.getState().agentCodexModel;
    let previousCodexReasoningEffort =
      useChatStore.getState().agentCodexReasoningEffort;
    this.unsubscribe = useChatStore.subscribe((state) => {
      const threadId = this.runtimeThreadId;
      const renderThreadId = this.renderThreadId;
      const storedThreadId = (this.node.attrs.threadId as string | null) || null;
      const nextThreadState = renderThreadId
        ? state.threadStates[renderThreadId]
        : undefined;
      const resolvedSessionId =
        getResolvedExternalSessionId(threadId) ??
        getResolvedExternalSessionId(storedThreadId);
      const localThreadId =
        threadId && isLocalExternalThreadId(threadId, this.typeKey)
          ? threadId
          : storedThreadId && isLocalExternalThreadId(storedThreadId, this.typeKey)
            ? storedThreadId
            : null;
      const threadChanged =
        renderThreadId !== previousThreadId ||
        nextThreadState !== previousThreadState ||
        resolvedSessionId !== previousResolvedSessionId;
      const settingsChanged =
        state.agentPermissionMode !== previousPermissionMode ||
        state.agentCodexModel !== previousCodexModel ||
        state.agentCodexReasoningEffort !== previousCodexReasoningEffort;
      if (!threadChanged && !settingsChanged) return;
      previousThreadId = renderThreadId;
      previousThreadState = nextThreadState;
      previousResolvedSessionId = resolvedSessionId;
      previousPermissionMode = state.agentPermissionMode;
      previousCodexModel = state.agentCodexModel;
      previousCodexReasoningEffort = state.agentCodexReasoningEffort;
      if (settingsChanged) {
        this.refreshExternalAgentEmptySettings();
        if (this.isCodexSettingsPopoverOpen) this.renderCodexSettingsPopover();
      }
      if (threadChanged) this.renderThreadState();
      if (
        threadChanged &&
        (this.typeKey === "codex" || this.typeKey === "claude") &&
        !!localThreadId &&
        resolvedSessionId
      ) {
        this.applyResolvedExternalSessionId(
          localThreadId,
          resolvedSessionId,
          this.typeKey,
        );
      } else if (
        threadChanged &&
        (this.typeKey === "codex" || this.typeKey === "claude") &&
        !!threadId &&
        isLocalExternalThreadId(threadId, this.typeKey) &&
        nextThreadState &&
        !nextThreadState.isLoading &&
        !nextThreadState.activeRunId
      ) {
        void resolveExternalSessionId(threadId, this.typeKey).then(
          (sessionId) => {
            if (sessionId && sessionId !== threadId) {
              this.applyResolvedExternalSessionId(
                threadId,
                sessionId,
                this.typeKey,
              );
            }
          },
        );
      }
    });
    let previousConversationInstance = this.instance;
    let previousConversationMessageState = this.currentConversationMessageState();
    this.unsubscribeConversation = useAgentConversationStore.subscribe((state) => {
      const instanceId = this.instanceId;
      const threadId = this.renderThreadId;
      const nextInstance = instanceId ? state.instances[instanceId] : undefined;
      const nextMessageState = threadId
        ? state.messageStates[threadId]
        : undefined;
      const instanceChanged = nextInstance !== previousConversationInstance;
      const messagesChanged =
        nextMessageState !== previousConversationMessageState;
      if (!instanceChanged && !messagesChanged) return;
      previousConversationInstance = nextInstance ?? null;
      previousConversationMessageState = nextMessageState ?? null;
      if (instanceChanged) this.refreshAttrs();
      this.renderThreadState();
    });
  }

  private subscribeAccessPopover(): void {
    this.unsubscribeAccess = useAgentAccessStore.subscribe(() => {
      // agent-access 状态变化 (toggle / setWorkspace / addFolder /
      // removeFolder / loadInitial) 都可能改变主空间指向, 同步刷新 label。
      this.refreshExternalAgentEmptySettings();
      if (this.isAccessPopoverOpen) this.renderAccessPopover();
    });
    this.unsubscribeRuntime = useAgentRuntimeStore.subscribe(() => {
      this.syncAgentRuntimeBadge();
    });
    this.unsubscribeNotebooks = useMemoStore.subscribe(() => {
      if (this.isAccessPopoverOpen) this.renderAccessPopover();
    });
  }

  private loadCodexDefaultModel(): void {
    const typeKey = this.typeKey;
    void agent
      .getCodexDefaultModel()
      .then((model) => {
        if (this.isDestroyed) return;
        this.codexDefaultModel = model.trim();
        this.refreshExternalAgentEmptySettings();
        if (
          this.isCodexSettingsPopoverOpen &&
          this.codexSettingsPopoverKind === "model"
        ) {
          this.renderCodexSettingsPopover();
          this.scheduleCodexSettingsPopoverPosition();
        }
      })
      .catch(() => {
        // Keep the generic default label when Codex has no configured default.
      });

    void agent
      .listSupportedModels(typeKey)
      .then((models) => {
        if (this.isDestroyed || this.typeKey !== typeKey) return;
        const seen = new Set<string>();
        this.localSupportedModelsTypeKey = typeKey;
        this.localSupportedModels = models
          .map((model) => model.trim())
          .filter((model) => model.length > 0)
          .filter((model) => {
            if (seen.has(model)) return false;
            seen.add(model);
            return true;
          })
          .map((model) => ({ id: model, label: model }));
        this.refreshExternalAgentEmptySettings();
        if (
          this.isCodexSettingsPopoverOpen &&
          this.codexSettingsPopoverKind === "model"
        ) {
          this.renderCodexSettingsPopover();
          this.scheduleCodexSettingsPopoverPosition();
        }
      })
      .catch(() => {
        if (this.isDestroyed || this.typeKey !== typeKey) return;
        this.localSupportedModelsTypeKey = typeKey;
        this.localSupportedModels = [];
      });
  }

  private setAccessPopoverOpen(
    open: boolean,
    anchor: HTMLElement | null = null,
    preferBelow = false,
  ): void {
    if (this.isAccessPopoverOpen === open) return;
    this.isAccessPopoverOpen = open;
    this.accessPopoverAnchor = open ? (anchor ?? this.accessButton) : null;
    this.accessPopoverPreferBelow = open && preferBelow;
    this.accessPopover.hidden = !open;
    this.accessButton.setAttribute("aria-expanded", open ? "true" : "false");
    this.accessButton.classList.toggle(
      "agent-thread-card__access-trigger--open",
      open,
    );

    if (open) {
      const accessState = useAgentAccessStore.getState();
      const memoState = useMemoStore.getState();
      if (!accessState.isLoading && accessState.config.entries.length === 0) {
        void accessState.loadInitial();
      }
      if (memoState.notebooks.length === 0) {
        void memoState.loadNotebooks().catch(() => {});
      }
      this.renderAccessPopover();
      this.scheduleAccessPopoverPosition();
      this.startAccessPopoverPositionTracking();
      document.addEventListener(
        "pointerdown",
        this.boundHandleAccessOutsidePointer,
        true,
      );
    } else {
      // 之前"关闭主弹窗时同时关闭二级弹窗 (typeSettingsPopover)"的逻辑
      // 已删除 ── role popover 现在是独立的 composerRolePopover, 与
      // accessPopover 完全解耦, 不再跟随主弹窗一起关。 用户可以在
      // accessPopover 关闭后仍打开 role popover, 反之亦然。
      this.stopAccessPopoverPositionTracking();
      document.removeEventListener(
        "pointerdown",
        this.boundHandleAccessOutsidePointer,
        true,
      );
      // 拆掉 overlay scrollbar 的 scroll/resize/pointer 监听 ── 弹窗
      // 关闭后 thumb 不再使用, 留着 listener 只占内存 (pointer capture
      // 还可能跨打开/关闭边界残留 state)。 下次打开会重新 attach。
      this.detachAccessPopoverScrollbar?.();
      this.detachAccessPopoverScrollbar = null;
    }
  }

  private renderAccessPopover(): void {
    const { config, isLoading, toggle, addFolderFromPicker, removeFolder } =
      useAgentAccessStore.getState();
    const { notebooks } = useMemoStore.getState();
    const notebookEntries = config.entries.filter(
      (entry) => entry.kind === "notebook",
    );
    const folderEntries = config.entries.filter(
      (entry) => entry.kind === "folder",
    );

    this.accessPopover.replaceChildren();

    // ── DOM 结构 ──
    // outer access-popover (fixed, overflow visible) 包一层:
    //   .overlay-scrollbar-frame           ── 滚动容器外壳 (relative,
    //     overflow hidden), 装 thumb 元素
    //   .access-popover-scroll             ── 内部真实滚动元素 (overflow
    //     auto + 隐藏原生滚动条), 装整个内容
    //     - notebook 列表 (或 folder 列表, 顺序见下)
    //     - 分隔线 (两边都有时才画)
    //     - folder 列表 (或 notebook 列表, 顺序见下)
    //     - 末尾的"添加资料夹"按钮
    //   .overlay-scrollbar-thumb           ── 自定义 thumb, 走 mention
    //     下拉同源的 `html[data-platform="non-mac"] .overlay-scrollbar-*`
    //     样式; attachAccessPopoverScrollbar 同步 thumb 位置 + 处理拖动
    //
    // 顺序 ── folder (自定义资料夹) 在 notebook 之上。 folder 是用户主动
    // 添加的工作目录 (本次会话粒度, 上下文重要), notebook 是静态资产
    // (默认启用, 重要但权重低)。 把 folder 放上面, 用户打开弹窗第一眼
    // 看到的是"这次会话能访问什么文件", 而不是"所有笔记本"。
    //
    // 之前顺序是 notebook → folder, 现在改成 folder → notebook; folder
    // 为空时 (常见) 只显示 notebook section, 视觉与原顺序无差。
    //
    // 角色选择入口已从 accessPopover 移除 ── 改为左侧 composerRoleIcon
    // button → 独立的 composerRolePopover 单级下拉。
    const scrollFrame = document.createElement("div");
    scrollFrame.className = "overlay-scrollbar-frame";
    this.accessPopover.append(scrollFrame);

    const scrollWrap = document.createElement("div");
    scrollWrap.className =
      "agent-thread-card__access-popover-scroll overlay-scrollbar";
    scrollFrame.append(scrollWrap);

    const thumb = document.createElement("div");
    thumb.className = "overlay-scrollbar-thumb";
    thumb.setAttribute("aria-hidden", "true");
    scrollFrame.append(thumb);

    // "添加资料夹"按钮 ── footerWrap 总是创建, 挂载位置按场景分:
    //   - folderEntries.length > 0 ── 紧贴最后一个 folder row (folder
    //     section 末尾), 视觉上属于 folder section, 用户翻到 notebook
    //     之前就能看到, 表达"按钮是给 folder 列表用的"。
    //   - folderEntries.length === 0 (含纯 notebook / 纯 empty 两个
    //     子情况) ── 没有 folder section 可"末尾", fallback 到
    //     scrollWrap 末尾, 仍可见可用, 用户可加第一个 folder。
    //
    // 视觉与左栏笔记本列表「+ 新建」同源 ── 24×24 圆角图标容器包 14px
    // Plus 图标 + 单行文字左对齐。 结构:
    //   [icon-wrap(24×24) → Plus(14×14)] [label(单行截断)]
    //
    // footerWrap 用一个 div 包 button ── 给一点上方的呼吸空间
    // (margin-top) + 让 button 在 scroll 内与 row 风格区分 (透明的
    // 容器, 不是 row)。
    const footerWrap = document.createElement("div");
    footerWrap.className = "agent-thread-card__access-popover-footer";

    if (notebookEntries.length === 0 && folderEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "agent-thread-card__access-empty";
      empty.textContent = isLoading
        ? this.t("agent.access.empty.loading")
        : this.t("agent.access.empty.empty");
      scrollWrap.append(empty);
      // empty 态: 按钮 fallback 到 scrollWrap 末尾, 让用户在加载未完成
      // 或全部清空时仍能点"添加资料夹"。
      scrollWrap.append(footerWrap);
    } else {
      // folder 在上 (本次会话的临时工作目录, 优先级高)
      if (folderEntries.length > 0) {
        scrollWrap.append(
          createAccessSectionLabel(this.t("agent.access.sectionFolder")),
        );
        folderEntries.forEach((entry) => {
          scrollWrap.append(
            createAccessEntryRow({
              entry,
              notebooks,
              t: (key) => this.t(key as I18nKey),
              toggle,
              removeFolder,
            }),
          );
        });
        // 按钮紧贴最后一个 folder row (见上方注释) ── 视觉上属于 folder
        // section。 之前放在 scrollWrap 末尾 (notebook 之后) ── 与
        // folder 语义割裂, 用户得翻过整个 notebook section 才能找到
        // "加一个"。
        scrollWrap.append(footerWrap);
      }
      if (notebookEntries.length > 0 && folderEntries.length > 0) {
        scrollWrap.append(createAccessDivider());
      }
      // notebook 在下 (静态资产, 默认集合)
      if (notebookEntries.length > 0) {
        scrollWrap.append(
          createAccessSectionLabel(this.t("agent.access.sectionNotebook")),
        );
        notebookEntries.forEach((entry) => {
          scrollWrap.append(
            createAccessEntryRow({
              entry,
              notebooks,
              t: (key) => this.t(key as I18nKey),
              toggle,
              removeFolder,
            }),
          );
        });
        // folderEntries === 0 (只显示 notebook) ── 没有 folder section
        // 可挂, fallback 到 scrollWrap 末尾。
        if (folderEntries.length === 0) {
          scrollWrap.append(footerWrap);
        }
      }
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "agent-thread-card__access-add";
    const addIconWrap = document.createElement("span");
    addIconWrap.className = "agent-thread-card__access-add-icon-wrap";
    addIconWrap.append(createPlusIcon());
    const addLabel = document.createElement("span");
    addLabel.className = "agent-thread-card__access-add-label";
    addLabel.textContent = this.t("agent.access.addFolder");
    addButton.append(addIconWrap, addLabel);
    addButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void addFolderFromPicker().then((result) => {
        if (!result.ok && result.code !== "not-selected") {
          console.error(`addFolderFromPicker error: ${result.code}`);
        }
      });
    });
    footerWrap.append(addButton);

    // 重渲时拆掉上一次绑的滚动条监听 (renderAccessPopover 会被 store
    // subscribe 调用多次, 每次都新建 DOM + 重连), 否则会泄漏 listener
    // ── 每多渲染一次就多挂一份 scroll/resize/pointer 监听, 旧 DOM
    // 节点被 replaceChildren 丢出 DOM 树但 listener 还在, GC 不到。
    this.detachAccessPopoverScrollbar?.();
    this.detachAccessPopoverScrollbar =
      attachAccessPopoverScrollbar(scrollWrap);

    this.scheduleAccessPopoverPosition();
  }

  private getPermissionLabel(id: AgentPermissionMode): string {
    const options = this.getAccessOptionsForType();
    return (
      options.find((option) => option.id === id)?.label ?? options[0].label
    );
  }

  private getAccessOptionsForType(): readonly {
    id: AgentPermissionMode;
    label: string;
  }[] {
    return getAgentAccessOptions(this.typeKey);
  }

  private getCodexModelOptions(): AgentModelOption[] {
    const inheritLabel = this.codexDefaultModel
      ? translate(this.language, "agent.codexModel.defaultWith", {
          model: this.codexDefaultModel,
        })
      : this.t("agent.codexModel.default");
    const agentCodexModel = useChatStore.getState().agentCodexModel;
    const localOptions =
      this.localSupportedModelsTypeKey === this.typeKey
        ? this.localSupportedModels
        : [];
    const modelOptions =
      localOptions.length > 0 ? localOptions : CODEX_MODEL_OPTIONS;
    const options: AgentModelOption[] = [
      { id: "inherit", label: inheritLabel },
      ...modelOptions,
    ];
    if (
      agentCodexModel !== "inherit" &&
      !options.some((option) => option.id === agentCodexModel)
    ) {
      options.push({ id: agentCodexModel, label: agentCodexModel });
    }
    return options;
  }

  private getCurrentCodexModelLabel(): string {
    const model = useChatStore.getState().agentCodexModel;
    return (
      this.getCodexModelOptions().find((option) => option.id === model)
        ?.label ?? this.t("agent.codexModel.default")
    );
  }

  private getCurrentCodexReasoningLabel(): string {
    const effort = useChatStore.getState().agentCodexReasoningEffort;
    return (
      CODEX_REASONING_OPTIONS.find((option) => option.id === effort)?.label ??
      "Medium"
    );
  }

  private getCurrentPermissionLabel(): string {
    return this.getPermissionLabel(useChatStore.getState().agentPermissionMode);
  }

  private getFilesControlLabel(): string {
    // 按钮 value 从「已启用的可访问文件夹数量」改为「主工作空间 (主空间) 的
    // 末尾文件夹名称」。 主工作空间是 agent-access 配置里 `workspace=true`
    // 那一条 (由 `normalizeWorkspaceSelection` 自动把第一个启用的 folder
    // 标记为主空间, 用户也可手动 `setWorkspace` 切换) ── 这才是 Flowix 里
    // "工作空间"的真源, 跟当前打开的 memo 所属笔记本不一定一致 (笔记本是
    // 静态资产, 主空间是用户在 agent access 配置里选的主目录)。
    //
    // 取名口径: entry.name (用户加 folder 时给的别名 / 默认末段) 优先;
    // name 为空时从 path 末段兜底。 都没拿到才回落空态文案。
    const workspaceEntry = useAgentAccessStore
      .getState()
      .config.entries.find(
        (entry) => entry.workspace && !entry.missing,
      );
    if (!workspaceEntry) return this.t("agent.access.empty.empty");
    const explicitName = workspaceEntry.name?.trim();
    if (explicitName) return explicitName;
    const segments = workspaceEntry.path.split(/[\\/]+/).filter(Boolean);
    const folderName = segments[segments.length - 1]?.trim();
    return folderName ? folderName : this.t("agent.access.empty.empty");
  }

  private createExternalAgentEmptyControl(
    kind: ExternalAgentEmptyControlKind,
    label: string,
    value: string,
  ): HTMLButtonElement {
    return createExternalAgentEmptyControl(kind, label, value, (nextKind, button) => {
      if (nextKind === "files") {
        this.setCodexSettingsPopoverOpen(false);
        this.setAccessPopoverOpen(!this.isAccessPopoverOpen, button, true);
        return;
      }
      this.setAccessPopoverOpen(false);
      this.toggleCodexSettingsPopover(nextKind, button);
    });
  }

  private supportsRuntimeSetting(
    kind: AgentRuntimeSettingKind,
  ): boolean {
    return supportsAgentRuntimeSetting(this.typeKey, kind);
  }

  private createExternalAgentEmptySettings(): HTMLElement {
    const empty = document.createElement("div");
    empty.className =
      "agent-thread-card__empty agent-thread-card__empty--codex-settings";

    this.externalEmptyModelButton = this.supportsRuntimeSetting("model")
      ? this.createExternalAgentEmptyControl(
          "model",
          this.t("agent.model.title"),
          this.getCurrentCodexModelLabel(),
        )
      : null;
    this.externalEmptyReasoningButton = null;
    this.externalEmptyPermissionButton =
      this.supportsRuntimeSetting("permission")
        ? this.createExternalAgentEmptyControl(
            "permission",
            this.t("agent.permission.title"),
            this.getCurrentPermissionLabel(),
          )
        : null;
    this.externalEmptyFilesButton = this.createExternalAgentEmptyControl(
      "files",
      this.t("agent.files.title"),
      this.getFilesControlLabel(),
    );

    for (const button of [
      this.externalEmptyModelButton,
      this.externalEmptyReasoningButton,
      this.externalEmptyPermissionButton,
      this.externalEmptyFilesButton,
    ]) {
      if (button) empty.append(button);
    }
    return empty;
  }

  private refreshExternalAgentEmptySettings(): void {
    this.updateExternalAgentEmptyControl(
      this.externalEmptyModelButton,
      this.getCurrentCodexModelLabel(),
    );
    this.updateExternalAgentEmptyControl(
      this.externalEmptyPermissionButton,
      this.getCurrentPermissionLabel(),
    );
    this.updateExternalAgentEmptyControl(
      this.externalEmptyReasoningButton,
      this.getCurrentCodexReasoningLabel(),
    );
    this.updateExternalAgentEmptyControl(
      this.externalEmptyFilesButton,
      this.getFilesControlLabel(),
    );
  }

  private updateExternalAgentEmptyControl(
    button: HTMLButtonElement | null,
    value: string,
  ): void {
    updateExternalAgentEmptyControl(button, value);
  }

  private toggleCodexSettingsPopover(
    kind: AgentRuntimeSettingKind,
    anchor: HTMLButtonElement,
  ): void {
    const sameMenuOpen =
      this.isCodexSettingsPopoverOpen &&
      this.codexSettingsPopoverKind === kind &&
      this.codexSettingsPopoverAnchor === anchor;
    this.setCodexSettingsPopoverOpen(!sameMenuOpen, kind, anchor);
  }

  private setCodexSettingsPopoverOpen(
    open: boolean,
    kind: AgentRuntimeSettingKind | null = null,
    anchor: HTMLButtonElement | null = null,
  ): void {
    if (
      this.isCodexSettingsPopoverOpen === open &&
      (!open || this.codexSettingsPopoverKind === kind)
    )
      return;
    this.isCodexSettingsPopoverOpen = open;
    this.codexSettingsPopoverKind = open ? kind : null;
    this.codexSettingsPopoverAnchor = open ? anchor : null;
    this.codexSettingsPopover.hidden = !open;
    this.externalEmptyModelButton?.setAttribute(
      "aria-expanded",
      open && kind === "model" ? "true" : "false",
    );
    this.externalEmptyPermissionButton?.setAttribute(
      "aria-expanded",
      open && kind === "permission" ? "true" : "false",
    );
    this.externalEmptyReasoningButton?.setAttribute(
      "aria-expanded",
      open && kind === "reasoning" ? "true" : "false",
    );
    this.externalEmptyModelButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "model",
    );
    this.externalEmptyPermissionButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "permission",
    );
    this.externalEmptyReasoningButton?.classList.toggle(
      "agent-thread-card__empty-control--open",
      open && kind === "reasoning",
    );

    if (open && kind && anchor) {
      this.renderCodexSettingsPopover();
      this.scheduleCodexSettingsPopoverPosition();
      this.startCodexSettingsPopoverPositionTracking();
      document.addEventListener(
        "pointerdown",
        this.boundHandleCodexSettingsOutsidePointer,
        true,
      );
    } else {
      this.stopCodexSettingsPopoverPositionTracking();
      document.removeEventListener(
        "pointerdown",
        this.boundHandleCodexSettingsOutsidePointer,
        true,
      );
    }
  }

  private renderCodexSettingsPopover(): void {
    const kind = this.codexSettingsPopoverKind;
    this.codexSettingsPopover.replaceChildren();
    if (!kind) return;
    if (!this.supportsRuntimeSetting(kind)) return;

    if (kind !== "model") {
      const title = document.createElement("div");
      title.className = "agent-thread-card__codex-settings-title";
      title.textContent = this.t(kind === "reasoning" ? "agent.reasoning.title" : "agent.permission.title");
      this.codexSettingsPopover.append(title);
    }

    if (kind === "model") {
      const modelSection = document.createElement("div");
      modelSection.className = "agent-thread-card__codex-settings-section";
      modelSection.textContent = this.t("agent.model.title");
      this.codexSettingsPopover.append(modelSection);

      const current = useChatStore.getState().agentCodexModel;
      this.getCodexModelOptions().forEach((option) => {
        this.codexSettingsPopover.append(
          createCodexSettingsItem(
            option.label,
            option.id === current,
            () => {
              useChatStore.getState().setAgentCodexModel(option.id);
              this.setCodexSettingsPopoverOpen(false);
            },
          ),
        );
      });

      const divider = document.createElement("hr");
      divider.className = "agent-thread-card__codex-settings-divider";
      this.codexSettingsPopover.append(divider);

      const reasoningSection = document.createElement("div");
      reasoningSection.className = "agent-thread-card__codex-settings-section";
      reasoningSection.textContent = this.t("agent.reasoningDepth.title");
      this.codexSettingsPopover.append(reasoningSection);

      const reasoning = useChatStore.getState().agentCodexReasoningEffort;
      CODEX_REASONING_OPTIONS.forEach((option) => {
        this.codexSettingsPopover.append(
          createCodexSettingsItem(
            option.label,
            option.id === reasoning,
            () => {
              useChatStore.getState().setAgentCodexReasoningEffort(option.id);
              this.setCodexSettingsPopoverOpen(false);
            },
          ),
        );
      });
      return;
    }

    if (kind === "reasoning") {
      const current = useChatStore.getState().agentCodexReasoningEffort;
      CODEX_REASONING_OPTIONS.forEach((option) => {
        this.codexSettingsPopover.append(
          createCodexSettingsItem(
            option.label,
            option.id === current,
            () => {
              useChatStore.getState().setAgentCodexReasoningEffort(option.id);
              this.setCodexSettingsPopoverOpen(false);
            },
          ),
        );
      });
      return;
    }

    const current = useChatStore.getState().agentPermissionMode;
    this.getAccessOptionsForType().forEach((option) => {
      this.codexSettingsPopover.append(
        createCodexSettingsItem(
          option.label,
          option.id === current,
          () => {
            useChatStore.getState().setAgentPermissionMode(option.id);
            this.setCodexSettingsPopoverOpen(false);
          },
        ),
      );
    });
  }

  private startCodexSettingsPopoverPositionTracking(): void {
    window.addEventListener("resize", this.boundPositionCodexSettingsPopover);
    window.addEventListener(
      "scroll",
      this.boundPositionCodexSettingsPopover,
      true,
    );
    if ("ResizeObserver" in window && this.codexSettingsPopoverAnchor) {
      this.codexSettingsPopoverResizeObserver?.disconnect();
      this.codexSettingsPopoverResizeObserver = new ResizeObserver(() => {
        this.scheduleCodexSettingsPopoverPosition();
      });
      this.codexSettingsPopoverResizeObserver.observe(
        this.codexSettingsPopoverAnchor,
      );
      this.codexSettingsPopoverResizeObserver.observe(
        this.codexSettingsPopover,
      );
    }
  }

  private stopCodexSettingsPopoverPositionTracking(): void {
    window.removeEventListener(
      "resize",
      this.boundPositionCodexSettingsPopover,
    );
    window.removeEventListener(
      "scroll",
      this.boundPositionCodexSettingsPopover,
      true,
    );
    this.codexSettingsPopoverResizeObserver?.disconnect();
    this.codexSettingsPopoverResizeObserver = null;
    if (this.codexSettingsPopoverPositionFrame !== null) {
      window.cancelAnimationFrame(this.codexSettingsPopoverPositionFrame);
      this.codexSettingsPopoverPositionFrame = null;
    }
  }

  private scheduleCodexSettingsPopoverPosition(): void {
    if (
      !this.isCodexSettingsPopoverOpen ||
      this.codexSettingsPopover.hidden ||
      this.isDestroyed
    )
      return;
    if (this.codexSettingsPopoverPositionFrame !== null) return;
    this.codexSettingsPopoverPositionFrame = window.requestAnimationFrame(
      () => {
        this.codexSettingsPopoverPositionFrame = null;
        this.positionCodexSettingsPopover();
      },
    );
  }

  private positionCodexSettingsPopover(): void {
    const anchor = this.codexSettingsPopoverAnchor;
    if (
      !this.isCodexSettingsPopoverOpen ||
      this.codexSettingsPopover.hidden ||
      !anchor ||
      this.isDestroyed
    )
      return;
    if (!anchor.isConnected || !this.codexSettingsPopover.isConnected) {
      this.setCodexSettingsPopoverOpen(false);
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const padding = CODEX_SETTINGS_POPOVER_VIEWPORT_PADDING_PX;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverRect = this.codexSettingsPopover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || CODEX_SETTINGS_POPOVER_WIDTH_PX;
    const popoverHeight = Math.min(
      popoverRect.height || CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX,
      CODEX_SETTINGS_POPOVER_MAX_HEIGHT_PX,
    );
    applyPopoverPosition(
      this.codexSettingsPopover,
      calculateAnchoredPopoverPosition({
        anchorRect,
        popoverWidth,
        popoverHeight,
        viewportWidth,
        viewportHeight,
        padding,
        offset: CODEX_SETTINGS_POPOVER_OFFSET_PX,
      }),
    );
  }

  private getAgentRoleOptions(): AgentRoleOption[] {
    return this.agentRoleOptions ?? fallbackAgentRoleOptionsFromStore();
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

  private loadAgentRoleOptions(): void {
    if (this.isLoadingAgentRoleOptions) return;
    if (this.agentRoleOptions === null) {
      this.agentRoleOptions = fallbackAgentRoleOptionsFromStore();
    }
    const requestSeq = ++this.agentRoleOptionsRequestSeq;
    this.isLoadingAgentRoleOptions = true;
    void listAgentRoleMemosWithTimeout()
      .then((items) => {
        if (this.isDestroyed || requestSeq !== this.agentRoleOptionsRequestSeq)
          return;
        this.agentRoleOptions = items.map((item) => ({
          memoId: item.memoId,
          name: item.roleName,
          filename: item.filename,
          memoIcon: item.memoIcon,
          notebookId: item.notebookId,
          notebookName: item.notebookName,
          notebookIcon: item.notebookIcon,
        }));
      })
      .catch((error) => {
        console.error(
          "[AgentThreadCard] Failed to load agent-role memos:",
          error,
        );
        if (
          !this.isDestroyed &&
          requestSeq === this.agentRoleOptionsRequestSeq
        ) {
          this.agentRoleOptions = fallbackAgentRoleOptionsFromStore();
        }
      })
      .finally(() => {
        if (this.isDestroyed || requestSeq !== this.agentRoleOptionsRequestSeq)
          return;
        this.isLoadingAgentRoleOptions = false;
        this.refreshComposerRoleIcon();
        if (
          this.isComposerRolePopoverOpen &&
          !this.composerRolePopover.hidden
        ) {
          this.renderRoleOptionsList(this.composerRolePopover);
          this.scheduleComposerRolePopoverPosition();
        }
      });
  }

  /**
   * 加载 Agent Role memo body ── 提交首条消息时, 把对应 memo 的 markdown
   * 内容拼到 user 消息末尾。 走两步:
   *   1. memosClient.readMemo(memoId) 拿 Memo (含 filename)
   *   2. memosClient.readDocument(notebookPath/filename) 拿 body
   *
   * notebookPath 来源: AgentRoleOption.notebookId → useMemoStore.notebooks
   * 找 path (listAgentRoleMemos 返回的 notebookId 是后端 notebook.id, 与
   * store notebooks.id 同源)。
   *
   * 缓存: cachedAgentRoleBodies 命中直接返回; 失败也缓存 null, 避免对
   * 已删文档反复重试 IPC ── 角色文档被删是显式操作, 让用户重选 role 才是
   * 正确恢复路径。
   */
  private async loadAgentRoleBody(memoId: string): Promise<string | null> {
    return loadAgentRoleBodyFromMemo({
      memoId,
      roleOptions: this.getAgentRoleOptions(),
      cache: this.cachedAgentRoleBodies,
      isDestroyed: () => this.isDestroyed,
    });
  }

  private renderRoleOptionsList(target: HTMLElement): void {
    target.replaceChildren();
    const entries = this.getAgentRoleOptions();
    const currentMemoId = this.agentRoleMemoId;

    // 是否锁定: 已发送过消息后, Role 已被 inline 拼到首条 user 消息
    // 末尾, 后续切换不会回灌历史消息 ── 锁定 UI 让用户感知"现在改也
    // 无效"。 判定: 关联 thread 的消息数 > 0 ── 与 chat-store 的
    // `isFirstMessage = currentMessages.length === 0` 同源。
    const messageCount = this.currentMessages().length;
    const isLocked = messageCount > 0;

    const header = document.createElement("div");
    header.className = "agent-thread-card__composer-role-popover-header";
    const title = document.createElement("div");
    title.className = "agent-thread-card__composer-role-popover-title";
    // 锁定时把"(开启对话后无法切换)" 直接拼到 title 后面 ── 视觉上
    // 是 header 副标题延伸, 不再单独开一行 hint, 节省垂直空间。
    // 用 muted-foreground 同色, 通过 spacing (空格 + 半角括号) 区分
    // 主标题, 不引入新的字号/颜色 token。
    title.textContent = isLocked
      ? `${this.t("editor.threadCard.selectRole")} ${this.t(
          "editor.threadCard.selectRoleLocked",
        )}`
      : this.t("editor.threadCard.selectRole");
    header.append(title);
    if (this.isLoadingAgentRoleOptions) {
      header.append(createRoleOptionsLoadingIcon());
    }
    target.append(header);

    if (this.isLoadingAgentRoleOptions && this.agentRoleOptions === null) {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "agent-thread-card__composer-role-item agent-thread-card__composer-role-item--disabled";
      item.disabled = true;
      item.setAttribute("role", "menuitem");
      const fallback = document.createElement("span");
      fallback.className = "agent-thread-card__composer-role-item-fallback";
      fallback.textContent = "...";
      const body = document.createElement("span");
      body.className = "agent-thread-card__composer-role-item-body";
      const name = document.createElement("span");
      name.className = "agent-thread-card__composer-role-item-name";
      name.textContent = "加载角色";
      const desc = document.createElement("span");
      desc.className = "agent-thread-card__composer-role-item-desc";
      desc.textContent = "正在读取所有笔记本";
      body.append(name, desc);
      item.append(fallback, body);
      target.append(item);
      return;
    }

    if (entries.length === 0) {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "agent-thread-card__composer-role-item agent-thread-card__composer-role-item--disabled";
      item.disabled = true;
      item.setAttribute("role", "menuitem");
      const fallback = document.createElement("span");
      fallback.className = "agent-thread-card__composer-role-item-fallback";
      fallback.textContent = "-";
      const body = document.createElement("span");
      body.className = "agent-thread-card__composer-role-item-body";
      const name = document.createElement("span");
      name.className = "agent-thread-card__composer-role-item-name";
      name.textContent = "没有角色";
      const desc = document.createElement("span");
      desc.className = "agent-thread-card__composer-role-item-desc";
      desc.textContent = "在笔记属性中设置 agent-role";
      body.append(name, desc);
      item.append(fallback, body);
      target.append(item);
      return;
    }

    for (const entry of entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "agent-thread-card__composer-role-item";
      item.setAttribute("role", "menuitem");

      const isCurrent = entry.memoId === currentMemoId;
      if (isCurrent) {
        item.classList.add("agent-thread-card__composer-role-item--selected");
      }

      // 锁定态: 非当前选中的项都灰显 + 禁用, 禁止切换 ── Role 已被
      // 拼到首条 user 消息末尾, 后续切不回灌历史, 让用户改也无效。
      // 当前选中项保留可点击 (允许再次点击, 行为同"关弹窗"), 不让
      // 它看着"突然变灰"反直觉 ── 但点它不触发 updateAttrs, 等价
      // no-op, 用户没有副作用。
      if (isLocked && !isCurrent) {
        item.classList.add("agent-thread-card__composer-role-item--disabled");
        item.disabled = true;
        item.setAttribute("aria-disabled", "true");
      }

      const sourceIcon = document.createElement("span");
      sourceIcon.className = "agent-thread-card__composer-role-item-icon";
      const memoIcon = entry.memoIcon?.trim() || "";
      if (appendRoleIconContent(sourceIcon, memoIcon, entry.name)) {
        sourceIcon.classList.toggle(
          "agent-thread-card__composer-role-item-icon--svg",
          !!getNotebookIconMarkup(memoIcon) && !getPropertyIconOption(memoIcon),
        );
      } else {
        sourceIcon.textContent = getNotebookIconLetter(entry.name);
      }

      const body = document.createElement("span");
      body.className = "agent-thread-card__composer-role-item-body";

      const name = document.createElement("span");
      name.className = "agent-thread-card__composer-role-item-name";
      name.textContent = entry.name;

      const desc = document.createElement("span");
      desc.className = "agent-thread-card__composer-role-item-desc";
      desc.textContent = displayTitleFromFilename(entry.filename);

      body.append(name, desc);
      item.append(sourceIcon, body);

      // 锁定态下非当前项不绑 click (双重保险: 即使 disabled 因 CSS
      // 失效也不会改 attrs)。 当前项在锁定态仍绑 click, 行为退化为
      // "再次点选同角色" = 关弹窗, no-op。
      if (!isLocked || isCurrent) {
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          this.updateAgentRole({ memoId: entry.memoId, name: entry.name });
          this.setComposerRolePopoverOpen(false);
        });
      }

      target.append(item);
    }
  }

  private setComposerRolePopoverOpen(open: boolean): void {
    if (this.isComposerRolePopoverOpen === open) return;
    this.isComposerRolePopoverOpen = open;
    this.composerRolePopover.hidden = !open;
    // composerRoleIcon 是 trigger button, aria-expanded 必须同步反映
    // 弹窗状态 ── 与同文件其它 trigger button 完全同构。
    this.composerRoleIcon.setAttribute(
      "aria-expanded",
      open ? "true" : "false",
    );
    this.composerRoleIcon.classList.toggle(
      "agent-thread-card__composer-role-icon--open",
      open,
    );

    if (open) {
      this.loadAgentRoleOptions();
      this.renderRoleOptionsList(this.composerRolePopover);
      this.scheduleComposerRolePopoverPosition();
      this.startComposerRolePopoverPositionTracking();
      document.addEventListener(
        "pointerdown",
        this.boundHandleComposerRoleOutsidePointer,
        true,
      );
    } else {
      this.stopComposerRolePopoverPositionTracking();
      document.removeEventListener(
        "pointerdown",
        this.boundHandleComposerRoleOutsidePointer,
        true,
      );
    }
  }

  private toggleComposerRolePopover(): void {
    this.setComposerRolePopoverOpen(!this.isComposerRolePopoverOpen);
  }

  private startComposerRolePopoverPositionTracking(): void {
    this.composerRolePopoverController?.start();
  }

  private stopComposerRolePopoverPositionTracking(): void {
    this.composerRolePopoverController?.stop();
  }

  private scheduleComposerRolePopoverPosition(): void {
    this.composerRolePopoverController?.schedule();
  }

  // 定位 ── 与 accessPopover 完全同思路:
  //   - 视口上下空间比较, 自动选择 above / below
  //   - ACCESS_POPOVER_OFFSET_*_PX / ACCESS_POPOVER_VIEWPORT_PADDING_PX 复用
  //   - 水平方向: button 左对齐到 popover 左, 避免右侧溢出
  private positionComposerRolePopover(): void {
    if (
      !this.isComposerRolePopoverOpen ||
      this.composerRolePopover.hidden ||
      this.isDestroyed
    )
      return;
    if (
      !this.composerRoleIcon.isConnected ||
      !this.composerRolePopover.isConnected
    ) {
      this.setComposerRolePopoverOpen(false);
      return;
    }

    const anchorRect = this.composerRoleIcon.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = ACCESS_POPOVER_VIEWPORT_PADDING_PX;
    const spaceAbove =
      anchorRect.top - padding - ACCESS_POPOVER_OFFSET_ABOVE_PX;
    const spaceBelow =
      viewportHeight -
      anchorRect.bottom -
      padding -
      ACCESS_POPOVER_OFFSET_BELOW_PX;
    // 与 accessPopover 同策略: 上方空间 ≥ 下方时放上方 ── 让卡片底
    // 边不挤 input。
    const placeAbove =
      spaceAbove >= ACCESS_POPOVER_MIN_HEIGHT_PX || spaceAbove >= spaceBelow;

    const popoverRect = this.composerRolePopover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || ACCESS_POPOVER_WIDTH_PX;
    const popoverHeight = popoverRect.height || ACCESS_POPOVER_MAX_HEIGHT_PX;

    // 水平: 按钮左对齐, 但右边不能超出 viewport。
    const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
    const left = Math.min(Math.max(anchorRect.left, padding), maxLeft);

    const offset = placeAbove
      ? ACCESS_POPOVER_OFFSET_ABOVE_PX
      : ACCESS_POPOVER_OFFSET_BELOW_PX;
    const rawTop = placeAbove
      ? anchorRect.top - offset - popoverHeight
      : anchorRect.bottom + offset;
    const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
    const top = Math.min(Math.max(rawTop, padding), maxTop);

    this.composerRolePopover.style.left = `${left}px`;
    this.composerRolePopover.style.top = `${top}px`;
  }

  private selectedAgentRoleOption(): AgentRoleOption | null {
    const memoId = this.agentRoleMemoId;
    const roleName = this.agentRoleName;
    if (!memoId && !roleName) return null;
    const entries = this.getAgentRoleOptions();
    return (
      entries.find((entry) => entry.memoId === memoId) ??
      entries.find((entry) => roleName !== null && entry.name === roleName) ??
      null
    );
  }

  // 输入框左侧 role 图标内容 ── 始终可见 (不再 hidden=true): 未设置角色
  // 时显示 UserCircleDashedIcon (虚线占位), 设置后显示 memo 文档图标。
  // 同步 aria-expanded 与 composerRolePopover 开合态 (独立 popover,
  // 不再跟随 accessPopover), 给屏幕阅读器一致反馈。
  private refreshComposerRoleIcon(): void {
    const roleName = this.agentRoleName;
    this.composerRoleIcon.replaceChildren();
    // 重置类 ── 切掉可能的 .--open / .--svg 修饰, 后面按需重新挂。
    this.composerRoleIcon.className = "agent-thread-card__composer-role-icon";
    // aria-expanded 与 composerRolePopover 同步 (独立 popover)。 --open
    // 修饰类同样同步, 让 CSS 的 hover/open 视觉态正确反映。
    this.composerRoleIcon.setAttribute(
      "aria-expanded",
      this.isComposerRolePopoverOpen ? "true" : "false",
    );
    this.composerRoleIcon.classList.toggle(
      "agent-thread-card__composer-role-icon--open",
      this.isComposerRolePopoverOpen,
    );

    if (!roleName) {
      // 未设置角色 ── 显示 Plus 图标作为 "点击新增角色" 的强引导。
      this.composerRoleIcon.append(createComposerRoleEmptyIcon());
      this.composerRoleIcon.title = this.t("editor.threadCard.roleIconTooltip");
      return;
    }

    const entry = this.selectedAgentRoleOption();
    const memoIcon = entry?.memoIcon?.trim() ?? "";
    if (
      !memoIcon &&
      this.agentRoleMemoId &&
      this.agentRoleOptions === null &&
      !this.isLoadingAgentRoleOptions
    ) {
      // 已设置角色但 options 还在加载 ── 触发异步加载。 但不在这里
      // 立刻画 fallback, 而是先让 appendRoleIconContent 走 fallback 路径:
      // 等 options 回来后会再调 refreshComposerRoleIcon, 那时 memoIcon 就
      // 能拿到了。
      this.loadAgentRoleOptions();
    }

    if (!appendRoleIconContent(this.composerRoleIcon, memoIcon, roleName)) {
      // appendRoleIconContent 返回 false ── 通常意味着 memo icon 为空
      // (entry 没有 icon)。 遵循列表的图标规则, 走首字母头像 (与
      // renderRoleOptionsList 完全同源的 getNotebookIconLetter): ASCII 取
      // 首字符大写, CJK 走 pinyin-pro 取拼音首字母。 这样"已选但无图标"
      // 的 role 与列表里"无图标"的 role 视觉一致 ── 用户在两个位置看
      // 同一个 role 是同一个头像, 不会产生认知割裂。
      this.composerRoleIcon.textContent = getNotebookIconLetter(roleName);
    }
    this.composerRoleIcon.title = roleName;
  }

  private startAccessPopoverPositionTracking(): void {
    window.addEventListener("resize", this.boundPositionAccessPopover);
    window.addEventListener("scroll", this.boundPositionAccessPopover, true);

    if ("ResizeObserver" in window) {
      this.accessPopoverResizeObserver?.disconnect();
      this.accessPopoverResizeObserver = new ResizeObserver(() => {
        this.scheduleAccessPopoverPosition();
      });
      this.accessPopoverResizeObserver.observe(this.accessButton);
      this.accessPopoverResizeObserver.observe(this.accessPopover);
    }
  }

  private stopAccessPopoverPositionTracking(): void {
    window.removeEventListener("resize", this.boundPositionAccessPopover);
    window.removeEventListener("scroll", this.boundPositionAccessPopover, true);
    this.accessPopoverResizeObserver?.disconnect();
    this.accessPopoverResizeObserver = null;
    if (this.accessPopoverPositionFrame !== null) {
      window.cancelAnimationFrame(this.accessPopoverPositionFrame);
      this.accessPopoverPositionFrame = null;
    }
  }

  private scheduleAccessPopoverPosition(): void {
    if (
      !this.isAccessPopoverOpen ||
      this.accessPopover.hidden ||
      this.isDestroyed
    )
      return;
    if (this.accessPopoverPositionFrame !== null) return;
    this.accessPopoverPositionFrame = window.requestAnimationFrame(() => {
      this.accessPopoverPositionFrame = null;
      this.positionAccessPopover();
    });
  }

  private positionAccessPopover(): void {
    if (
      !this.isAccessPopoverOpen ||
      this.accessPopover.hidden ||
      this.isDestroyed
    )
      return;
    const anchor = this.accessPopoverAnchor ?? this.accessButton;
    if (!anchor.isConnected || !this.accessPopover.isConnected) {
      this.setAccessPopoverOpen(false);
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = ACCESS_POPOVER_VIEWPORT_PADDING_PX;
    const spaceAbove =
      anchorRect.top - padding - ACCESS_POPOVER_OFFSET_ABOVE_PX;
    const spaceBelow =
      viewportHeight -
      anchorRect.bottom -
      padding -
      ACCESS_POPOVER_OFFSET_BELOW_PX;
    const placeAbove = this.accessPopoverPreferBelow
      ? spaceBelow < ACCESS_POPOVER_MIN_HEIGHT_PX && spaceAbove > spaceBelow
      : spaceAbove >= 160 || spaceAbove >= spaceBelow;
    const availableHeight = Math.max(
      ACCESS_POPOVER_MIN_HEIGHT_PX,
      Math.min(
        ACCESS_POPOVER_MAX_HEIGHT_PX,
        placeAbove ? spaceAbove : spaceBelow,
      ),
    );

    // scroll 区域就是整个弹窗的滚动区 ── notebook + folder + 末尾的"添
    // 加资料夹"按钮 都在同一个 scroll 内。 整个 scroll max-height =
    // availableHeight, 不再单独扣 footer 高度 ── 按钮跟随内容滚动,
    // 长列表下滚到底就能看到, 而不是被钉在弹窗底部固定可见。
    const scrollEl = this.accessPopover.querySelector<HTMLDivElement>(
      ".agent-thread-card__access-popover-scroll",
    );
    if (scrollEl) {
      scrollEl.style.maxHeight = `${availableHeight}px`;
    }

    const popoverRect = this.accessPopover.getBoundingClientRect();
    const popoverWidth = popoverRect.width || ACCESS_POPOVER_WIDTH_PX;
    const popoverHeight = Math.min(
      popoverRect.height || availableHeight,
      availableHeight,
    );
    const maxLeft = Math.max(padding, viewportWidth - padding - popoverWidth);
    const left = Math.min(
      Math.max(anchorRect.right - popoverWidth, padding),
      maxLeft,
    );
    const offset = placeAbove
      ? ACCESS_POPOVER_OFFSET_ABOVE_PX
      : ACCESS_POPOVER_OFFSET_BELOW_PX;
    const rawTop = placeAbove
      ? anchorRect.top - offset - popoverHeight
      : anchorRect.bottom + offset;
    const maxTop = Math.max(padding, viewportHeight - padding - popoverHeight);
    const top = Math.min(Math.max(rawTop, padding), maxTop);

    this.accessPopover.style.left = `${left}px`;
    this.accessPopover.style.top = `${top}px`;
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
    if (this.localSupportedModelsTypeKey !== typeKey) {
      this.localSupportedModels = [];
      this.loadCodexDefaultModel();
    }
    this.refreshComposerRoleIcon();
    if (
      this.oversizedInputDraftDomValue !== null &&
      this.input.value === this.oversizedInputDraftDomValue
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
    // 极窄, 任何微任务错位 (例如中间输入事件重设了 oversizedInputDraftDomValue,
    // draftSnapshot 仍是 null, 且外部 updateAttrs 在 1s 窗口内到来)
    // 都会让这条分支静默吞掉用户粘贴内容。 删掉后:
    //   - 构造器已经 `this.input.value = this.inputDraft` (line 884)
    //     处理首次挂载同步;
    //   - submit / runInitialPromptIfNeeded / setComposerHistoryValue 三处
    //     显式改写 input.value 后, 都自行更新 draftSnapshot 或 running state;
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
    this.fullscreenContainer = this.getFullscreenContainer();
    this.syncFullscreenBounds();
    this.observeFullscreenContainer();
    window.addEventListener("resize", this.boundSyncFullscreenBounds);
    window.addEventListener("keydown", this.boundHandleFullscreenKeydown, true);
    window.requestAnimationFrame(() => this.syncFullscreenBounds());
  }

  private exitFullscreenMode(): void {
    this.fullscreenResizeObserver?.disconnect();
    this.fullscreenResizeObserver = null;
    this.fullscreenContainer = null;
    window.removeEventListener("resize", this.boundSyncFullscreenBounds);
    window.removeEventListener(
      "keydown",
      this.boundHandleFullscreenKeydown,
      true,
    );
    this.clearFullscreenBounds();
    this.restoreFullscreenReturnAnchor();
  }

  private observeFullscreenContainer(): void {
    this.fullscreenResizeObserver?.disconnect();
    if (!this.fullscreenContainer || !("ResizeObserver" in window)) return;

    this.fullscreenResizeObserver = new ResizeObserver(() => {
      this.syncFullscreenBounds();
    });
    this.fullscreenResizeObserver.observe(this.fullscreenContainer);
  }

  private syncFullscreenBounds(): void {
    if (!this.isFullscreen) return;
    const container = this.fullscreenContainer ?? this.getFullscreenContainer();
    if (!container) return;
    this.fullscreenContainer = container;
    syncAgentThreadCardFullscreenBounds({
      dom: this.dom,
      container,
      titlebarHeight: isWindowsPlatform() ? WINDOWS_TITLEBAR_HEIGHT_PX : 0,
    });
    this.scheduleAccessPopoverPosition();
  }

  private getFullscreenContainer(): HTMLElement | null {
    return getAgentThreadCardFullscreenContainer(this.dom);
  }

  private getEditorScrollContainer(): HTMLElement | null {
    return getAgentThreadCardEditorScrollContainer(this.dom);
  }

  private captureScrollSnapshot(): ScrollSnapshot {
    return captureAgentThreadCardScrollSnapshot(
      this.getEditorScrollContainer(),
    );
  }

  private restoreScrollSnapshotAfterFocusChange(snapshot: ScrollSnapshot): void {
    restoreAgentThreadCardScrollSnapshotAfterFocusChange(snapshot);
  }

  private ownsNode(target: globalThis.Node | null): boolean {
    return !!(
      target &&
      (this.dom.contains(target) ||
        this.accessPopover.contains(target) ||
        this.codexSettingsPopover.contains(target) ||
        this.composerRolePopover.contains(target))
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
    const scrollContainer = this.getEditorScrollContainer();
    if (!scrollContainer) {
      this.fullscreenReturnAnchor = null;
      return;
    }

    const cardRect = this.dom.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    this.fullscreenReturnAnchor = {
      scrollContainer,
      topWithinContainer: cardRect.top - containerRect.top,
    };
  }

  private restoreFullscreenReturnAnchor(): void {
    const anchor = this.fullscreenReturnAnchor;
    this.fullscreenReturnAnchor = null;

    window.requestAnimationFrame(() => {
      if (this.isDestroyed || this.isFullscreen) return;
      if (
        !anchor ||
        !anchor.scrollContainer.isConnected ||
        !this.dom.isConnected
      ) {
        this.scrollCardToExitFallbackPosition();
        return;
      }

      const containerRect = anchor.scrollContainer.getBoundingClientRect();
      const cardRect = this.dom.getBoundingClientRect();
      this.adjustEditorScrollToCardTop(
        anchor.scrollContainer,
        cardRect.top - containerRect.top,
        anchor.topWithinContainer,
      );
    });
  }

  private scrollCardToExitFallbackPosition(): void {
    const scrollContainer = this.getEditorScrollContainer();
    if (
      !scrollContainer ||
      !scrollContainer.isConnected ||
      !this.dom.isConnected
    )
      return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const cardRect = this.dom.getBoundingClientRect();
    const targetTop = getFullscreenExitFallbackTop({
      containerHeight: containerRect.height,
      minTopPx: FULLSCREEN_EXIT_FALLBACK_MIN_TOP_PX,
      maxTopPx: FULLSCREEN_EXIT_FALLBACK_MAX_TOP_PX,
      topRatio: FULLSCREEN_EXIT_FALLBACK_TOP_RATIO,
    });
    this.adjustEditorScrollToCardTop(
      scrollContainer,
      cardRect.top - containerRect.top,
      targetTop,
    );
  }

  private adjustEditorScrollToCardTop(
    scrollContainer: HTMLElement,
    currentTopWithinContainer: number,
    targetTopWithinContainer: number,
  ): void {
    adjustEditorScrollToCardTopByDelta({
      scrollContainer,
      currentTopWithinContainer,
      targetTopWithinContainer,
      epsilonPx: SCROLL_DELTA_EPSILON_PX,
    });
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

  private clearFullscreenBounds(): void {
    clearAgentThreadCardFullscreenBounds(this.dom);
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

  private getRenderedAgentMessages(
    messages: ThreadState["messages"],
  ): ThreadState["messages"] {
    return selectRenderedAgentMessages(messages);
  }

  private tryPatchLastRenderedMessage(
    messages: ThreadState["messages"],
    options: {
      isLoading: boolean;
      previousScrollTop: number;
      shouldFollowStreaming: boolean;
    },
  ): boolean {
    const list = this.renderedMessagesList;
    if (!list || !this.body.contains(list)) return false;

    const renderedMessages = this.getRenderedAgentMessages(messages);
    if (
      renderedMessages.length === 0 ||
      renderedMessages.length !== this.renderedMessageRefs.length ||
      list.children.length !== renderedMessages.length
    ) {
      return false;
    }

    for (let i = 0; i < renderedMessages.length - 1; i += 1) {
      if (renderedMessages[i] !== this.renderedMessageRefs[i]) return false;
    }

    const previousLast = this.renderedMessageRefs[renderedMessages.length - 1];
    const nextLast = renderedMessages[renderedMessages.length - 1];
    if (
      previousLast === nextLast ||
      previousLast.id !== nextLast.id ||
      previousLast.role !== nextLast.role
    ) {
      return false;
    }

    const item = list.lastElementChild as HTMLDivElement | null;
    if (!item) return false;

    const messageView = createAgentMessageViewModel(nextLast, this.language);
    if (nextLast.role === "assistant" || nextLast.role === "user") {
      const content = item.querySelector<HTMLElement>(
        ".agent-thread-card__message-content",
      );
      if (!content) return false;
      fillWithMarkdownHtml(
        content,
        renderMarkdownToHtml(messageView.visibleContent),
      );
    } else if (nextLast.role === "reasoning") {
      const label = item.querySelector<HTMLSpanElement>(
        ".agent-thread-card__message-reasoning-header span",
      );
      const content = item.querySelector<HTMLElement>(
        ".agent-thread-card__message-content",
      );
      if (!label || !content) return false;
      label.textContent = messageView.reasoningLabel;
      item.classList.toggle(
        "agent-thread-card__message--reasoning-collapsed",
        this.getReasoningCollapsed(nextLast),
      );
      fillWithMarkdownHtml(
        content,
        renderMarkdownToHtml(messageView.visibleContent),
      );
    } else if (nextLast.role === "end") {
      const content = item.querySelector<HTMLElement>(
        ".agent-thread-card__message-content",
      );
      if (!content) return false;
      content.textContent = messageView.visibleContent;
    } else {
      return false;
    }

    this.renderedMessageRefs = [
      ...this.renderedMessageRefs.slice(0, -1),
      nextLast,
    ];
    this.applyBodyScrollAfterRender(options);
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
    const oldRefs = this.renderedMessageRefs;
    const list = this.renderedMessagesList;

    // 1) 第一条消息 (oldRefs 为空) 走不到这里 ── `renderedMessagesList`
    //    与 `renderedMessageRefs` 同步初始化, oldRefs 为空时 list 必为 null,
    //    下面的 list 检查会一并兜住。 此处显式早返, 让"from empty" 落到
    //    全量重建里走 empty / loading 的可见分支。
    if (oldRefs.length === 0) return false;
    if (!list || !this.body.contains(list)) return false;

    const newRendered = this.getRenderedAgentMessages(messages);

    // 2) 必须有可追加内容 (严格更长)。
    if (newRendered.length <= oldRefs.length) return false;
    // 3) DOM 节点数必须与旧 refs 一致 ── 不一致说明 DOM 状态已经漂移
    //    (可能其它路径改过 body), 不能在此基础上 append, 必须全量重建。
    if (list.children.length !== oldRefs.length) return false;

    // 4) 前缀逐项引用相等 ── 任一不等说明中间或头部有变化 (例如
    //    session_resolved 的 mergeHistoricalMessages、loadMoreMessages
    //    的 prepend), 这些场景只能全量重建。
    for (let i = 0; i < oldRefs.length; i += 1) {
      if (newRendered[i] !== oldRefs[i]) return false;
    }

    const appended = newRendered.slice(oldRefs.length);
    let appendedCount = 0;
    for (const message of appended) {
      const rendered = createAgentThreadCardMessageElement({
        message,
        language: this.language,
        getReasoningCollapsed: (nextMessage) =>
          this.getReasoningCollapsed(nextMessage),
        setReasoningCollapsed: (messageId, collapsed) => {
          this.reasoningCollapsedOverrides.set(messageId, collapsed);
        },
      });
      if (!rendered) continue;
      list.append(rendered.element);
      appendedCount += 1;
    }
    // 全部 appended 都返 null (被 filter 跳过的尾部), 不能前进 refs ──
    // 否则 refs 与 DOM 节点数会脱钩, 后续 tryPatchLastRenderedMessage 的
    // `list.children.length !== renderedMessages.length` 校验会持续返
    // false, 形成隐性死循环。 一并回退全量重建。
    if (appendedCount === 0) return false;

    // 完整地替换 refs ── 即使 factory 跳过了部分元素 (上面 counted by
    // appendedCount, 与 renderedMessageRefs 走"filter 后集合"的语义不同)。
    // renderedMessageRefs 是 filter 后集合, 与 `newRendered` 同长 ──
    // `list.children.length` 不一定等于 newRendered.length, 因为跳过
    // 的消息不产生 DOM 节点。 这是已有 `tryPatchLastRenderedMessage`
    // 已经接受的同一不变量。
    this.renderedMessageRefs = newRendered;
    this.applyBodyScrollAfterRender(options);
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

    const list = document.createElement("div");
    list.className = "agent-thread-card__messages";
    const renderedMessages: ThreadState["messages"] = [];

    for (const message of visibleMessages) {
      const rendered = createAgentThreadCardMessageElement({
        message,
        language: this.language,
        getReasoningCollapsed: (nextMessage) =>
          this.getReasoningCollapsed(nextMessage),
        setReasoningCollapsed: (messageId, collapsed) => {
          this.reasoningCollapsedOverrides.set(messageId, collapsed);
        },
      });
      if (!rendered) continue;
      if (rendered.shouldRemember) renderedMessages.push(message);
      list.append(rendered.element);
    }

    this.body.append(list, this.loadingIndicator);
    this.rememberRenderedMessages(list, renderedMessages);
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
    // 同时把 draftSnapshot 清掉 (若之前有未触发的 debounce), 防止空 input
    // 被旧 snapshot 误保护。
    this.draftSnapshot = null;
    if (this.draftPersistTimer !== null) {
      clearTimeout(this.draftPersistTimer);
      this.draftPersistTimer = null;
    }
    this.updateAttrs({ inputDraft: null });
    this.updateMultiLineState();
    this.setError(null);
    this.renderThreadState();

    let nextThreadId = this.threadId;
    let nextInstanceId = this.instanceId;
    let nextTitle = this.title || buildTitle(rawPrompt, this.t("editor.threadCard.title"));
    const source = getCurrentThreadCardSource();
    try {
      if (!nextThreadId) {
        this.isCreating = true;
        this.renderThreadState();
        const ensured = await ensureAgentThreadCardThread({
          prompt: rawPrompt,
          fallbackTitle: this.t("editor.threadCard.title"),
          typeKey: this.typeKey,
          currentThreadId: this.threadId,
          runtimeHandleId: this.runtimeHandleId,
          buildTitle,
        });
        if (ensured) {
          nextThreadId = ensured.threadId;
          nextTitle = ensured.title;
          if (!nextInstanceId) {
            const instance = useAgentConversationStore
              .getState()
              .createInstance({
                agentType: ensured.typeKey,
                title: ensured.title,
                threadId: ensured.threadId,
                source,
                role: {
                  memoId: this.agentRoleMemoId,
                  name: this.agentRoleName,
                },
              });
            nextInstanceId = instance.instanceId;
          } else {
            useAgentConversationStore.getState().updateThread(nextInstanceId, {
              agentType: ensured.typeKey,
              threadId: ensured.threadId,
            });
          }
        }
      }

      if (!nextThreadId) {
        throw new Error("Agent thread id was not created");
      }
      const conversation = upsertAgentThreadCardConversationInstance({
        instanceId: nextInstanceId,
        agentType: this.typeKey,
        title: nextTitle,
        threadId: nextThreadId,
        source,
        role: {
          memoId: this.agentRoleMemoId,
          name: this.agentRoleName,
        },
      });
      nextInstanceId = conversation.instanceId;
      // Agent Role 文档: 首条消息时, 把 role memo body 拼到 user 消息
      // 末尾 ── 与 currentNote / flowix CLI 块同源 inline 拼接。 拉
      // body 失败 / 文档已删时返回 null, chat-store 静默跳过, 不污染
      // user 消息。 缓存命中 (同 memo 重复发) 走 0 IPC 路径。
      const isFirstMessage = this.currentMessages().length === 0;
      const roleMemoId = this.agentRoleMemoId;
      const roleBody =
        isFirstMessage && roleMemoId
          ? await this.loadAgentRoleBody(roleMemoId)
          : null;
      const sendPromise = useChatStore
        .getState()
        .sendMessageToThread(nextThreadId, rawPrompt, this.typeKey, {
          instanceId: nextInstanceId ?? undefined,
          conversationTitle: nextTitle,
          currentNoteContent: documentContext,
          agentRoleMemoId: this.agentRoleMemoId ?? undefined,
          agentRoleName: this.agentRoleName ?? undefined,
          isFirstMessage,
          agentRoleBody: roleBody,
        });
      // Persist the card binding only after the optimistic user message has
      // entered the store. Otherwise the node attr update schedules history
      // cache loading while the message list is still empty, producing a
      // visible delay before the just-sent message appears.
      this.updateAttrs({
        instanceId: nextInstanceId,
        threadId: nextThreadId,
        typeKey: this.typeKey,
      });
      await sendPromise;
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
    // composerRolePopover 关闭放在 isDestroyed 置位之前 ── 它内部的
    // scheduleComposerRolePopoverPosition 会检查 isDestroyed 提前返,
    // 必须先把弹窗关掉再置标志。 setComposerRolePopoverOpen 本身不
    // 依赖 isDestroyed, 但其后续清理路径 (RemoveEventListener /
    // ResizeObserver disconnect) 需要弹窗 open 状态, 否则 idempotent
    // 早返会跳过清理。
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
    // accessPopover 不再嵌套 typeSettingsPopover ── accessPopover 自己
    // 独立 remove 即可。typeSettingsPopover 字段已删除, 不需要清理。
    this.accessPopover.remove();
    this.codexSettingsPopoverResizeObserver?.disconnect();
    this.codexSettingsPopoverResizeObserver = null;
    if (this.codexSettingsPopoverPositionFrame !== null) {
      window.cancelAnimationFrame(this.codexSettingsPopoverPositionFrame);
      this.codexSettingsPopoverPositionFrame = null;
    }
    document.removeEventListener(
      "pointerdown",
      this.boundHandleCodexSettingsOutsidePointer,
      true,
    );
    this.codexSettingsPopover.remove();
    // composerRolePopover 是独立挂在 document.body 的弹窗, 跟 accessPopover
    // 互不嵌套, 需要单独 remove。 setComposerRolePopoverOpen(false) 已经在
    // destroy 顶部调用过, 这里再 cleanup 一次 ResizeObserver / position
    // frame / document listener, 保证视图销毁后没有 ghost callback。
    this.composerRolePopoverController?.dispose();
    this.composerRolePopoverController = null;
    document.removeEventListener(
      "pointerdown",
      this.boundHandleComposerRoleOutsidePointer,
      true,
    );
    this.composerRolePopover.remove();
  }
}
