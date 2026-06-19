import { Node, mergeAttributes } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView, NodeView as ProseMirrorNodeView } from '@tiptap/pm/view';
import { Marked } from 'marked';
import { agent } from '../../../lib/tauri/client';
import { useChatStore, type ThreadState } from '../../../lib/store/chat-store';
import { useSettingsStore } from '../../../lib/store/settings-store';
import type { AgentRoleKey } from '../../../types/agent';
import {
  createAgentMessageViewModel,
  shouldRenderAgentMessage,
} from '../../../lib/message/agent-message';
import { openNoteByDeepLink } from '../../../lib/openByTarget';
import { isWindowsPlatform } from '../../../lib/shortcuts/platform';
import { DEFAULT_AGENT_ROLE_KEY, getAgentRole, normalizeAgentRoleKey } from '../../../lib/agent-roles';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    agentThreadCard: {
      insertAgentThreadCard: (options?: {
        roleKey?: AgentRoleKey;
        replaceRange?: { from: number; to: number };
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
const ICON_SEND_PATH = 'M231.87,114l-168-95.89A16,16,0,0,0,40.92,37.34L71.55,128,40.92,218.67A16,16,0,0,0,56,240a16.15,16.15,0,0,0,7.93-2.1l167.92-96.05a16,16,0,0,0,.05-27.89ZM56,224a.56.56,0,0,0,0-.12L85.74,136H144a8,8,0,0,0,0-16H85.74L56.06,32.16A.46.46,0,0,0,56,32l168,95.83Z';
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
// ChatTeardrop 气泡图标 ── 用于 metaEl 位的"打开 AI 对话侧边栏"按钮。
// Phosphor regular weight, viewBox 256×256, 渲染尺寸 14×14 与 chevron 同源。
// 形状: 圆 + 左下尖角 (teardrop) + 内部圆形镂空 ── 经典 chat bubble 语义。
const ICON_CHAT_BUBBLE_PATH = 'M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,100-100A100.11,100.11,0,0,0,132,24Zm0,184H48V124a84,84,0,1,1,84,84Z';
const ICON_TRASH_PATH = 'M216,48H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM192,208H64V64H192ZM80,24a8,8,0,0,1,8-8h80a8,8,0,0,1,0,16H88A8,8,0,0,1,80,24Z';
const ICON_FULLSCREEN_PATH = 'M40,96a8,8,0,0,1-8-8V48A16,16,0,0,1,48,32H88a8,8,0,0,1,0,16H48V88A8,8,0,0,1,40,96ZM208,32H168a8,8,0,0,0,0,16h40V88a8,8,0,0,0,16,0V48A16,16,0,0,0,208,32ZM88,208H48V168a8,8,0,0,0-16,0v40a16,16,0,0,0,16,16H88a8,8,0,0,0,0-16Zm128-48a8,8,0,0,0-8,8v40H168a8,8,0,0,0,0,16h40a16,16,0,0,0,16-16V168A8,8,0,0,0,216,160Z';
const ICON_FULLSCREEN_EXIT_PATH = 'M96,40V80A16,16,0,0,1,80,96H40a8,8,0,0,1,0-16H80V40a8,8,0,0,1,16,0Zm120,40H176V40a8,8,0,0,0-16,0V80a16,16,0,0,0,16,16h40a8,8,0,0,0,0-16ZM80,176v40a8,8,0,0,0,16,0V176a16,16,0,0,0-16-16H40a8,8,0,0,0,0,16Zm136-16H176a16,16,0,0,0-16,16v40a8,8,0,0,0,16,0V176h40a8,8,0,0,0,0-16Z';
// 工具消息图标 ── 对齐面板 lib/message/icons.ts 的 TOOL_ICONS, 但
// 卡片是纯 DOM, 不能用 lucide React 组件, 改用 Phosphor 同语义图标的
// SVG 路径内联。viewBox 256x256, 用 regular weight, 与面板 h-3.5 w-3.5
// (14×14px) 渲染尺寸对应。未命中映射 → Terminal 通用回退。
//
// 命名 → 图标对照 (与面板 icons.ts 同步):
//   ls / list_directory / list_notebooks → Folder
//   read / read_file                      → FileText
//   write / write_file / create_file      → FilePlus
//   edit / edit_file                      → FilePlus
//   delete_file                           → Trash
//   search_files / glob / grep            → MagnifyingGlass
//   execute_command / bash / shell        → Terminal
//   code                                  → Code
//   git_*                                 → GitBranch
//   db_query / database                   → Database
//   server / api                          → Globe
//   settings                              → Gear
//   run                                   → Play
//   stop                                  → Pause
//   restart                               → ArrowsClockwise
//   view                                  → Eye
//   default                               → Terminal
const TOOL_ICON_PATHS: Record<string, string> = {
  // Folder
  folder: 'M219.43,182.86,166.86,232H40a8,8,0,0,1-8-8V48A16,16,0,0,1,48,32h66.21a16,16,0,0,1,11.31,4.69L144.51,56H216A16,16,0,0,1,232,72V168A16,16,0,0,1,219.43,182.86Z',
  // FileText
  fileText: 'M213.69,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.69,82.34ZM152,160H104a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm0-32H104a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm45.66,117.66-5.66,5.66a8,8,0,0,1-11.31,0L168,240H56a8,8,0,0,1-8-8V51.31L63.31,36H152V88a8,8,0,0,0,8,8h52Z',
  // FilePlus
  filePlus: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48Zm-72-72a8,8,0,0,1-8,8H112v8a8,8,0,0,1-16,0v-8H88a8,8,0,0,1,0-16h8V128a8,8,0,0,1,16,0v8h8A8,8,0,0,1,128,144Z',
  // Trash
  trash: 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM104,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm64,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z',
  // MagnifyingGlass
  magnify: 'M229.66,218.34,179.6,168.28a88.21,88.21,0,1,0-11.32,11.32l50.06,50.06a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  // Terminal
  terminal: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-33.66-77.66L68,121.66l26.34-26.34a8,8,0,0,0-11.32-11.32l-32,32a8,8,0,0,0,0,11.32l32,32a8,8,0,0,0,11.32-11.32Zm64,3.66H128a8,8,0,0,1,0-16h30.34a8,8,0,0,1,0,16Z',
  // Code
  code: 'M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29ZM162.73,82.81l-32,96a8,8,0,1,1-15.46-4.82l32-96a8,8,0,0,1,15.46,4.82Z',
  // GitBranch
  gitBranch: 'M224,64a32,32,0,1,0-40,31v9a16,16,0,0,1-16,16H104a32,32,0,0,0-32,32v9a32,32,0,1,0,16,0V152a16,16,0,0,1,16-16h64a32,32,0,0,0,32-32V95A32.06,32.06,0,0,0,224,64ZM88,216a16,16,0,1,1,16-16A16,16,0,0,1,88,216ZM224,96a16,16,0,1,1,16-16A16,16,0,0,1,224,96Z',
  // Database
  database: 'M128,24C74.8,24,32,42.2,32,64v48c0,21.8,42.8,40,96,40s96-18.2,96-40V64C224,42.2,181.2,24,128,24Zm0,176c-44.2,0-80-12.3-80-28V150.4c17.4,8.6,40.7,13.6,80,13.6s62.6-5,80-13.6V172C208,187.7,172.2,200,128,200Zm0,32c-44.2,0-80-12.3-80-28V182.4c17.4,8.6,40.7,13.6,80,13.6s62.6-5,80-13.6V204C208,219.7,172.2,232,128,232Z',
  // Globe (server/api)
  globe: 'M128,24A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm0,16a88.07,88.07,0,0,1,76.94,45.06c-1.69,28.84-18,53.55-42.94,67.16V144a8,8,0,0,0-16,0v8.6A88,88,0,0,1,99.31,144c-.41-1.83-.31-3.7-.31-5.6a44,44,0,0,1,88,0c0,1.9.1,3.77-.31,5.6a88,88,0,0,1-46.69,8.6V144a8,8,0,0,0-16,0v8.22c-24.94-13.61-41.25-38.32-42.94-67.16A88.07,88.07,0,0,1,128,40Zm0,176a88,88,0,0,1-27.06-171.42c4.07,32.62,29.43,57.7,62.06,61.31A44,44,0,0,1,99,138.4,88,88,0,0,0,128,216Zm0-176a88,88,0,0,0-27.06,171.42c4.07-32.62,29.43-57.7,62.06-61.31A44,44,0,0,1,99,138.4,88,88,0,0,0,128,40Z',
  // Gear (settings)
  gear: 'M128,80a48,48,0,1,0,48,48A48,48,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-58.66-22.05-4.42a86,86,0,0,0-6.59-15.91l12.7-19.07a8,8,0,0,0-1.49-10.59L197.86,32.69a8,8,0,0,0-10.59,1.49L167.92,53.45a86,86,0,0,0-15.91-6.59L147.43,24.6A8,8,0,0,0,139.6,18H116.4a8,8,0,0,0-7.83,6.6l-4.58,22.26a86,86,0,0,0-15.91,6.59L68.66,40.18A8,8,0,0,0,58.07,38.69L35.43,61.35a8,8,0,0,0,1.49,10.59L50.06,91.4a86,86,0,0,0-6.59,15.91L21.32,112a8,8,0,0,0-6.6,7.83v23.2a8,8,0,0,0,6.6,7.83l22.15,4.51a86,86,0,0,0,6.59,15.91L37,189.06a8,8,0,0,0,1.49,10.59l22.62,22.66a8,8,0,0,0,10.59-1.49L88.08,202.55a86,86,0,0,0,15.91,6.59l4.58,22.26a8,8,0,0,0,7.83,6.6h23.2a8,8,0,0,0,7.83-6.6l4.58-22.26a86,86,0,0,0,15.91-6.59l19.16,19.27a8,8,0,0,0,10.59,1.49l22.63-22.63a8,8,0,0,0,1.49-10.59L205.94,170a86,86,0,0,0,6.59-15.91l22.15-4.51a8,8,0,0,0,6.6-7.83v-23.2A8,8,0,0,0,237.94,101.34Z',
  // Play
  play: 'M232.4,114.49,88.32,26.35a16,16,0,0,0-16.2-.3A15.86,15.86,0,0,0,64,40V216a15.86,15.86,0,0,0,8.12,13.95,16,16,0,0,0,16.2-.3L232.4,141.51a15.81,15.81,0,0,0,0-27ZM80,215.14V40.86L215.88,128Z',
  // Pause
  pause: 'M216,48V208a16,16,0,0,1-16,16H160a16,16,0,0,1-16-16V48a16,16,0,0,1,16-16h40A16,16,0,0,1,216,48ZM96,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16H96a16,16,0,0,0,16-16V48A16,16,0,0,0,96,32Z',
  // ArrowsClockwise (restart)
  arrowsClockwise: 'M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16h35L197.66,74.34a88,88,0,0,0-124.92,0,8,8,0,0,1-11.32-11.32,104,104,0,0,1,147.58,0L232,85V56a8,8,0,0,1,16,0Zm-32.92,110.62a8,8,0,0,0-10.74,3.32,88,88,0,0,1-124.92,0,8,8,0,0,0-11.32,11.32,104,104,0,0,0,147.58,0A8,8,0,0,0,207.08,166.62ZM72,152H24a8,8,0,0,0,0,16H72a8,8,0,0,0,0-16Z',
  // Eye (view)
  eye: 'M247.31,124.76c-.35-.79-8.82-19.58-27.65-38.41C194.57,61.26,162.88,48,128,48S61.43,61.26,36.34,86.35C17.51,105.18,9,124,8.69,124.76a8,8,0,0,0,0,6.5c.35.79,8.82,19.57,27.65,38.4C61.43,194.74,93.12,208,128,208s66.57-13.26,91.66-38.34c18.83-18.83,27.3-37.61,27.65-38.4A8,8,0,0,0,247.31,124.76ZM128,192c-30.78,0-57.67-11.19-79.93-33.25A133.47,133.47,0,0,1,25,128,133.33,133.33,0,0,1,48.07,97.25C70.33,75.19,97.22,64,128,64s57.67,11.19,79.93,33.25A133.46,133.46,0,0,1,231.05,128C223.84,141.46,192.94,192,128,192Zm0-112a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z',
};

// 工具名 → icon 路径 key (与面板 icons.ts 的 lucide 组件映射 1:1)。
// 增加新 toolName 时, 在此表加一行, 同时面板同步 ── 面板用 React
// 组件, 卡片用 Phosphor 路径, 名称(key)保持一致便于核对。
const TOOL_ICON_KEY_BY_NAME: Record<string, keyof typeof TOOL_ICON_PATHS> = {
  ls: 'folder',
  list_directory: 'folder',
  list_notebooks: 'folder',
  read: 'fileText',
  read_file: 'fileText',
  write: 'filePlus',
  write_file: 'filePlus',
  create_file: 'filePlus',
  edit: 'filePlus',
  edit_file: 'filePlus',
  delete_file: 'trash',
  search_files: 'magnify',
  glob: 'magnify',
  grep: 'magnify',
  execute_command: 'terminal',
  bash: 'terminal',
  shell: 'terminal',
  code: 'code',
  git_branch: 'gitBranch',
  git_commit: 'gitBranch',
  git_status: 'gitBranch',
  db_query: 'database',
  database: 'database',
  server: 'globe',
  api: 'globe',
  settings: 'gear',
  run: 'play',
  stop: 'pause',
  restart: 'arrowsClockwise',
  view: 'eye',
};

function toolIconPathFor(toolName: string | undefined): string {
  if (!toolName) return TOOL_ICON_PATHS.terminal;
  const key = TOOL_ICON_KEY_BY_NAME[toolName];
  if (key) return TOOL_ICON_PATHS[key];
  return TOOL_ICON_PATHS.terminal;
}

function createSendIcon(kind: 'send' | 'stop'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__send-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'stop' ? ICON_STOP_PATH : ICON_SEND_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
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
function createChatBubbleIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('agent-thread-card__open-panel-icon');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_CHAT_BUBBLE_PATH);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function createTrashIcon(): SVGSVGElement {
  // Phosphor 风格 fill 渲染, 256x256 viewBox + fill=currentColor ──
  // 与 createChatBubbleIcon / createSendIcon 完全同形, 视觉量级一致。
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
  path.setAttribute('d', toolIconPathFor(toolName));
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
  private collapseButton: HTMLButtonElement;
  private deleteButton: HTMLButtonElement;
  private fullscreenButton: HTMLButtonElement;
  private openPanelButton: HTMLButtonElement;
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

    // 拦截 native selection 起手 ── 与 node-note.ts 卡片同源思路, 但
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

    // "打开 AI 对话侧边栏" 按钮 ── 占据原消息条数位置 (metaEl 内)。
    // loading 时 metaEl 显示"运行中"文字, 这个按钮会被 textContent 替换掉;
    // 非 loading 时 metaEl 显示这个按钮。按钮本身始终存在 (构造器一次性
    // 创建), 仅在 DOM 树中的挂载位置随 loading 状态切换 ── 避免每次
    // renderThreadState 都重建 DOM 节点 (SVG 路径 + 事件监听器)。
    //
    // 点击行为 (两步):
    //   1. setActiveThreadId(this.threadId) ── 把这个 thread 设为面板的
    //      '当前显示对话'。面板组件读 activeThreadId 决定渲染哪个 thread。
    //   2. setAgentPanelVisible(true) ── 显式"打开"语义, 若面板已开
    //      则是 no-op (Zustand set 相同值不触发更新)。不选 toggle 是
    //      因为用户语义是"打开", 不是"切换"; 若以后想加"已开则聚焦输入框"
    //      可以在 action 里扩展。
    //
    // 事件传播: stopPropagation 阻止 click 冒泡, 避免与卡片根 mousedown 默认行为互相干扰 ──
    // 与 collapseButton 的处理一致。
    this.openPanelButton = document.createElement('button');
    this.openPanelButton.type = 'button';
    this.openPanelButton.className = 'agent-thread-card__icon-btn agent-thread-card__open-panel';
    this.openPanelButton.setAttribute('aria-label', '打开 AI 对话');
    this.openPanelButton.append(createChatBubbleIcon());
    this.openPanelButton.addEventListener('click', (event) => {
      event.stopPropagation();
      // 1. 切换 active thread ── 让右侧 Agent 面板把 '当前显示的对话' 切到
      //    本卡片绑定的 thread。
      // 2. 打开 Agent 面板 ── 与 setActiveThreadId 是两个独立的 store, 不能合并。
      //
      // 顺序: 先切 active 再开面板。Agent 面板的 React 组件读 activeThreadId
      // 决定渲染哪个 thread 的消息; 如果反过来(先开面板再切 active), 中间可能
      // 出现'面板显示的是上一个 thread'的视觉跳动 (虽然 React batch 会缓解,
      // 但仍不如'切完再开'稳)。
      //
      // 不调 loadThread: 卡片场景下 thread 通常已经在 threadStates 里(我们
      // 自己挂载时调过 loadThreadCache), 不需要再拉 threadInfo; 即便 threadStates
      // 里没有, Agent 面板挂载时会自己 load, 不需要在按钮 click 路径上加 IPC。
      const threadId = this.threadId;
      if (threadId) {
        useChatStore.getState().setActiveAgentThread(this.roleKey, threadId);
      }
      useSettingsStore.getState().setAgentPanelVisible(true);
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

    actions.append(this.metaEl, this.deleteButton, this.fullscreenButton, this.collapseButton);
    header.append(agentWrap, actions);

    this.body = document.createElement('div');
    this.body.className = 'agent-thread-card__body';
    // flowix:// 深链委托挂在容器层, 不随消息全量回放反复绑
    // (renderThreadState 会 this.body.replaceChildren(), 挂到子节点会泄漏)。
    this.body.addEventListener('click', this.handleBodyClick);
    this.body.addEventListener('scroll', this.boundHandleBodyScroll, { passive: true });

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
    //   loading      → 文字"运行中" (openPanelButton 被 textContent 替换掉)
    //   no-thread    → 空 (openPanelButton 不挂载, 隐藏)
    //   ready        → chat 气泡按钮 (textContent 清空后重新 append)
    // 按钮对象是构造器一次性创建的, 反复 append 是 DOM 复用 ── 不重建
    // SVG 节点与事件监听器。openPanelButton 始终在内存里持有引用, 切回
    // ready 态时再挂回 DOM 即可。
    //
    // 'no-thread' 隐藏气泡的语义: thread 还没创建 (this.threadId === null) 时,
    // 点开 panel 只能让面板显示上一次的 active thread ── 与'打开这个对话'
    // 的用户预期不符; 此时视觉上也不需要这个按钮, 留 metaEl 空着即可。
    // thread 创建后 (submit 完成 → updateAttrs 设 threadId) renderThreadState
    // 会被 chat store subscribe 再次触发, 自动走到 'ready' 分支, 气泡出现。
    if (isLoading) {
      this.metaEl.textContent = '运行中';
    } else if (!this.threadId) {
      this.metaEl.textContent = '';
    } else {
      this.metaEl.textContent = '';
      this.metaEl.append(this.openPanelButton);
    }

    this.body.replaceChildren();
    // 全量回放 ── 卡片有 max-height + body 内部滚动, 不再 slice 截断。
    // 用户要看到完整历史 (而非 4 条快照), 由 CSS max-height 限制卡片总高。
    const visibleMessages = messages;

    if (visibleMessages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'agent-thread-card__empty';
      empty.textContent = this.isLoadingThreadCache ? '加载对话中...' : '使用当前笔记开始 AI 对话';
      this.body.append(empty);
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

    this.body.append(list);
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

  // 切换 composer 的多行状态 ── 给容器加 .--multi-line 时, CSS 把
  // align-items 从 center 切到 flex-end, 按钮从居中变贴底。
  // 阈值与 textarea min-height (1.8rem ≈ 28.8px) 对齐: 内容未撑出 min-height
  // 视为单行 (按钮居中), 撑出后视为多行 (按钮贴底, 内容走 overflow-y 滚动)。
  // 空值短路: input 清空后 scrollHeight 还未 reflow, 直接 remove 类更稳。
  private updateMultiLineState(): void {
    if (this.input.value === '') {
      this.composer.classList.remove('agent-thread-card__composer--multi-line');
      return;
    }
    const isMulti = this.input.scrollHeight > 30;
    this.composer.classList.toggle('agent-thread-card__composer--multi-line', isMulti);
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
