import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { Marked } from 'marked';
import { agent } from '@platform/tauri/client';
import { useChatStore, type ThreadState } from '@features/agent/store/chat-store';
import type { AgentRoleKey } from '@/types/agent';
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from '@features/agent/message';
import { getToolIconPath } from '@features/agent/message/tools';
import { openNoteByDeepLink } from '@platform/open-target';
import { isWindowsPlatform } from '@features/shortcuts';
import { DEFAULT_AGENT_ROLE_KEY, getAgentRole, normalizeAgentRoleKey } from '@/lib/agent-roles';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    agentThreadCard: {
      insertAgentThreadCard: (options?: {
        roleKey?: AgentRoleKey;
        replaceRange?: { from: number; to: number };
        initialPrompt?: string;
        autoSubmit?: boolean;
      }) => ReturnType;
    };
  }
}

const DEFAULT_TITLE = 'AI 对话';

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

// Phosphor 路径内联 ── NodeView 是纯 DOM，不引入 React 渲染 Phosphor 组件。
// 路径取自 @phosphor-icons/react v2.1.x (regular / fill)，viewBox 均为 256x256。
//
// 当前仅保留 stop 路径 (Phosphor 风格 fill); send 图标改用 lucide
// ArrowRight, 见下方 createSendIcon 内部。统一用 lucide 而非"一半
// Phosphor 一半 lucide"的理由: 视觉重量级 (stroke 2 / 24×24 vs fill
// 256×256) 不一致会让 send/stop 切换时图标跳一下 ── stop 是 fill,
// send 是 stroke, 在箭头这种极简图形上 stroke 与 fill 的视觉量级相近,
// 切换不会突兀。Phosphor 飞机图 (有三角面) 与 stop 矩形 (有方角) 切换
// 反而量级更不统一, 这是一并换掉的副作用。
const ICON_STOP_PATH = 'M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z';
// Chevron 图标 (lucide 风格, 24×24 viewBox, stroke 2) ── 与项目其它折叠
// 触发器视觉同源 (select / chat-history / message-reasoning / search-replace
// 全部走 lucide ChevronDown strokeWidth 2.5)。换成 chevron 之前用的是
// Phosphor 风格的实心 caret 路径 (V 形闭口) ── 那其实视觉上已经是 V,
// 但"实心填充"在 14×14 渲染下比 lucide 的细线 stroke 更"重", 与项目
// 其它 chevron 不在一个视觉重量级。改 stroke 后视觉重量与 lucide 一致。
//
// 折叠态视觉: card 折叠按钮靠 CSS transform: rotate(180deg) 把 chevron-down
// 翻成 chevron-up (省一份 path, 单节点旋转走 GPU); reasoning 消息折叠头
// 没有"父级 rotate"可以利用, 直接挂对应方向 path。
const ICON_CHEVRON_UP_PATH = 'M6 15l6-6 6 6';
const ICON_CHEVRON_DOWN_PATH = 'M6 9l6 6 6-6';
// 复制图标 ── 用于 metaEl 位的"复制 ThreadId"按钮。
// 与代码块 .code-block-copy-btn 同源: lucide Copy 风格 (24×24 viewBox,
// fill=none + stroke=currentColor + stroke-width=2 + round linecap/linejoin),
// 渲染 14×14。复制成功时换成对勾 (lucide Check) + .copied 类触发绿色 ──
// 与代码块 .code-block-copy-btn.copied 的成功反馈一致。
const ICON_COPY_PATH = 'M9 9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1';
const ICON_CHECK_PATH = 'M20 6 9 17 4 12';
const ICON_TRASH_PATH = 'M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z';
const ICON_FULLSCREEN_PATH = 'M40,96a8,8,0,0,1-8-8V48A16,16,0,0,1,48,32H88a8,8,0,0,1,0,16H48V88A8,8,0,0,1,40,96ZM208,32H168a8,8,0,0,0,0,16h40V88a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32ZM88,208H48V168a8,8,0,0,0-16,0v40a16,16,0,0,0,16,16H88a8,8,0,0,0,0-16Zm128-48a8,8,0,0,0-8,8v40H168a8,8,0,0,0,0,16h40a16,16,0,0,0,16-16V168A8,8,0,0,0,216,160Z';
const ICON_FULLSCREEN_EXIT_PATH = 'M96,40V80A16,16,0,0,1,80,96H40a8,8,0,0,1,0-16H80V40a8,8,0,0,1,16,0Zm120,40H176V40a8,8,0,0,0-16,0V80a16,16,0,0,0,16,16h40a8,8,0,0,0,0-16ZM80,176v40a8,8,0,0,0,16,0V176a16,16,0,0,0-16-16H40a8,8,0,0,0,0,16Zm136-16H176a16,16,0,0,0-16,16v40a8,8,0,0,0,16,0V176h40a8,8,0,0,0,0-16Z';
// 工具消息图标 ── 走 @features/agent/message/tools 的单源 registry。
// 卡片是纯 DOM (Tiptap NodeView), 用 SVG path 字符串 (与 panel inline
// SVG 共享同一份 data, 视觉完全一致)。getToolIconPath 已带 Terminal fallback。

// 发送 / 停止图标 ── send 走 lucide ArrowRight (stroke 风格), stop
// 走 Phosphor 矩形 (fill 风格)。两种渲染风格在按钮上'看'起来重量
// 相近 ── 见上方 ICON_STOP_PATH 注释。视图尺寸由 CSS 决定
// (.agent-thread-card__send-icon, 15×15): 卡片按钮 28×28, 主面板按钮
// 32×32 (h-8 w-8), 不强求两处图标同绝对尺寸; 卡片图标按按钮 28/32 比例
// 取 15px, 主面板走 h-5 w-5 (20px) ── 两处图标占按钮的视觉密度一致
// (主面板 ~62%, 卡片 ~54%)。
function createSendIcon(kind: 'send' | 'stop'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__send-icon');

  if (kind === 'stop') {
    svg.setAttribute('viewBox', '0 0 256 256');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_STOP_PATH);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  // send: lucide ArrowRight ── 与主面板 agent-inputbox 的 <ArrowRight>
  // 完全同源, 路径取自 lucide-react v0.x 的 ArrowRight.tsx (MIT)。
  // 24×24 viewBox + stroke=2 + round linecap/linejoin + fill=none, 与
  // createChevronIcon / createCopyIcon / createCheckIcon 的渲染约定一致。
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // 主轴 ── 水平线段, x: 5 → 19, y: 12
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', 'M5 12h14');
  svg.append(line);
  // 箭头 ── 折线, 从 (12,5) 折到 (19,12) 再折到 (12,19)
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'm12 5 7 7-7 7');
  svg.append(arrow);
  return svg;
}

