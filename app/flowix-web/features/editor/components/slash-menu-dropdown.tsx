import { Fragment, useLayoutEffect, useRef, type MouseEvent } from 'react';
import {
  CheckSquareIcon,
  CodeIcon,
  ImageSquareIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  MinusIcon,
  PaperclipIcon,
  QuotesIcon,
  TableIcon,
  VideoCameraIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import { getAgentRole } from '@/lib/agent-roles';
import { ShortcutKbd } from '@shared/ui/shortcut-kbd';

export type SlashMenuItemId =
  | 'blockquote'
  | 'code-block'
  | 'table'
  | 'horizontal-rule'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'image'
  | 'video'
  | 'file'
  | 'agent-thread-flowix'
  | 'agent-thread-codex';

// Agent 角色项用图片资源展示角色图标（与 agent-roles.ts 集中管理的图标同源）；
// 其它项用 Phosphor 图标组件。两种渲染分支在 SlashMenuDropdown 内分发。
export type SlashMenuIcon = PhosphorIcon | string;

export interface SlashMenuItem {
  id: SlashMenuItemId;
  label: string;
  description?: string;
  keywords: string[];
  icon: SlashMenuIcon;
  section: string;
  /** 快捷键 actionId ── 给出时, 右侧用 ShortcutKbd 渲染 (覆盖 description)。
   *  description + shortcut 同时缺省时, 右侧不渲染, label 独占宽度。 */
  shortcut?: string;
}

export interface SlashMenuProps {
  items: SlashMenuItem[];
  selectedIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHover: (index: number) => void;
}

const SLASH_MENU_SCROLL_PADDING_TOP = 20;

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  {
    id: 'agent-thread-flowix',
    label: getAgentRole('flowix').name,
    description: 'AI Agent',
    keywords: ['ai', 'agent', 'thread', 'chat', 'duihua', 'flowix', '任务', 'renwu', 'task'],
    icon: getAgentRole('flowix').icon,
    section: 'AI',
  },
  {
    id: 'agent-thread-codex',
    label: getAgentRole('codex').name,
    description: 'AI Agent',
    keywords: ['codex', 'openai', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentRole('codex').icon,
    section: 'AI',
  },
  {
    id: 'blockquote',
    label: '引用',
    keywords: ['quote', 'blockquote', 'yinyong', '引用'],
    icon: QuotesIcon,
    section: '添加块',
  },
  {
    id: 'code-block',
    label: '代码块',
    keywords: ['code', 'block', 'codeblock', 'daimakuai', '代码', 'kuai'],
    icon: CodeIcon,
    section: '添加块',
  },
  {
    id: 'table',
    label: '表格',
    keywords: ['table', 'biaoge', 'grid'],
    icon: TableIcon,
    section: '添加块',
  },
  {
    id: 'horizontal-rule',
    label: '分割线',
    keywords: ['divider', 'hr', 'horizontal', 'rule', 'fenge', '分割'],
    icon: MinusIcon,
    section: '添加块',
  },
  {
    id: 'bullet-list',
    label: '无序列表',
    keywords: ['bullet', 'list', 'unordered', 'wuxu', '列表'],
    icon: ListBulletsIcon,
    section: '添加块',
    shortcut: 'editor.toggleBulletList',
  },
  {
    id: 'ordered-list',
    label: '有序列表',
    keywords: ['ordered', 'list', 'numbered', 'youxu', '列表'],
    icon: ListNumbersIcon,
    section: '添加块',
    shortcut: 'editor.toggleOrderedList',
  },
  {
    id: 'task-list',
    label: '待办列表',
    keywords: ['task', 'todo', 'checkbox', 'daiban', '待办'],
    icon: CheckSquareIcon,
    section: '添加块',
    shortcut: 'editor.toggleTaskList',
  },
  {
    id: 'image',
    label: '图片',
    keywords: ['image', 'img', 'picture', 'tupian'],
    icon: ImageSquareIcon,
    section: '上传',
  },
  {
    id: 'video',
    label: '视频',
    keywords: ['video', 'shipin', 'movie'],
    icon: VideoCameraIcon,
    section: '上传',
  },
  {
    id: 'file',
    label: '附件',
    keywords: ['file', 'attachment', 'fujian'],
    icon: PaperclipIcon,
    section: '上传',
  },
];

export const SlashMenuDropdown = ({
  items,
  selectedIndex,
  onSelect,
  onHover,
}: SlashMenuProps) => {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

    const targetTop = itemTop - SLASH_MENU_SCROLL_PADDING_TOP;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
  }, [selectedIndex, items]);

  return (
    <div
      className="slash-menu-dropdown"
      role="listbox"
      aria-label="Slash commands"
    >
      <div ref={scrollerRef} className="slash-menu-items">
        {items.length === 0 ? (
          <div className="slash-menu-empty">无匹配命令</div>
        ) : (
          items.map((item, index) => {
            const Icon = item.icon;
            const selected = index === selectedIndex;
            const prevItem = index > 0 ? items[index - 1] : null;
            const showSectionHeader = !prevItem || prevItem.section !== item.section;
            const renderIcon = typeof Icon === 'string'
              ? (
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
                  <div className="slash-menu-header" role="presentation">
                    <span>{item.section}</span>
                  </div>
                )}
                <button
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`slash-menu-item${selected ? ' is-selected' : ''}`}
                  onMouseMove={(event) => handleItemMouseMove(event, index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(item);
                  }}
                >
                  {renderIcon}
                  <span className="slash-menu-item-label">{item.label}</span>
                  {(item.shortcut || item.description) && (
                    <span className="slash-menu-item-description">
                      {item.shortcut
                        ? <ShortcutKbd actionId={item.shortcut} />
                        : item.description}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
};
