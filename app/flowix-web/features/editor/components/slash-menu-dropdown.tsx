import { Fragment, useLayoutEffect, useRef, type MouseEvent } from 'react';
import {
  CheckSquareIcon,
  CodeIcon,
  FilePlusIcon,
  ImageSquareIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  FunctionIcon,
  MinusIcon,
  PaperclipIcon,
  QuotesIcon,
  TableIcon,
  TextHFourIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextTIcon,
  VideoCameraIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { getAgentType } from '@/lib/agent-types';
import {
  OverlayScrollbar,
  type OverlayScrollbarHandle,
} from '@shared/ui/overlay-scrollbar';
import { translate, type AppLanguage, type I18nKey } from '@/lib/i18n';
import type { AgentTypeKey } from '@/types/agent';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { Kbd } from '@shared/ui/shortcut-kbd';
import { MediaLibraryIcon, TableDocumentIcon } from '@features/memo/components/file-type-icon';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';

export type SlashMenuItemId =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'paragraph'
  | 'blockquote'
  | 'code-block'
  | 'table'
  | 'table-reference'
  | 'table-kanban-view'
  | 'table-calendar-view'
  | 'table-gallery-view'
  | 'media-library-reference'
  | 'math-block'
  | 'web-card'
  | 'horizontal-rule'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'image'
  | 'video'
  | 'file'
  | 'agent-thread-codex'
  | 'agent-thread-claude'
  | 'agent-thread-gemini'
  | 'agent-thread-hermes'
  | 'agent-thread-openclaw'
  | 'agent-thread-opencode'
  | 'agent-thread-deepseek-harness'
  | 'agent-thread-pi'
  | 'create-child-note'
  | 'reference-note';

export type AgentThreadSlashMenuItemId = Extract<SlashMenuItemId, `agent-thread-${string}`>;

// Agent 类型项用图片资源展示角色图标（与 agent-types.ts 集中管理的图标同源）；
// 其它项用 Phosphor 图标组件。两种渲染分支在 SlashMenuDropdown 内分发。
type SlashMenuIcon = PhosphorIcon | string;

export interface SlashMenuItem {
  id: SlashMenuItemId;
  /** 原始展示文本 ── 用于品牌名 (Flowix / Codex / Claude Code 等不可翻译字串)。
   *  与 labelKey 互斥: 同时存在时 labelKey 优先。 */
  label?: string;
  /** i18n key ── 渲染 / 过滤时按当前语言翻译。 */
  labelKey?: I18nKey;
  description?: string;
  keywords: string[];
  icon: SlashMenuIcon;
  /** 分组标题: 优先用 i18n key 翻译; 没有 key 时回退到 section 原始字串。 */
  section?: string;
  /** i18n key ── 渲染时按当前语言翻译。 */
  sectionKey?: I18nKey;
  /** 快捷键 chord ── 使用与 drag context menu 相同的显示格式。 */
  shortcut?: string;
  /** Keep bundled agent entries visible while their runtime status is settling. */
  alwaysVisible?: boolean;
}

export interface SlashMenuProps {
  items: SlashMenuItem[];
  selectedIndex: number;
  scrollSelectedItem: boolean;
  onSelect: (item: SlashMenuItem) => void;
  onHover: (index: number) => void;
  onScroll?: () => void;
  /** 空态 CTA: 触发后跳到偏好设置的 AI Agents 配置列表。 */
  onAddAgent?: () => void;
  /** 当前界面语言 ── 弹窗经命令式 createRoot 渲染在 I18nProvider 外,
   *  useI18n() 拿不到上下文, 由宿主按 user-settings 的 language 传入。 */
  language: AppLanguage;
}

const SLASH_MENU_SCROLL_PADDING_TOP = 20;

/** Resolve an item's display label for the given language.
 *  优先用 labelKey 翻译; 没有 key 时回退到原始 label (品牌名场景)。 */
export function getSlashMenuItemLabel(item: SlashMenuItem, language: AppLanguage): string {
  if (item.labelKey) return translate(language, item.labelKey);
  return item.label ?? '';
}

/** Resolve an item's section header for the given language. */
export function getSlashMenuItemSection(item: SlashMenuItem, language: AppLanguage): string {
  if (item.sectionKey) return translate(language, item.sectionKey);
  return item.section ?? '';
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  {
    id: 'agent-thread-pi',
    label: getAgentType('pi').name,
    description: 'AI Agent',
    keywords: ['pi', 'coding agent', 'agent', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('pi').icon,
    sectionKey: 'editor.slash.section.agent',
    alwaysVisible: true,
  },
  {
    id: 'agent-thread-deepseek-harness',
    label: getAgentType('deepseek-harness').name,
    description: 'AI Agent',
    keywords: ['dsh', 'deepseek', 'harness', 'agent', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('deepseek-harness').icon,
    sectionKey: 'editor.slash.section.agent',
    // Keep DSH discoverable before the runtime and model are configured.
    // Selection performs the availability check and routes setup to Preferences.
    alwaysVisible: true,
  },
  {
    id: 'agent-thread-codex',
    label: getAgentType('codex').name,
    description: 'AI Agent',
    keywords: ['codex', 'openai', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('codex').icon,
    sectionKey: 'editor.slash.section.agent',
  },
  {
    id: 'agent-thread-claude',
    label: getAgentType('claude').name,
    description: 'AI Agent',
    keywords: ['claude', 'anthropic', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('claude').icon,
    sectionKey: 'editor.slash.section.agent',
  },
  {
    id: 'agent-thread-opencode',
    label: getAgentType('opencode').name,
    description: 'AI Agent',
    keywords: ['opencode', 'open code', 'acp', 'agent', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('opencode').icon,
    sectionKey: 'editor.slash.section.agent',
  },
  {
    id: 'agent-thread-gemini',
    label: getAgentType('gemini').name,
    description: 'AI Agent',
    keywords: ['gemini', 'google', 'cli', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('gemini').icon,
    sectionKey: 'editor.slash.section.agent',
  },
  {
    id: 'agent-thread-hermes',
    label: getAgentType('hermes').name,
    description: 'AI Agent',
    keywords: ['hermes', 'nous', 'agent', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('hermes').icon,
    sectionKey: 'editor.slash.section.agent',
  },
  {
    id: 'agent-thread-openclaw',
    label: getAgentType('openclaw').name,
    description: 'AI Agent',
    keywords: ['openclaw', 'claw', 'agent', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentType('openclaw').icon,
    sectionKey: 'editor.slash.section.agent',
  },
  {
    id: 'heading-1',
    label: '#',
    keywords: ['heading', 'h1', 'title', 'yiji', '标题'],
    icon: TextHOneIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+1',
  },
  {
    id: 'heading-2',
    label: '##',
    keywords: ['heading', 'h2', 'title', 'erji', '标题'],
    icon: TextHTwoIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+2',
  },
  {
    id: 'heading-3',
    label: '###',
    keywords: ['heading', 'h3', 'title', 'sanji', '标题'],
    icon: TextHThreeIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+3',
  },
  {
    id: 'heading-4',
    label: '####',
    keywords: ['heading', 'h4', 'title', 'siji', '标题'],
    icon: TextHFourIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+4',
  },
  {
    id: 'paragraph',
    labelKey: 'editor.block.paragraph',
    keywords: ['paragraph', 'text', '正文', '文本'],
    icon: TextTIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+0',
  },
  {
    id: 'bullet-list',
    labelKey: 'editor.slash.label.bulletList',
    keywords: ['bullet', 'list', 'unordered', 'wuxu', '列表'],
    icon: ListBulletsIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+Alt+8',
  },
  {
    id: 'ordered-list',
    labelKey: 'editor.slash.label.orderedList',
    keywords: ['ordered', 'list', 'numbered', 'youxu', '列表'],
    icon: ListNumbersIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+Alt+7',
  },
  {
    id: 'task-list',
    labelKey: 'editor.slash.label.taskList',
    keywords: ['task', 'todo', 'checkbox', 'daiban', '待办'],
    icon: CheckSquareIcon,
    sectionKey: 'editor.slash.section.addBlock',
    shortcut: 'Mod+Alt+9',
  },
  {
    id: 'blockquote',
    labelKey: 'editor.slash.label.quote',
    keywords: ['quote', 'blockquote', 'yinyong', '引用'],
    icon: QuotesIcon,
    sectionKey: 'editor.slash.section.addBlock',
  },
  {
    id: 'code-block',
    labelKey: 'editor.slash.label.codeBlock',
    keywords: ['code', 'block', 'codeblock', 'daimakuai', '代码', 'kuai'],
    icon: CodeIcon,
    sectionKey: 'editor.slash.section.addBlock',
  },
  {
    id: 'table',
    labelKey: 'editor.slash.label.table',
    keywords: ['table', 'biaoge', 'grid'],
    icon: TableIcon,
    sectionKey: 'editor.slash.section.addBlock',
  },
  {
    id: 'math-block',
    labelKey: 'editor.slash.label.math',
    keywords: ['math', 'formula', 'latex', 'katex', 'gongshi'],
    icon: FunctionIcon,
    sectionKey: 'editor.slash.section.addBlock',
  },
  {
    id: 'web-card',
    labelKey: 'editor.slash.label.web',
    keywords: ['web', 'url', 'link', 'preview', 'card', 'wangye', 'lianjie'],
    icon: LinkSimpleIcon,
    sectionKey: 'editor.slash.section.addBlock',
  },
  {
    id: 'horizontal-rule',
    labelKey: 'editor.slash.label.divider',
    keywords: ['divider', 'hr', 'horizontal', 'rule', 'fenge', '分割'],
    icon: MinusIcon,
    sectionKey: 'editor.slash.section.addBlock',
  },
  {
    id: 'table-reference',
    labelKey: 'editor.slash.label.multidimensionalTable',
    description: '插入多维表格引用视图',
    keywords: ['data table', 'multidimensional table', 'table view', 'biaoge', 'duowei', '数据表', '多维表', '引用'],
    icon: TableDocumentIcon,
    sectionKey: 'editor.slash.section.view',
  },
  {
    id: 'table-kanban-view',
    labelKey: 'editor.slash.label.kanbanView',
    keywords: ['kanban', 'board', '看板', '多维表格'],
    icon: TableDocumentIcon,
    sectionKey: 'editor.slash.section.view',
  },
  {
    id: 'table-calendar-view',
    labelKey: 'editor.slash.label.calendarView',
    keywords: ['calendar', '日历', '多维表格'],
    icon: TableDocumentIcon,
    sectionKey: 'editor.slash.section.view',
  },
  {
    id: 'table-gallery-view',
    labelKey: 'editor.slash.label.galleryView',
    keywords: ['gallery', 'gallery list', '画廊', '画廊列表', '多维表格'],
    icon: TableDocumentIcon,
    sectionKey: 'editor.slash.section.view',
  },
  {
    id: 'media-library-reference',
    labelKey: 'editor.slash.label.mediaLibrary',
    description: '插入媒体库资源视图',
    keywords: ['media library', 'media view', 'gallery', '媒体库', '资源视图', '图片视频'],
    icon: MediaLibraryIcon,
    sectionKey: 'editor.slash.section.view',
  },
  {
    id: 'image',
    labelKey: 'editor.slash.label.image',
    keywords: ['image', 'img', 'picture', 'tupian'],
    icon: ImageSquareIcon,
    sectionKey: 'editor.slash.section.upload',
  },
  {
    id: 'video',
    labelKey: 'editor.slash.label.video',
    keywords: ['video', 'shipin', 'movie'],
    icon: VideoCameraIcon,
    sectionKey: 'editor.slash.section.upload',
  },
  {
    id: 'file',
    labelKey: 'editor.slash.label.attachment',
    keywords: ['file', 'attachment', 'fujian'],
    icon: PaperclipIcon,
    sectionKey: 'editor.slash.section.upload',
  },
  {
    id: 'create-child-note',
    labelKey: 'editor.slash.label.newMemo',
    keywords: ['note', 'memo', 'child', 'create', 'reference', 'xinjian', 'biji', 'zibiji'],
    icon: FilePlusIcon,
    sectionKey: 'editor.slash.section.memo',
  },
  {
    id: 'reference-note',
    labelKey: 'editor.slash.label.referenceMemo',
    keywords: ['note', 'memo', 'reference', 'mention', 'link', 'yinyong', 'biji'],
    icon: LinkSimpleIcon,
    sectionKey: 'editor.slash.section.memo',
  },
];

export const SlashMenuDropdown = ({
  items,
  selectedIndex,
  scrollSelectedItem,
  onSelect,
  onHover,
  onScroll,
  onAddAgent,
  language,
}: SlashMenuProps) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overlayScrollbarRef = useRef<OverlayScrollbarHandle | null>(null);

  const handleItemMouseMove = (
    event: MouseEvent<HTMLButtonElement>,
    index: number
  ) => {
    if (event.movementX === 0 && event.movementY === 0) return;
    onHover(index);
  };

  // 键盘上下键移动 selectedIndex 后, 仅在当前 item 即将离开弹窗内部
  // 视口时滚动一次; 滚动发生时尽量把 item 放到顶部下方 20px。
  // 这样连续移动可见 item 时不会每次都推动列表, 减少抖动。
  // items 也进依赖: 过滤导致列表换血时, 即使 selectedIndex 没变
  // 也需要重新评估 (新列表里 selectedIndex 可能对应不同位置的 item)。
  useLayoutEffect(() => {
    if (!scrollSelectedItem) return;

    const item = itemRefs.current[selectedIndex];
    const scroller = scrollerRef.current;
    if (!item || !scroller) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const itemTop = itemRect.top - scrollerRect.top + scroller.scrollTop;
    const itemBottom = itemRect.bottom - scrollerRect.top + scroller.scrollTop;
    const visibleTop = scroller.scrollTop + SLASH_MENU_SCROLL_PADDING_TOP;
    const visibleBottom = scroller.scrollTop + scroller.clientHeight;

    if (itemTop >= visibleTop && itemBottom <= visibleBottom) return;

    // Keep the selected row visible with the smallest scroll needed. Moving
    // every exiting row to the top makes keyboard navigation jump by most of
    // the popup height near the first items below the fold (H2–H4).
    const targetTop = itemTop < visibleTop
      ? itemTop - SLASH_MENU_SCROLL_PADDING_TOP
      : itemBottom - scroller.clientHeight;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
    overlayScrollbarRef.current?.update();
  }, [selectedIndex, items, scrollSelectedItem]);

  useLayoutEffect(() => {
    // items 换血时重新同步 thumb 几何, 但不写入 data-scrolling ──
    // 否则打开菜单 / 过滤字符的瞬间滚动条会闪一下再淡出。
    overlayScrollbarRef.current?.update({ reveal: false, schedule: false });
  }, [items]);

  return (
    <div
      className={`slash-menu-dropdown${scrollSelectedItem ? ' is-keyboard-navigation' : ''}`}
      role="listbox"
      aria-label={translate(language, 'editor.slash.ariaLabel')}
    >
      <OverlayScrollbar
        ref={overlayScrollbarRef}
        className="slash-menu-items-frame"
        scrollerClassName="slash-menu-items"
        scrollerRef={scrollerRef}
        onScroll={onScroll}
      >
        {(() => {
          // 「AI Agent 分区为空」时 (整菜单空 / 全部 agent 被关 / 当前 query
          // 把所有 agent 都筛掉), 在 agent 分区里渲染一个跳转偏好设置的 CTA。
          // 其它分区照常列出 ── 这是区分"整菜单无匹配"与"agent 列表为空"
          // 的关键: 整菜单空 = 上面这个 case 之一, 走 CTA; 只有"所有分区
          // 都为空"这种理论情况才回退到"无匹配命令"。
          const hasAgentItem = items.some(
            (item) => item.sectionKey === 'editor.slash.section.agent',
          );
          const showAddAgentCta = !hasAgentItem && Boolean(onAddAgent);
          const renderItems = () =>
            items.map((item, index) => {
              const Icon = item.icon;
              const selected = index === selectedIndex;
              const isAgentThreadItem = item.id.startsWith('agent-thread-');
              const prevItem = index > 0 ? items[index - 1] : null;
              const sectionLabel = getSlashMenuItemSection(item, language);
              const prevSectionLabel = prevItem
                ? getSlashMenuItemSection(prevItem, language)
                : null;
              const showSectionHeader = !prevItem || prevSectionLabel !== sectionLabel;
              const displayLabel = getSlashMenuItemLabel(item, language);
              const agentTypeKey = item.id.slice('agent-thread-'.length) as AgentTypeKey;
              const renderIcon = typeof Icon === 'string'
                ? isAgentThreadItem ? (
                    <span className="slash-menu-agent-icon flex h-5 w-5 shrink-0 items-center justify-center rounded-full p-0.5">
                      <AgentIcon typeKey={agentTypeKey} alt="" className="h-[15px] w-[15px] object-contain" />
                    </span>
                  ) : (
                    <img
                      src={Icon}
                      alt=""
                      className="h-4 w-4 rounded object-contain"
                      aria-hidden="true"
                    />
                  )
                : (
                    <Icon className="h-4 w-4" weight="bold" aria-hidden="true" />
                  );
              return (
                <Fragment key={item.id}>
                  {showSectionHeader && (
                    <>
                      {prevItem && <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />}
                      <div className="slash-menu-header" role="presentation">
                        <span>{sectionLabel}</span>
                      </div>
                    </>
                  )}
                  <button
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`slash-menu-item group${selected ? ' is-selected' : ''}`}
                    onMouseMove={(event) => handleItemMouseMove(event, index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onSelect(item);
                    }}
                  >
                    {renderIcon}
                    <span className="slash-menu-item-label min-w-0 flex-1">{displayLabel}</span>
                    {item.shortcut && (
                      // 快捷键提示始终保持 muted-foreground ── hover / 选中态的
                      // 底色是浅色 --hover-bg, 不再反色为 primary-foreground 的白,
                      // 否则浅底白字对比度过低看不清。
                      <Kbd
                        chord={item.shortcut}
                        className="shrink-0 text-[var(--muted-foreground)]"
                      />
                    )}
                  </button>
                </Fragment>
              );
            });

          if (items.length === 0 && !showAddAgentCta) {
            return <div className="slash-menu-empty">{translate(language, 'editor.slash.empty')}</div>;
          }

          return (
            <>
              {showAddAgentCta && (
                <Fragment>
                  <div className="slash-menu-header" role="presentation">
                    <span>{translate(language, 'editor.slash.section.agent')}</span>
                  </div>
                  <button
                    type="button"
                    className="slash-menu-empty slash-menu-empty--cta"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onAddAgent?.();
                    }}
                  >
                    <span className="slash-menu-empty--cta-label">
                      {translate(language, 'editor.slash.empty.addAgent')}
                    </span>
                  </button>
                </Fragment>
              )}
              {items.length > 0 && renderItems()}
            </>
          );
        })()}
      </OverlayScrollbar>
    </div>
  );
};