function createChevronIcon(direction: 'up' | 'down'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__chevron-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', direction === 'up' ? ICON_CHEVRON_UP_PATH : ICON_CHEVRON_DOWN_PATH);
  // lucide 风格 stroke 渲染: fill=none + stroke=currentColor + stroke-width=2
  // + linecap/linejoin=round ── 24×24 viewBox 在 14×14 渲染下, stroke 2
  // 等比约 1.17px, 与项目其它 chevron 的 strokeWidth={2.5} 视觉量级一致
  // (略细, 但 round linecap 让端点圆润, 整体观感不锐)。
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// 头部左侧 Agent 角色图标 ── 通过 getAgentRole(roleKey).icon 读取
// agent-roles.ts 里集中管理的图片资源 (Vite import 解析后的 URL)。
// 用 <img> 而非内联 SVG, 因为角色图标是 PNG / 外部 SVG, 不需要走
// 256×256 phosphor 路径体系。CSS 控制 14×14 渲染尺寸。
function createCopyIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__copy-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_COPY_PATH);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function createCheckIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__copy-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_CHECK_PATH);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function createTrashIcon(): SVGSVGElement {
  // Phosphor 风格 fill 渲染, 256x256 viewBox + fill=currentColor ──
  // 与 createSendIcon 完全同形, 视觉量级一致。
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__trash-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_TRASH_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function createFullscreenIcon(kind: 'enter' | 'exit'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__fullscreen-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'exit' ? ICON_FULLSCREEN_EXIT_PATH : ICON_FULLSCREEN_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function createToolIcon(toolName?: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__message-tool-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', getToolIconPath(toolName));
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function buildTitle(prompt: string): string {
  const title = prompt.replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 28) : DEFAULT_TITLE;
}

function escapeAttr(value: string | null | undefined): string {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeAttr(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseCardAttrs(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /(\w+)="((?:\\"|\\\\|[^"])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(rawAttrs))) {
    attrs[match[1]] = unescapeAttr(match[2]);
  }

  return attrs;
}

function focusAgentThreadCardInput(view: EditorView, pos: number): void {
  requestAnimationFrame(() => {
    if (view.isDestroyed) return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;

    const input = dom.querySelector('textarea');
    if (!(input instanceof HTMLTextAreaElement) || input.disabled) return;

    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

// 工具摘要: 解析" ```lang\ncode\n``` "围栏 / 行内 `code` / 优先取 language-x
// 类, 把 fenced code 渲染成与面板等效的 <pre><code class="lang-x">。
// marked 17 默认开启 GFM, 不用再注册 remark-gfm。
//
// 安全性: marked.parse() 直接走 HTML 输出, 对不可信输入要先 sanitize。
// 当前 ChatMessage.content 来源是后端 rllm agent 输出 (受控), 但仍
// 走一道最小过滤 ── 移除 <script> / on* 属性 / javascript: href,
// 过滤 <system>...</system> 块 ── 卡片场景下, '全文档上下文' 以 <system>
// 标签包裹后追加到 user 消息 content 尾部, 渲染时必须剥掉这部分, 否则
// 用户会看到自己的笔记全文跟着 user 气泡出现。
// 匹配策略: 非贪婪 .*? 允许多个 system 块并列 / 块内多行; 走 [\s\S] 兼容
// 跨行内容。系统块可能出现在 content 任何位置 ── 一般是尾部追加, 但用户
// 也可能手动编辑 markdown 把 system 块放在中间, 仍应统一剥掉。
// 提取编辑器全文档作为'技能'上下文 ── ProseMirror doc 遍历, 跳过
// agentThreadCard 节点 (避免把卡片自身的内容 / metadata 当成笔记内容
// 喂给 LLM, 也避免 LLM 看到自己的 prompt 历史造成循环)。
//
// 实现要点:
//   - 用 view.state.doc.descendants 递归遍历, 在 callback 里
//     跳过 type.name === 'agentThreadCard' 的节点 (返回 false 不下钻)
//   - 收集每个 block 节点的 textContent, 用 '\n\n' 拼成 markdown-like 文本
//   - 保留原始块结构, 文本顺序与编辑器视觉顺序一致
//   - 空文档 / 全部是 card 的文档返回空字符串, 提交时跳过 system 块
//
// 简化: 不区分 heading / paragraph / list 等 markdown 语义, 全部按
// textContent 拼接 ── LLM 拿到的是'纯文本 + 双换行分块', 足够作为
// '当前笔记的技能/上下文'使用。markdown 完美序列化需要走 Tiptap 的
// renderMarkdown, 但那会把 agent card 也序列化 (前面讨论过), 改起来
// 工作量不成比例; 当前实现是 LLM 友好 + 维护简单的折中。
function extractDocumentContext(view: EditorView | undefined): string {
  if (!view) return '';
  const blocks: string[] = [];
  view.state.doc.descendants((node) => {
    if (node.type.name === 'agentThreadCard') {
      // 不下钻 card 子树, 直接跳过整张卡片
      return false;
    }
    if (node.isBlock && node.textContent.trim()) {
      blocks.push(node.textContent.trim());
    }
    return true;
  });
  return blocks.join('\n\n');
}

// 把上下文包成 <system>...</system> ── 与 stripSystemBlock 的正则配对。
// 内容中已有的 '<' / '>' 不需要再转义, 因为 stripSystemBlock 只在渲染层
// 剥这段, 不会与 markdown 解析互相干扰 (marked 不会把 <system> 当标签,
// 因为它不在 GFM 标签白名单里, 会被原样转义为 &lt;system&gt; ── 这正是
// 我们要的: 不被 marked 当作 HTML 标签处理)。
function buildSystemBlock(documentContext: string): string {
  if (!documentContext) return '';
  return `<system>\n${documentContext}\n</system>`;
}

// 用独立 `Marked` 实例渲染卡片正文 ── 全局 `marked` 单例被 `@tiptap/markdown`
// 通过 `marked.use({ extensions: [...] })` 注入了一批自定义 tokenizer
// (noteReference / frontmatter / image-attachment / video-attachment /
//  file-attachment / agentThreadCard 自身), 但都只挂了 tokenizer 没挂 renderer
// (见 node_modules/@tiptap/markdown/dist/index.js 的 registerTokenizer)。 走
// `marked.parse()` 进入 Parser default 分支就会抛
//   `Token with "<name>" type was not found.`
// 同样的坑 `lib/export.ts` 早处理过 ── 此处复刻同一套隔离方案。
const cardMarked = new Marked({
  async: false,
  gfm: true,
  breaks: true,
});

function renderMarkdownToHtml(content: string): string {
  if (!content || !content.trim()) return '';
  const raw = cardMarked.parse(content) as string;
  return sanitizeMarkdownHtml(raw);
}

// 轻量 HTML 清洗: 卡片场景下不需要完整 DOMPurify, 我们关心的是
// 1) <script> 直接剥除; 2) on* 事件属性全剥; 3) href="javascript:"
//    改空 ── 这三项覆盖 XSS 的最常见路径。CSS 样式内联 (style="...")
//    在 marked 17 默认输出里就极罕见, 暂不处理。
function sanitizeMarkdownHtml(html: string): string {
  if (!html) return '';
  // 1. 整段剥 <script>...</script> 与 <style>...</style>。
  let safe = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  // 2. on* 事件属性: onload / onclick / onerror / onmouseover 等。
  safe = safe.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // 3. javascript: / data:text/html 协议。
  safe = safe.replace(
    /(\bhref|\bsrc)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi,
    '$1="#"'
  );
  return safe;
}

// 把 sanitized HTML 字符串挂到目标元素 ── NodeView 不能用 innerHTML
// 直接覆盖外层 DOM (会破坏 ProseMirror 引用), 所以只对新建的子元素用
// innerHTML, 而容器本身用 appendChild。容器挂在父元素, 不在 ProseMirror
// 编辑范围内, 内部 HTML 写入不会触发 ProseMirror transaction。
function fillWithMarkdownHtml(container: HTMLElement, html: string): void {
  container.replaceChildren();
  if (!html) {
    return;
  }
  // template 解析一次, 减少直接 innerHTML 注入引起的 XSS 攻击面 ── 浏览器
  // 在 template 解析时不会执行 script; 仍保留 sanitize 步骤作为主防线。
  const template = document.createElement('template');
  template.innerHTML = html;
  container.append(template.content.cloneNode(true));
}

// 工具摘要: 解析" ```lang\ncode\n``` "围栏 / 行内 `code` / 优先取 language-x
// 类, 把 fenced code 渲染成与面板等效的 <pre><code class="lang-x">。
// marked 17 默认开启 GFM, 不用再注册 remark-gfm。

class AgentThreadCardView implements ProseMirrorNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;

  private node: ProseMirrorNode;
  private view: EditorView;
  private getPos: (() => number | undefined) | undefined;
  private input: HTMLTextAreaElement;
  private sendButton: HTMLButtonElement;
  private body: HTMLElement;
  private composer: HTMLElement;
  private container: HTMLDivElement;
  private titleEl: HTMLElement;
  // Agent 角色徽章 ── span (icon | role.name), 1.3rem 高, 1px 描边。
  // 详情与样式见 css/editor-agent-thread-card.css (.agent-role-badge 块,
  // 位于文件顶部、未加 .markdown-editor 限定)。这里三件套 (badge / icon / name)
  // 在构造器一次性创建并挂到 agentWrap, refreshAttrs 时只更新 src / alt /
  // textContent, 不重建 DOM (避免重渲染期间图标 src 短暂为空造成闪烁)。
  private badgeEl: HTMLSpanElement;
  private badgeIcon: HTMLImageElement;
  private badgeName: HTMLSpanElement;
  private metaEl: HTMLElement;
  private errorEl: HTMLElement;
  // 消息区底部 loading 指示器 ── 24px 固定高度, 始终挂在 body 末尾。
  // 容器永远在 DOM 里 (保证 24px 空间不被流式更新挤掉), 内部的文字
  // "思考中" 仅在 isLoading 为 true 时显示 ── 与面板 agent-thinking-indicator
  // 的"跳动圆点 + 文字"视觉同源, 让卡片与右侧 Agent 面板的"AI 在跑"
  // 反馈保持一致。
  private loadingIndicator: HTMLDivElement;
  private collapseButton: HTMLButtonElement;
  private deleteButton: HTMLButtonElement;
  private fullscreenButton: HTMLButtonElement;
  // 全屏 / 删除按钮之间的竖向分割线 ── 非交互元素, aria-hidden 让屏幕
  // 阅读器跳过; 视觉与按钮同高 (28px), 1px var(--border) 着色。
  // 可见性与 fullscreenButton 同步 (renderFullscreenState 一起切 hidden) ──
  // fullscreen 隐藏时分割线也不显示, 避免出现"分割线悬空"的视觉断层。
  private actionsDivider: HTMLSpanElement;
  private copyThreadIdButton: HTMLButtonElement;
  private unsubscribe?: () => void;
  private isCreating = false;
  private isLoadingThreadCache = false;
  private loadedThreadCacheFor: string | null = null;
  private loadingThreadCacheFor: string | null = null;
  private loadThreadCacheTimeout: ReturnType<typeof setTimeout> | null = null;
  private loadThreadCacheIdleId: number | null = null;
  private resolvingCodexSessionFor: string | null = null;
  private isDestroyed = false;
  private isFullscreen = false;
  private fullscreenContainer: HTMLElement | null = null;
  private fullscreenResizeObserver: ResizeObserver | null = null;
  // 上一帧折叠态, 仅用于识别'折叠→展开'瞬时事件触发置顶。
  private prevCollapsed: boolean = false;
  private shouldFollowBottom = true;
  private boundHandleBodyScroll = (): void => {
    this.shouldFollowBottom = this.isBodyNearBottom();
  };
  private boundSyncFullscreenBounds = (): void => {
    this.syncFullscreenBounds();
  };
  private boundHandleFullscreenKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isFullscreen) {
      event.stopPropagation();
      this.setFullscreen(false);
    }
  };

  constructor(node: ProseMirrorNode, view: EditorView, getPos?: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('section');
    this.dom.className = 'agent-thread-card';
    this.dom.contentEditable = 'false';
    this.dom.dataset.agentThreadCard = 'true';

    // 内容容器 ── 卡片所有交互子元素 (header / body / error / composer) 都
    // 挂在 container 内, 由 container 负责 grid 布局 + max-height +
    // border (卡片根只承担背景色 + 圆角 + overflow 裁剪兜底, 不参与
    // 布局)。这层独立出来便于以后做"背景与内容分离"的样式调整 ──
    // 比如让根用图片背景, 内容层透传, 或者未来加 background-filter。
    this.container = document.createElement('div');
    this.container.className = 'agent-thread-card__container';

    // 拦截 native selection 起手 ── 与 note-link/view-note.ts 卡片同源思路, 但
    // 用 document 捕获阶段 + this.dom.contains 二次过滤, 比挂 this.dom
    // 自身稳: 卡片内任何 descendant 节点起手都会被先一步拦下。
    //
    // 放行: textarea (composer 输入) / a (深链可拖选) / 消息文本
    // (用户拖拽选 AI 回复) ── 其余节点 (header 文字、按钮间空白、
    // 折叠态空 body) 一律不参与 native 文本选区。

    const header = document.createElement('div');
    header.className = 'agent-thread-card__header';

    const agentWrap = document.createElement('div');
    agentWrap.className = 'agent-thread-card__agent';

    // 头部左侧: Agent 角色徽章 (icon + role.name) + 对话标题。
    // 徽章是通用 .agent-role-badge span ── 左 icon 右非加粗 role 名,
    // 总高 1.3rem, 1px var(--border) 描边。图标 src 从 agent-roles.ts 集中
    // 管理 (Vite import 解析后的图片 URL), 按 roleKey 动态读取 ── 与
    // Agent 面板的 Runtime Switcher 同源。
    //
    // 角色名从 title 移到 badge 里: badge 显式表达'当前 role', title 只
    // 承担对话标题 ── 避免'Flowix · Flowix · 我的对话'这种视觉重复。
    // 多 Agent 视觉区分配色方案在 chat-store 侧 message role 上做, 这里
    // 视觉区分通过 badge 自身 (role 图标 + name) 已经足够。
    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'agent-role-badge';

    this.badgeIcon = document.createElement('img');
    this.badgeIcon.className = 'agent-role-badge__icon';
    this.badgeIcon.draggable = false;
    this.badgeIcon.alt = '';

    this.badgeName = document.createElement('span');
    this.badgeName.className = 'agent-role-badge__name';

    this.badgeEl.append(this.badgeIcon, this.badgeName);

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'agent-thread-card__title';

    agentWrap.append(this.badgeEl, this.titleEl);

    this.metaEl = document.createElement('div');
    this.metaEl.className = 'agent-thread-card__meta';

    // "复制 ThreadId" 按钮 ── 占据原消息条数位置 (metaEl 内)。
    // loading 时 metaEl 显示"运行中"文字, 这个按钮会被 textContent 替换掉;
    // 非 loading 时 metaEl 显示这个按钮。按钮本身始终存在 (构造器一次性
    // 创建), 仅在 DOM 树中的挂载位置随 loading 状态切换 ── 避免每次
    // renderThreadState 都重建 DOM 节点 (SVG 路径 + 事件监听器)。
    //
    // 点击行为: 把 this.threadId 写入剪贴板。视觉与代码块 .code-block-copy-btn
    // 完全同源 ── lucide Copy 图标 (24×24 viewBox / fill=none / stroke /
    // stroke-width=2 / round linecap/linejoin), 14×14 渲染; 复制成功时
    // 切到对勾 + .copied 类触发绿色反馈, 2000ms 后还原, 与代码块
    // .code-block-copy-btn.showCopySuccess 的成功反馈一致。
    //
    // 事件传播: stopPropagation 阻止 click 冒泡, 避免与卡片根 mousedown 默认行为互相干扰 ──
    // 与 collapseButton 的处理一致。
    this.copyThreadIdButton = document.createElement('button');
    this.copyThreadIdButton.type = 'button';
    this.copyThreadIdButton.className = 'agent-thread-card__icon-btn agent-thread-card__copy-thread-id';
    this.copyThreadIdButton.setAttribute('aria-label', '复制 ThreadId');
    this.copyThreadIdButton.title = '复制 ThreadId';
    this.copyThreadIdButton.append(createCopyIcon());
    this.copyThreadIdButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.copyThreadId();
    });

    // header 右侧 actions 区: meta + delete + collapse, 一起右对齐。
    // 单独包一层让 meta 与按钮在视觉上"同组", 标题撑满剩余空间。
    const actions = document.createElement('div');
    actions.className = 'agent-thread-card__actions';

    // 删除按钮 ── 放在折叠按钮左侧 (与折叠共同构成 header 右侧 actions 区)。
    //
    // 行为: 走 ProseMirror 标准 delete 范式 ── state.tr.delete(pos, pos+nodeSize)
    // + dispatch ── 与 image/video/file attachment 三个 NodeView
    // 的 deleteNode() 完全一致, 不引入新机制。deleteNode 钩子本身留给键盘 / slash menu
    // 等场景, 这里 UI 入口直接做同样的删除事务, 保证行为统一。
    //
    // 范围: 只删 ProseMirror 节点 (即这张卡片从笔记里消失), 不删后端 thread 数据。
    // thread 是后端资产, 可能在其他笔记 / Agent 面板被引用, 删卡片等同于'从这篇
    // 笔记里撤掉引用', 用户想清空 thread 数据走 thread 列表的'删除对话'。
    //
    // 视觉: lucide Trash2 (24x24 viewBox, stroke 2), 与 createChevronIcon 同款
    // stroke 风格, 14×14 渲染。aria-label 用'删除对话'。
    this.deleteButton = document.createElement('button');
    this.deleteButton.type = 'button';
    this.deleteButton.className = 'agent-thread-card__icon-btn agent-thread-card__delete';
    this.deleteButton.setAttribute('aria-label', '删除对话');
    this.deleteButton.append(createTrashIcon());
    this.deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      const pos = this.getPos?.();
      if (pos === undefined) return;
      const tr = this.view.state.tr.delete(pos, pos + this.node.nodeSize);
      this.view.dispatch(tr);
    });

    this.fullscreenButton = document.createElement('button');
    this.fullscreenButton.type = 'button';
    this.fullscreenButton.className = 'agent-thread-card__icon-btn agent-thread-card__fullscreen';
    this.fullscreenButton.setAttribute('aria-label', '全屏展示');
    this.fullscreenButton.hidden = true;
    this.fullscreenButton.append(createFullscreenIcon('enter'));
    this.fullscreenButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleFullscreen();
    });

    // 全屏 / 删除按钮之间的竖向分割线 ── 1px 宽 × 16px 高, 视觉
    // 上把"视图操作 (全屏)"与"破坏性操作 (删除)"明确分组。CSS 用
    // background-color + var(--border) 着色 + 圆角, 不画边框, 避免
    // 28px 高的容器里 1px border 因 box-sizing 撑大尺寸。
    this.actionsDivider = document.createElement('span');
    this.actionsDivider.className = 'agent-thread-card__actions-divider';
    this.actionsDivider.setAttribute('aria-hidden', 'true');
    this.actionsDivider.hidden = true;

    this.collapseButton = document.createElement('button');
    this.collapseButton.type = 'button';
    this.collapseButton.className = 'agent-thread-card__icon-btn agent-thread-card__collapse';
    this.collapseButton.setAttribute('aria-label', '折叠');
    this.collapseButton.append(createChevronIcon('down'));
    this.collapseButton.addEventListener('click', (event) => {
      // 阻止事件冒泡, 避免与卡片根 mousedown 处理互相干扰。
      event.stopPropagation();
      this.toggleCollapsed();
    });

    // header 右侧 actions 顺序: meta | fullscreen | 分割线 | delete | collapse。
