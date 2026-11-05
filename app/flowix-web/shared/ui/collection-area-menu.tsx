'use client';

/**
 * 集合「列表区域」的统一右键菜单。
 *
 * 集合的每个 tab 只描述**本 tab 能做什么**（新建笔记 / 新建文件夹 / 导入…），
 * 菜单本体、样式与交互（定位、键盘导航、点外关闭、滚动关闭）都走这里一份，
 * 各 tab 只负责把 items 摆出来 —— 菜单项因此在不同 tab 之间长得完全一样。
 *
 * 用法：包住该 tab 的数据区域即可（默认 `display: contents`，不参与布局）：
 *
 *   <CollectionAreaMenu items={items}>{列表内容}</CollectionAreaMenu>
 *
 * 行内若已有自己的右键菜单（例如文件树行），那层会 `stopPropagation`，
 * 本层不会抢到事件；只有落在「空白区域」的右键才走到这里。
 */
import { useContextMenuContext, ContextMenu, ContextMenuContent, ContextMenuItem } from '@shared/ui/context-menu';
import type { ReactNode } from 'react';

export interface CollectionAreaMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

const MENU_CLASS = 'min-w-[188px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]';
const MENU_ITEM_CLASS = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--foreground)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] focus-visible:bg-[var(--brand)] focus-visible:text-[var(--primary-foreground)]';

function AreaMenuTrigger({ items, className, children }: {
  items: readonly CollectionAreaMenuItem[];
  className: string;
  children: ReactNode;
}) {
  const { openAt } = useContextMenuContext();
  return <div
    className={className}
    onContextMenu={(event) => {
      // 行级菜单已经处理过（或显式取消了系统菜单）就不再叠加第二层菜单。
      if (event.defaultPrevented || items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      openAt(event.clientX, event.clientY, event.currentTarget);
    }}
  >
    {children}
    <ContextMenuContent className={MENU_CLASS}>
      {items.map((item) => <ContextMenuItem
        key={item.key}
        disabled={item.disabled}
        onClick={item.onSelect}
        className={MENU_ITEM_CLASS}
      >
        {item.icon ?? <span aria-hidden="true" className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </ContextMenuItem>)}
    </ContextMenuContent>
  </div>;
}

export function CollectionAreaMenu({ items, children, className = 'contents' }: {
  items: readonly CollectionAreaMenuItem[];
  children: ReactNode;
  /** 默认 `contents`：包一层但不改变布局；需要撑满时可传 flex 类。 */
  className?: string;
}) {
  return <ContextMenu>
    <AreaMenuTrigger items={items} className={className}>{children}</AreaMenuTrigger>
  </ContextMenu>;
}
