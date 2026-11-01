'use client';

import type { ReactNode, RefObject } from 'react';
import { CollectionTabButton } from '@shared/ui/collection-tab-bar';
import { hostTabEditId, type CollectionHostTab } from './collection-host-tab';
import { TabStripItem } from './tab-strip-item';
import type { TabInlineEdit } from './use-tab-inline-edit';

/**
 * 宿主 tab 的渲染（文件树 / 图墙 / 列表）。
 *
 * 返回一组兄弟节点而不是包一层容器：`CollectionTabStrip` 是 flex 容器，
 * 多包一层 div 会把几个 tab 挤成一个 flex item，间距和滚动都跟着坏。
 *
 * 可移除的资料视图 tab 与表格自己的视图 tab 共用 `TabStripItem`（同一套就地改名与
 * 右键菜单）；不可移除的固定 tab（文件树）退化成普通按钮，没有右键菜单。
 */
export function HostTabButtons({ tabs, activeKey, editable, saving, edit, menuKey, onMenuKeyChange, widthRef,
  onSelect, onBeginRename, onCommitRename, onRequestDelete }: {
  tabs: readonly CollectionHostTab[];
  activeKey: string | null;
  editable: boolean;
  saving: boolean;
  /** 与表格视图 tab 共用的就地改名输入框（一条 tab 条只能有一个）。 */
  edit: TabInlineEdit;
  /** 右键菜单打开中的 tab key：菜单存续期间给 tab 上背景提示（与视图 tab 共用）。 */
  menuKey: string | null;
  onMenuKeyChange: (key: string | null) => void;
  widthRef: RefObject<number>;
  onSelect?: (key: string) => void;
  onBeginRename: (tab: CollectionHostTab, width?: number) => void;
  onCommitRename: (key: string, name: string) => void;
  onRequestDelete: (tab: CollectionHostTab) => void;
}): ReactNode {
  return <>{tabs.map((tab): ReactNode => {
    if (!tab.removable || !tab.viewId) {
      return <CollectionTabButton
        key={tab.key}
        label={tab.label}
        active={activeKey === tab.key}
        onClick={() => onSelect?.(tab.key)}
      />;
    }
    return <TabStripItem
      key={tab.key}
      label={tab.label}
      // 就地改名的 id 约定与「管理视图」一致：`host:` + tab key（`域名:视图id`）。
      editId={hostTabEditId(tab.key)}
      active={activeKey === tab.key}
      menuActive={menuKey === tab.key}
      editable={editable}
      saving={saving}
      edit={edit}
      onMenuOpenChange={(open) => onMenuKeyChange(open ? tab.key : null)}
      widthRef={widthRef}
      onSelect={() => onSelect?.(tab.key)}
      onBeginRename={(width) => onBeginRename(tab, width)}
      onCommitRename={(name) => onCommitRename(tab.key, name)}
      // Escape 回到原名（提交同名，外壳判定无变化）。
      onCancelRename={() => onCommitRename(tab.key, tab.label)}
      onRequestDelete={() => onRequestDelete(tab)}
      deleteDisabled={!editable || saving || tab.deleteDisabled === true}
    />;
  })}</>;
}