// 全屏放最左, 与"破坏性操作 (删除)" 隔一根分割线分组 ── 视图操作与
// 破坏性操作视觉上分开, 减少误删概率。分割线在 fullscreen 隐藏时也
// 一起隐藏 (renderFullscreenState 控制), 不留悬空竖线。
actions.append(
  this.metaEl,
  this.fullscreenButton,
  this.actionsDivider,
  this.deleteButton,
  this.collapseButton
);
    header.append(agentWrap, actions);

    this.body = document.createElement('div');
    this.body.className = 'agent-thread-card__body';
    // flowix:// 深链委托挂在容器层, 不随消息全量回放反复绑
    // (renderThreadState 会 this.body.replaceChildren(), 挂到子节点会泄漏)。
    this.body.addEventListener('click', this.handleBodyClick);
    this.body.addEventListener('scroll', this.boundHandleBodyScroll, { passive: true });

    // 消息区底部 loading 指示器 ── 24px 固定高度, 始终挂 body 末尾。
    // 一次性创建, renderThreadState 里反复 append 是 DOM 复用 ── 与
    // copyThreadIdButton 同模式。容器始终存在保证 24px 空间不被流式
    // 更新挤掉 (否则流式追加新消息时高度会跳一下)。
    //
    // 视觉 ── 与面板 agent-thinking-indicator 同源: 跳动小圆点 + 文字
    // "思考中"。圆点用 agentThinkingDot 关键帧 (styles/index.css 全局),
    // 文字 hidden 由 renderThreadState 切 isLoading 控制。
    this.loadingIndicator = document.createElement('div');
    this.loadingIndicator.className = 'agent-thread-card__loading-indicator';

    const loadingDot = document.createElement('span');
    loadingDot.className = 'agent-thread-card__loading-dot';
    loadingDot.setAttribute('aria-hidden', 'true');

    const loadingText = document.createElement('span');
    loadingText.className = 'agent-thread-card__loading-text';
    loadingText.textContent = '思考中';
    loadingText.hidden = true;

    this.loadingIndicator.append(loadingDot, loadingText);

    this.errorEl = document.createElement('div');
    this.errorEl.className = 'agent-thread-card__error';
    this.errorEl.hidden = true;

    const composer = document.createElement('div');
    composer.className = 'agent-thread-card__composer';
    this.composer = composer;

    this.input = document.createElement('textarea');
    this.input.rows = 1;
    this.input.placeholder = '问 AI 处理任务';
    this.input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      void this.submit();
    });
    // 多行检测: 内容超过 min-height 时给 composer 切换 align-items (居中 → 贴底)。
    // 阈值比 min-height (48px) 略高, 留 2px 抗亚像素抖动。
    this.input.addEventListener('input', () => this.updateMultiLineState());

    this.sendButton = document.createElement('button');
    this.sendButton.type = 'button';
    this.sendButton.className = 'agent-thread-card__send';
    this.sendButton.setAttribute('aria-label', '发送');
    this.sendButton.append(createSendIcon('send'));
    this.sendButton.addEventListener('click', () => {
      if (this.sendButton.classList.contains('agent-thread-card__send--stop')) {
        useChatStore.getState().stopStream();
        return;
      }
      void this.submit();
    });

    composer.append(this.input, this.sendButton);
    // 点击 composer 空白区域 ── 自动聚焦 textarea; stopPropagation
    // 阻止冒泡到 card 根 mousedown 处理, 避免 focus 状态互相影响
    // 整张卡片 (与"聚焦输入"语义冲突)。textarea / button 自身的点击
    // 已经处理 focus / submit, 不需要额外逻辑 ── closest 短路放行。
    this.composer.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest('textarea, button')) return;
      event.stopPropagation();
      this.input.focus();
    });
    this.dom.append(this.container);
    this.container.append(header, this.body, this.errorEl, composer);

    this.refreshAttrs();
    this.renderThreadState();
    this.subscribe();
    this.updateMultiLineState();
    this.scheduleLoadThreadCache();
    this.runInitialPromptIfNeeded();
  }

  private get threadId(): string | null {
    return (this.node.attrs.threadId as string | null) || null;
  }

  private get title(): string {
    return (this.node.attrs.title as string | null) || DEFAULT_TITLE;
  }

  private get roleKey(): AgentRoleKey {
    return normalizeAgentRoleKey(
      (this.node.attrs.roleKey as string | null) ||
      (this.node.attrs.agentId as string | null)
    );
  }

  private get collapsed(): boolean {
    return !!this.node.attrs.collapsed;
  }

  private consumeInitialPrompt(): string | null {
    const initialPrompt = typeof this.node.attrs.initialPrompt === 'string'
      ? this.node.attrs.initialPrompt.trim()
      : '';
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
    let previousThreadId = this.threadId;
    let previousThreadState = this.currentThreadState();
    this.unsubscribe = useChatStore.subscribe((state) => {
      const threadId = this.threadId;
      const nextThreadState = threadId ? state.threadStates[threadId] : undefined;
      if (threadId === previousThreadId && nextThreadState === previousThreadState) return;
      previousThreadId = threadId;
      previousThreadState = nextThreadState;
      this.renderThreadState();
      if (
        this.roleKey === 'codex' &&
        threadId?.startsWith('codex-local-') &&
        nextThreadState &&
        !nextThreadState.isLoading
      ) {
        void this.resolveCodexSessionId(threadId);
      }
    });
  }

  private async resolveCodexSessionId(threadId: string): Promise<string | null> {
    if (!threadId.startsWith('codex-local-')) return threadId;
    if (this.resolvingCodexSessionFor === threadId) return null;
    this.resolvingCodexSessionFor = threadId;
    try {
      const sessionId = await agent.getCodexSessionId(threadId);
      if (!sessionId || sessionId === threadId || this.isDestroyed || this.threadId !== threadId) {
        return sessionId ?? null;
      }
      this.updateAttrs({
        threadId: sessionId,
        roleKey: 'codex',
      });
      useChatStore.getState().setActiveAgentThread('codex', sessionId);
      await useChatStore.getState().loadCodexThread(sessionId);
      return sessionId;
    } catch (err) {
      console.error('Failed to resolve Codex session id:', err);
      return null;
    } finally {
      if (this.resolvingCodexSessionFor === threadId) {
        this.resolvingCodexSessionFor = null;
      }
    }
  }

  private scheduleLoadThreadCache(): void {
    const threadId = this.threadId;
    if (!threadId || this.isDestroyed) return;
    if (this.loadedThreadCacheFor === threadId || this.loadingThreadCacheFor === threadId) return;

    this.loadingThreadCacheFor = threadId;
    this.isLoadingThreadCache = true;
    this.renderThreadState();

    const run = async (): Promise<void> => {
      try {
        if (!this.isDestroyed && this.threadId === threadId) {
          if (this.roleKey === 'codex') {
            const sessionId = threadId.startsWith('codex-local-')
              ? await this.resolveCodexSessionId(threadId)
              : threadId;
            if (sessionId && !this.isDestroyed) {
              await useChatStore.getState().loadCodexThread(sessionId);
            }
          } else {
            await useChatStore.getState().loadThreadCache(threadId);
          }
          this.loadedThreadCacheFor = threadId;
        }
      } finally {
        if (this.loadingThreadCacheFor === threadId) {
          this.loadingThreadCacheFor = null;
          this.isLoadingThreadCache = false;
        }
        if (!this.isDestroyed) this.renderThreadState();
      }
    };

    if ('requestIdleCallback' in window) {
      this.loadThreadCacheIdleId = window.requestIdleCallback(() => {
        this.loadThreadCacheIdleId = null;
        void run();
      }, { timeout: 1200 });
    } else {
      this.loadThreadCacheTimeout = globalThis.setTimeout(() => {
        this.loadThreadCacheTimeout = null;
        void run();
      }, 300);
    }
  }

  private updateAttrs(attrs: Record<string, unknown>): void {
    const pos = this.getPos?.();
    if (pos === undefined) return;

    const nextAttrs = { ...this.node.attrs, ...attrs };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, nextAttrs));
    const nextNode = this.view.state.doc.nodeAt(pos);
    if (nextNode) {
      this.node = nextNode;
    }
    this.refreshAttrs();
    this.renderThreadState();
    this.scheduleLoadThreadCache();
  }

  private refreshAttrs(): void {
    this.dom.dataset.threadId = this.threadId ?? '';
    this.dom.dataset.title = this.title;
    this.dom.dataset.roleKey = this.roleKey;
    this.dom.dataset.collapsed = this.collapsed ? 'true' : 'false';
    const role = getAgentRole(this.roleKey);
    // role.name 已被 badge 承担, title 只显示对话标题 ── 避免与 badge 重复。
    this.titleEl.textContent = this.title;
    // 徽章内容与 roleKey 同步 ── 切换 role 或初次挂载时刷新,
    // 避免依赖外部组件级 mount 来确保 img 拿到正确 src。
    this.badgeIcon.src = role.icon;
    this.badgeIcon.alt = role.name;
    this.badgeName.textContent = role.name;
    this.renderCollapseState();
    this.renderFullscreenState();
  }

  // 同步折叠态: 切 .--collapsed 修饰类, 同步按钮的 aria-label。
  // 图标视觉切换交给 CSS ── 构造器一次性挂 chevron-down SVG, 折叠态
  // 由 .agent-thread-card--collapsed .agent-thread-card__chevron-icon
  // { transform: rotate(180deg) } 翻成 chevron-up, transition: 150ms
  // 给一个柔和的翻转动画。不在 TS 端 replaceChildren+append 重建节点 ──
  // 重建会导致折叠/展开瞬间 SVG 闪一下, 与 150ms transition 节奏冲突。
  private renderCollapseState(): void {
    const collapsed = this.collapsed;
    this.dom.classList.toggle('agent-thread-card--collapsed', collapsed);
    this.collapseButton.setAttribute('aria-label', collapsed ? '展开' : '折叠');
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

  private setFullscreen(fullscreen: boolean): void {
    if (fullscreen && !this.threadId) return;
    if (this.isFullscreen === fullscreen) return;

    this.isFullscreen = fullscreen;
    this.renderFullscreenState();

    if (fullscreen) {
      this.enterFullscreenMode();
    } else {
      this.exitFullscreenMode();
    }
  }

  private renderFullscreenState(): void {
    const hasThread = !!this.threadId;
    this.fullscreenButton.hidden = !hasThread;
    // 分割线与 fullscreenButton 可见性同步 ── fullscreen 隐藏 (没 thread)
    // 时分割线也隐藏, 否则会出现"分割线悬空"的视觉断层。
    this.actionsDivider.hidden = !hasThread;
    this.dom.classList.toggle('agent-thread-card--fullscreen', this.isFullscreen);
    this.fullscreenButton.setAttribute(
      'aria-label',
      this.isFullscreen ? '退出全屏展示' : '全屏展示'
    );
    this.fullscreenButton.replaceChildren(
      createFullscreenIcon(this.isFullscreen ? 'exit' : 'enter')
    );
  }

  private enterFullscreenMode(): void {
    if (this.collapsed) {
      this.updateAttrs({ collapsed: false });
    }

    this.fullscreenContainer = this.getFullscreenContainer();
    this.syncFullscreenBounds();
    this.observeFullscreenContainer();
    window.addEventListener('resize', this.boundSyncFullscreenBounds);
    window.addEventListener('keydown', this.boundHandleFullscreenKeydown, true);
    window.requestAnimationFrame(() => this.syncFullscreenBounds());
  }

  private exitFullscreenMode(): void {
    this.fullscreenResizeObserver?.disconnect();
    this.fullscreenResizeObserver = null;
    this.fullscreenContainer = null;
    window.removeEventListener('resize', this.boundSyncFullscreenBounds);
    window.removeEventListener('keydown', this.boundHandleFullscreenKeydown, true);
    this.clearFullscreenBounds();
  }

  private observeFullscreenContainer(): void {
    this.fullscreenResizeObserver?.disconnect();
    if (!this.fullscreenContainer || !('ResizeObserver' in window)) return;

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

    const rect = container.getBoundingClientRect();
    this.dom.style.setProperty('--atc-fullscreen-top', `${rect.top}px`);
    this.dom.style.setProperty('--atc-fullscreen-left', `${rect.left}px`);
    this.dom.style.setProperty('--atc-fullscreen-width', `${rect.width}px`);
    this.dom.style.setProperty('--atc-fullscreen-height', `${rect.height}px`);
    // OS 顶部控件区高度 ── Windows = 36px, Mac/Linux = 0px。
    // 全屏 CSS 用这个 var 算 top 偏移 (-titlebar) 与 height 加成
    // (+titlebar), 让卡片覆盖到 webview 顶端, 不再被 titlebar
    // 控件遮挡。
    const titlebarHeight = isWindowsPlatform() ? WINDOWS_TITLEBAR_HEIGHT_PX : 0;
    this.dom.style.setProperty('--atc-titlebar-height', `${titlebarHeight}px`);
  }

  private getFullscreenContainer(): HTMLElement | null {
    const container = this.dom.closest('.document-container');
    return container instanceof HTMLElement ? container : null;
  }

  private clearFullscreenBounds(): void {
    this.dom.style.removeProperty('--atc-fullscreen-top');
    this.dom.style.removeProperty('--atc-fullscreen-left');
    this.dom.style.removeProperty('--atc-fullscreen-width');
    this.dom.style.removeProperty('--atc-fullscreen-height');
    this.dom.style.removeProperty('--atc-titlebar-height');
  }

  private currentThreadState(): ThreadState | undefined {
    const threadId = this.threadId;
    return threadId ? useChatStore.getState().threadStates[threadId] : undefined;
  }

  private getBodyBottomDistance(): number {
    return Math.max(0, this.body.scrollHeight - this.body.clientHeight - this.body.scrollTop);
  }

  private isBodyNearBottom(): boolean {
    return this.getBodyBottomDistance() <= BOTTOM_FOLLOW_THRESHOLD_PX;
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

  // flowix:// 深链委托 ── 卡片场景下 AI 消息里的 `flowix://memo/<id>` 链接
  // 需点击打开对应笔记。marked 默认保留自定义 scheme, sanitizeMarkdownHtml
  // 只过滤 javascript: / data:text/html, 不会剥 flowix:// ── 因此 <a href>
  // 节点会真实出现在 DOM 里, 浏览器不识别 scheme 时点击无动作, 这里在容器
  // 上挂一次 click 委托拦下来, 走 openByTarget 统一管线 (与右栏 MarkdownRenderer /
  // noteReference 双击 / 单 instance 二次启动同一入口)。
  private handleBodyClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const a = target.closest<HTMLAnchorElement>('a[href^="flowix://"]');
    if (!a) return;
    event.preventDefault();
    // 阻止冒泡到外层可能存在的 React handler (例如把 click 解读为'打开卡片')
    event.stopPropagation();
    const href = a.getAttribute('href');
    if (href) void openNoteByDeepLink(href);
  }

  private renderThreadState(): void {
    const state = this.currentThreadState();
    const messages = state?.messages ?? [];
    const isLoading = !!state?.isLoading || this.isCreating;
    const previousScrollTop = this.body.scrollTop;
    const wasNearBottom = this.isBodyNearBottom();
    const shouldFollowStreaming = this.shouldFollowBottom || wasNearBottom;

    this.input.disabled = isLoading;
    this.composer.classList.toggle('agent-thread-card__composer--disabled', isLoading);
    this.setSendButtonState(isLoading, this.input.value.trim());
    // metaEl 内容随状态切换 (三态):
    //   loading      → 文字"运行中" (copyThreadIdButton 被 textContent 替换掉)
    //   no-thread    → 空 (copyThreadIdButton 不挂载, 隐藏)
    //   ready        → 复制 ThreadId 按钮 (textContent 清空后重新 append)
    // 按钮对象是构造器一次性创建的, 反复 append 是 DOM 复用 ── 不重建
    // SVG 节点与事件监听器。copyThreadIdButton 始终在内存里持有引用, 切回
    // ready 态时再挂回 DOM 即可。
    //
    // 'no-thread' 隐藏按钮的语义: thread 还没创建 (this.threadId === null) 时,
    // 没有可复制的 ThreadId; 复制空串会触发浏览器的复制失败或静默写入空,
    // 与用户预期不符 ── 此时视觉上也不需要这个按钮, 留 metaEl 空着即可。
    // thread 创建后 (submit 完成 → updateAttrs 设 threadId) renderThreadState
    // 会被 chat store subscribe 再次触发, 自动走到 'ready' 分支, 按钮出现。
    if (isLoading) {
      this.metaEl.textContent = '运行中';
    } else if (!this.threadId) {
      this.metaEl.textContent = '';
    } else {
      this.metaEl.textContent = '';
      this.metaEl.append(this.copyThreadIdButton);
    }

    // 同步 loading 指示器 ── 容器始终挂 body 末尾 (24px 固定),
    // 仅切换文字 "思考中" 的 hidden。dot 与文字同步: 不显示文字时
    // dot 一起 hidden ── 否则空 24px 区域里"独自跳动的圆点"会
    // 看起来像装饰 bug, 而不是 loading 反馈。
    const loadingText = this.loadingIndicator.querySelector<HTMLSpanElement>(
      '.agent-thread-card__loading-text'
    );
    const loadingDot = this.loadingIndicator.querySelector<HTMLSpanElement>(
      '.agent-thread-card__loading-dot'
    );
    if (loadingText) loadingText.hidden = !isLoading;
    if (loadingDot) loadingDot.hidden = !isLoading;

    this.body.replaceChildren();
    // 全量回放 ── 卡片有 max-height + body 内部滚动, 不再 slice 截断。
    // 用户要看到完整历史 (而非 4 条快照), 由 CSS max-height 限制卡片总高。
    const visibleMessages = messages;

    if (visibleMessages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'agent-thread-card__empty';
      empty.textContent = this.isLoadingThreadCache ? '加载对话中...' : '使用当前笔记开始 AI 对话';
      this.body.append(empty, this.loadingIndicator);
      this.shouldFollowBottom = true;
      return;
    }

    const list = document.createElement('div');
    list.className = 'agent-thread-card__messages';

    for (const message of visibleMessages) {
      // 与面板 message-assistant 一致: 空 assistant 消息不渲染, 避免
      // 流式分块初期出现"空白气泡"造成视觉跳动。
      if (!shouldRenderAgentMessage(message)) {
        continue;
      }
      const messageView = createAgentMessageViewModel(message);

      const item = document.createElement('div');
      item.className = `agent-thread-card__message agent-thread-card__message--${message.role}`;

      // 差异化 DOM: 不同 role 走不同结构, 对齐 Agent 面板 message-*.tsx。
      //   tool:        单行 icon + name + summary (面板 message-tool)
      //   end:         居中文字 + 时间戳 (面板 message-end)
      //   reasoning:   可折叠 ── 头部点击切换展开/收起, 对齐面板 message-reasoning
      //                的 ChevronDown/Right + 思考中/完成 button
      //   user/assistant: 纯 content, 走 markdown 渲染 ── 对齐面板
      //                message-user/message-assistant 都包 MarkdownRenderer
      if (message.role === 'tool') {
        const icon = createToolIcon(message.toolName);
        const name = document.createElement('span');
        name.className = 'agent-thread-card__message-tool-name';
        name.textContent = messageView.toolLabel;
        const summary = document.createElement('span');
        summary.className = 'agent-thread-card__message-tool-summary';
        summary.textContent = messageView.toolSummary;
        item.append(icon, name, summary);
      } else if (message.role === 'end') {
        const content = document.createElement('div');
        content.className = 'agent-thread-card__message-content';
        content.textContent = messageView.visibleContent;
        item.append(content);
      } else if (message.role === 'reasoning') {
        // 折叠头 ── 复用 header 右侧 collapse 按钮的 Chevron 工厂, 视觉
        // 与卡片折叠按钮同源 (lucide 24×24, 12×12 渲染, 略小于卡片级
        // 14×14 ── 体现 reasoning 作为次级折叠的视觉层级)。
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'agent-thread-card__message-reasoning-header';
        // 始终挂 chevron-down ── 折叠态视觉切换交给 CSS
        // (agent-thread-card__message--reasoning-collapsed 修饰类触发
        // transform: rotate(180deg)), 不在 TS 端 replaceChildren+append
        // 重建节点, 与卡片级 collapse 按钮走同一套"单 path + CSS 旋转"
        // 模式, transition 150ms 给一个柔和的翻转。
        const chevron = createChevronIcon('down');
        header.append(chevron);
        const label = document.createElement('span');
        label.textContent = messageView.reasoningLabel;
        header.append(label);

        const body = document.createElement('div');
        body.className = 'agent-thread-card__message-reasoning-body';
        const content = document.createElement('div');
        content.className = 'agent-thread-card__message-content';
        fillWithMarkdownHtml(content, renderMarkdownToHtml(messageView.visibleContent));
        body.append(content);

        // 折叠交互 ── 卡片场景用本地 (per-message) 折叠态, 不像面板
        // 走全局 zustand: 卡片消息紧凑, 折叠应能独立控制每条 thinking。
        // 默认展开 ── 与面板 message-reasoning 的全局折叠初始态对齐
        // (面板默认 reasoningCollapsed = false)。
        //
        // 视觉切换: 仅切修饰类, 不动 chevron DOM ── CSS rotate 负责方向。
        // 之前 replaceChildren+append 会在切换瞬间把 SVG 整个重建, 与
        // 150ms transition 节奏冲突, 切完会"硬闪"一下; 现在单节点旋转
        // 走 GPU 合成层, 过渡连续。
        const apply = (collapsed: boolean): void => {
          item.classList.toggle('agent-thread-card__message--reasoning-collapsed', collapsed);
        };
        header.addEventListener('click', (event) => {
          // 阻止 mousedown 冒泡到卡片根, 避免 focus 状态互相影响
          // 卡片 (面板 reasoning 折叠点击不期望被卡片选中接管)。
          event.stopPropagation();
          const next = !item.classList.contains('agent-thread-card__message--reasoning-collapsed');
          apply(next);
        });
        // 阻止 mousedown 自身, 避免点击折叠按钮触发 ProseMirror 选区。
        header.addEventListener('mousedown', (event) => event.stopPropagation());

        item.append(header, body);
      } else {
        // user / assistant: 纯 content, 走 markdown 渲染 ── 对齐面板
        // MarkdownRenderer( content ), 支持基础 markdown 语法 +
        // GFM (列表 / 表格 / 删除线 / 任务列表) + 行内 code / fenced code。
        // 视觉由 CSS 子选择器 (.agent-thread-card__message-content h1/p/code/...)
        // 控制, 复刻面板 message-assistant 的 text-sm leading-[1.8] 节奏。
        //
        // user 角色走 stripSystemBlock ── 卡片场景下 submit() 把全文档
        // 上下文以 <system>...</system> 块追加到 content 尾部, 渲染时
        // 剥掉这部分, 用户只看得到自己打的字, 不会看到笔记全文。
        // assistant 不剥 ── LLM 的回答里回引 system 内容是普通文本,
        // 没有 <system> 标签包裹, 不会误剥, 行为更稳。
        const content = document.createElement('div');
        content.className = 'agent-thread-card__message-content';
        fillWithMarkdownHtml(content, renderMarkdownToHtml(messageView.visibleContent));
        item.append(content);
      }

      list.append(item);
    }

    this.body.append(list, this.loadingIndicator);
    this.applyBodyScrollAfterRender({
      isLoading,
      previousScrollTop,
      shouldFollowStreaming,
    });
  }

  private setError(message: string | null): void {
    this.errorEl.hidden = !message;
    this.errorEl.textContent = message ?? '';
  }

  private setSendButtonState(isLoading: boolean, hasInput: string): void {
    this.sendButton.disabled = isLoading || !hasInput;
    const wantStop = isLoading;
    const isStop = this.sendButton.classList.contains('agent-thread-card__send--stop');
    if (wantStop === isStop) return;
    this.sendButton.replaceChildren();
    this.sendButton.append(createSendIcon(wantStop ? 'stop' : 'send'));
    this.sendButton.classList.toggle('agent-thread-card__send--stop', wantStop);
    this.sendButton.setAttribute('aria-label', wantStop ? '停止生成' : '发送');
  }

  // 复制 ThreadId 到剪贴板 ── 与代码块 .code-block-copy-btn 的 handleCopy
  // 完全同源: navigator.clipboard.writeText 主路径 + textarea + execCommand
  // 兜底路径, 成功时切对勾图标 + .copied 类触发绿色反馈, 2000ms 后还原。
  //
  // 不复制任何前置前缀 (e.g. "ThreadId: ") ── threadId 本身就是后端引用
  // 的唯一标识, 用户复制后多半是粘到 chat / 配置里直接搜, 加前缀反而
  // 让粘贴目标拿到一坨无法解析的字符串。
  private async copyThreadId(): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) return;

    try {
      await navigator.clipboard.writeText(threadId);
      this.showCopyThreadIdSuccess();
    } catch {
      this.fallbackCopyThreadId(threadId);
    }
  }

  private fallbackCopyThreadId(threadId: string): void {
    const textArea = document.createElement('textarea');
    textArea.value = threadId;
    textArea.style.position = 'fixed';
    textArea.style.top = '-1000px';
    textArea.style.left = '-1000px';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();

    try {
      document.execCommand('copy');
      this.showCopyThreadIdSuccess();
    } catch (err) {
      console.error('Failed to copy ThreadId:', err);
    }

    document.body.removeChild(textArea);
  }

  private showCopyThreadIdSuccess(): void {
    if (!this.copyThreadIdButton) return;

    this.copyThreadIdButton.replaceChildren(createCheckIcon());
    this.copyThreadIdButton.classList.add('agent-thread-card__copy-thread-id--copied');

    setTimeout(() => {
      if (this.copyThreadIdButton) {
        this.copyThreadIdButton.replaceChildren(createCopyIcon());
        this.copyThreadIdButton.classList.remove('agent-thread-card__copy-thread-id--copied');
      }
    }, 2000);
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
    if (this.input.value === '') {
      this.composer.classList.remove('agent-thread-card__composer--multi-line');
      this.setSendButtonState(isLoading, '');
      return;
    }
    const isMulti = this.input.scrollHeight > 30;
    this.composer.classList.toggle('agent-thread-card__composer--multi-line', isMulti);
    this.setSendButtonState(isLoading, this.input.value.trim());
  }

  private async submit(): Promise<void> {
    const rawPrompt = this.input.value.trim();
    if (!rawPrompt || this.input.disabled) return;

    // 提取全文档作为'技能'上下文 ── 跳过本卡 (agentThreadCard), 避免把
    // LLM 自己之前的回答 / 工具结果当成'笔记内容'再喂回去造成循环。
    // 空文档 / 全部是 card 的笔记 → 跳过注入, 不污染 user message。
    const documentContext = extractDocumentContext(this.view);
    const systemBlock = buildSystemBlock(documentContext);

    // 把 system 块追加到 user 实际输入后面 ── 这样:
    //   - LLM 看到的是 user message 里带 <system>...</system> 的完整 prompt
    //     (与目录 reminder 同位置拼接, 由 buildUserLlmContent 统一处理)
    //   - userMessage.content 存的是带 system 的字符串, 渲染时由
    //     stripSystemBlock 剥掉 system 部分, 用户只看到自己打的字
    const prompt = systemBlock ? `${rawPrompt}\n\n${systemBlock}` : rawPrompt;

    this.input.value = '';
    this.updateMultiLineState();
    this.setError(null);
    this.renderThreadState();

    let nextThreadId = this.threadId;
    try {
      if (!nextThreadId) {
        this.isCreating = true;
        this.renderThreadState();
        const nextTitle = buildTitle(rawPrompt);  // 标题用原文, 不带 system 块
        const role = getAgentRole(this.roleKey);
        if (role.runtime === 'codex') {
          nextThreadId = `codex-local-${Date.now()}`;
          this.updateAttrs({
            threadId: nextThreadId,
            title: nextTitle,
            roleKey: role.key,
          });
          useChatStore.getState().setActiveAgentThread(role.key, nextThreadId);
        } else {
          const thread = await agent.createThread(nextTitle);
          nextThreadId = thread.threadId;
          this.updateAttrs({
            threadId: thread.threadId,
            title: thread.title || nextTitle,
            roleKey: role.key,
          });
          useChatStore.getState().setActiveAgentThread(role.key, thread.threadId);
          void useChatStore.getState().loadThreadList();
        }
      }

      await useChatStore.getState().sendMessageToThread(nextThreadId, prompt, this.roleKey);
    } catch (err) {
      this.setError(typeof err === 'string' ? err : '发送失败');
    } finally {
      this.isCreating = false;
      this.renderThreadState();
      this.input.focus();
    }
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type.name !== this.node.type.name) return false;
    this.node = node;
    this.refreshAttrs();
    this.renderThreadState();
    this.scheduleLoadThreadCache();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.dom.contains(event.target as globalThis.Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.setFullscreen(false);
    this.isDestroyed = true;
    if (this.loadThreadCacheTimeout !== null) {
      globalThis.clearTimeout(this.loadThreadCacheTimeout);
      this.loadThreadCacheTimeout = null;
    }
    if (this.loadThreadCacheIdleId !== null && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(this.loadThreadCacheIdleId);
      this.loadThreadCacheIdleId = null;
    }
    this.body.removeEventListener('scroll', this.boundHandleBodyScroll);
    this.unsubscribe?.();
  }
}

