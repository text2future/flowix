import { Fragment, type ComponentType } from 'react';
import {
  ImageUp,
  Paperclip,
  Table2,
  Video,
  type LucideProps,
} from 'lucide-react';
import { getAgentRole } from '../../../lib/agent-roles';

export type SlashMenuItemId =
  | 'table'
  | 'image'
  | 'file'
  | 'video'
  | 'agent-thread-flowix'
  | 'agent-thread-codex';

// Agent 角色项用图片资源展示角色图标（与 agent-roles.ts 集中管理的图标同源）；
// 其它项维持 Lucide 组件形式。两种渲染分支在 SlashMenuDropdown 内分发。
export type SlashMenuIcon = ComponentType<LucideProps> | string;

export interface SlashMenuItem {
  id: SlashMenuItemId;
  label: string;
  description: string;
  keywords: string[];
  icon: SlashMenuIcon;
  section: string;
}

export interface SlashMenuProps {
  items: SlashMenuItem[];
  selectedIndex: number;
  onSelect: (item: SlashMenuItem) => void;
  onHover: (index: number) => void;
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  {
    id: 'table',
    label: '表格',
    description: '3 x 3 表格',
    keywords: ['table', 'biaoge', 'grid'],
    icon: Table2,
    section: '添加',
  },
  {
    id: 'image',
    label: '图片',
    description: '上传图片',
    keywords: ['image', 'img', 'picture', 'tupian'],
    icon: ImageUp,
    section: '上传',
  },
  {
    id: 'video',
    label: '视频',
    description: '上传视频',
    keywords: ['video', 'shipin', 'movie'],
    icon: Video,
    section: '上传',
  },
  {
    id: 'file',
    label: '附件',
    description: '上传文件',
    keywords: ['file', 'attachment', 'fujian'],
    icon: Paperclip,
    section: '上传',
  },
  {
    id: 'agent-thread-flowix',
    label: getAgentRole('flowix').name,
    description: 'AI 任务',
    keywords: ['ai', 'agent', 'thread', 'chat', 'duihua', 'flowix', '任务', 'renwu', 'task'],
    icon: getAgentRole('flowix').icon,
    section: 'AI 对话',
  },
  {
    id: 'agent-thread-codex',
    label: getAgentRole('codex').name,
    description: 'AI 任务',
    keywords: ['codex', 'openai', 'code', 'bianma', '任务', 'renwu', 'task'],
    icon: getAgentRole('codex').icon,
    section: 'AI 对话',
  },
];

export const SlashMenuDropdown = ({
  items,
  selectedIndex,
  onSelect,
  onHover,
}: SlashMenuProps) => {
  return (
    <div
      className="slash-menu-dropdown"
      role="listbox"
      aria-label="Slash commands"
    >
      <div className="slash-menu-items">
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
                  <Icon className="h-4 w-4" aria-hidden="true" />
                );

            return (
              <Fragment key={item.id}>
                {showSectionHeader && (
                  <div className="slash-menu-header" role="presentation">
                    <span>{item.section}</span>
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`slash-menu-item${selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => onHover(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(item);
                  }}
                >
                  {renderIcon}
                  <span className="slash-menu-item-label">{item.label}</span>
                  <span className="slash-menu-item-description">{item.description}</span>
                </button>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
};