export const AgentThreadCard = Node.create({
  name: 'agentThreadCard',
  group: 'block',
  content: '',
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      threadId: { default: null },
      title: { default: DEFAULT_TITLE },
      roleKey: { default: DEFAULT_AGENT_ROLE_KEY },
      collapsed: { default: false },
      initialPrompt: { default: null },
      autoSubmit: { default: false },
    };
  },

  parseHTML() {
    return [{
      tag: 'section[data-agent-thread-card]',
      getAttrs: (dom) => {
        const element = dom as HTMLElement;
        return {
          threadId: element.getAttribute('data-thread-id') || null,
          title: element.getAttribute('data-title') || DEFAULT_TITLE,
          roleKey: normalizeAgentRoleKey(
            element.getAttribute('data-role-key') || element.getAttribute('data-agent-id')
          ),
          collapsed: element.getAttribute('data-collapsed') === 'true',
        };
      },
    }];
  },

  renderHTML({ node }) {
    const threadId = node.attrs.threadId || '';
    const title = node.attrs.title || DEFAULT_TITLE;
    const roleKey = normalizeAgentRoleKey(node.attrs.roleKey || node.attrs.agentId);
    const role = getAgentRole(roleKey);
    const collapsed = !!node.attrs.collapsed;

    return [
      'section',
      mergeAttributes({
        'data-agent-thread-card': 'true',
        'data-thread-id': threadId,
        'data-title': title,
        'data-role-key': roleKey,
        'data-collapsed': collapsed ? 'true' : 'false',
        class: collapsed ? 'agent-thread-card agent-thread-card--collapsed' : 'agent-thread-card',
        contenteditable: 'false',
      }),
      [
        'div',
        { class: 'agent-thread-card__container' },
        ['div', { class: 'agent-thread-card__title' }, `${role.name} · ${title}`],
        ['div', { class: 'agent-thread-card__empty' }, '使用当前笔记开始 AI 对话'],
        [
          'div',
          { class: 'agent-thread-card__composer' },
          ['textarea', { placeholder: '问 AI 处理任务', rows: '1' }],
          [
            'button',
            {
              class: 'agent-thread-card__send',
              type: 'button',
              'aria-label': '发送',
            },
          ],
        ],
      ],
    ];
  },

  addCommands() {
    return {
      insertAgentThreadCard:
        (options) =>
        ({ state, dispatch, tr }) => {
          // 不用 commands.insertContent ── 它对 void 节点默认会放节点级选区
          // 选中整张卡 (与"光标停在卡片之后继续编辑"的预期不符)。改成
          // tr.replaceWith + an explicit trailing paragraph, then place the
          // text cursor inside that paragraph.
          //
          // 末尾插入的特殊问题 ── 用户报告"中间插入正常, 末尾插入会被
          // 选中", 根因是末尾时 `pos + node.nodeSize` 紧贴 paragraph 边界,
          // TextSelection.create 在这个非文本位置会走 PM 的 fallback selection,
          // 浏览器把 selection 跨在卡片 DOM 上, 形成 native 选区高亮。
          //
          // 修法: 不再让 PM 猜最近 selection; 直接在卡片后补一个空段落,
          // 并把 selection 设为这个段落内的 TextSelection。
          const nodeType = state.schema.nodes[this.name];
          if (!nodeType) return false;
          const roleKey = normalizeAgentRoleKey(
            options?.roleKey ?? useChatStore.getState().activeAgentRoleKey
          );
          const node = nodeType.create({
            threadId: null,
            title: DEFAULT_TITLE,
            roleKey,
            collapsed: false,
            initialPrompt: options?.initialPrompt ?? null,
            autoSubmit: !!options?.autoSubmit,
          });
          const from = options?.replaceRange?.from ?? state.selection.from;
          const to = options?.replaceRange?.to ?? from;
          tr.replaceWith(from, to, node);
          const after = from + node.nodeSize;
          const paragraphType = state.schema.nodes.paragraph;

          if (paragraphType) {
            tr.insert(after, paragraphType.create());
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
          }
          // Always keep an explicit document cursor after the card, then move
          // the actual DOM focus into the newly-created composer.
          if (dispatch) {
            dispatch(tr);
            focusAgentThreadCardInput(this.editor.view, from);
          }
          return true;
        },
    };
  },

  addNodeView() {
    return (props) => new AgentThreadCardView(
      props.node,
      props.view,
      typeof props.getPos === 'function' ? props.getPos : undefined
    );
  },

  markdownTokenizer: {
    name: 'agentThreadCard',
    level: 'block' as const,
    start(src: string) {
      return src.indexOf('::agent-thread-card');
    },
    tokenize(src: string): any {
      const match = /^::agent-thread-card\{([^}]*)\}[ \t]*(?:\n|$)/.exec(src);
      if (!match) return undefined;
      return { type: 'agentThreadCard', raw: match[0], attrs: match[1] };
    },
  },

  parseMarkdown(token: any) {
    const attrs = parseCardAttrs(token.attrs || '');
    return {
      type: 'agentThreadCard',
      attrs: {
        threadId: attrs.threadId || null,
        title: attrs.title || DEFAULT_TITLE,
        roleKey: normalizeAgentRoleKey(attrs.roleKey || attrs.agentId),
        collapsed: attrs.collapsed === 'true',
      },
    };
  },

  renderMarkdown(node) {
    const threadId = escapeAttr(node.attrs?.threadId);
    const title = escapeAttr(node.attrs?.title || DEFAULT_TITLE);
    const roleKey = normalizeAgentRoleKey(node.attrs?.roleKey || node.attrs?.agentId);
    const collapsed = !!node.attrs?.collapsed;
    return `::agent-thread-card{threadId="${threadId}" title="${title}" roleKey="${roleKey}" collapsed="${collapsed}"}\n`;
  },
});
