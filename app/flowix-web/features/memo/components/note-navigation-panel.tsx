'use client';

import { useCallback, useState } from 'react';

import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { NoteNavigationPanelHeaderMac } from '@features/memo/components/note-navigation-panel-header-mac';
import { NoteNavigationPanelHeaderWin } from '@features/memo/components/note-navigation-panel-header-win';
import { NotebookAccessFilesList } from '@features/memo/components/notebook-access-files-list';
import { NotebookList } from '@features/memo/components/notebook-list';
import { NavFilterButtons } from '@features/memo/components/nav-filter-buttons';
import { TagTree } from '@features/memo/components/tag-tree';
import { type Notebook } from '@features/memo';
import { cn } from '@/lib/utils';
import { isWindowsPlatform } from '@/lib/shortcuts/platform';
import { PluginNavItems } from '@features/plugin';
import type { PluginDescriptor } from '@platform/tauri/client';

interface NoteNavigationPanelProps {
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
  onTogglePanel: () => void;
  onOpenPreferences: (tab?: string) => void;
  activePluginId: string | null;
  onOpenPlugin: (plugin: PluginDescriptor) => void | Promise<void>;
  /** Lets an overlay owner provide the panel surface (for translucent drawers). */
  transparentSurface?: boolean;
}

interface NavCounts {
  total: number;
  agent: number;
  todo: number;
}

// 导航栏 ── 最左侧导航区域的组合根。拆分为四个独立子组件 + 共享 useDragReorder:
//   - NotebookList          笔记本列表 (拖拽重排 + 折叠)
//   - NavFilterButtons      顶部过滤器 (全部/待办)
//   - TagTree               标签树 (拖拽重排 + reparent + 行内重命名 + 删除)
//   - NotebookAccessFilesList  选中笔记本的可访问文件夹 (已独立组件)
// 本组件只负责布局编排 + counts 中转: TagTree 的 loadTags 上抛 counts,
// 经此传给 NavFilterButtons 展示。header 仍按 Mac/Win 差分。
export function NoteNavigationPanel({
  notebooks,
  selectedNotebook,
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
  onTogglePanel,
  onOpenPreferences,
  activePluginId,
  onOpenPlugin,
  transparentSurface = false,
}: NoteNavigationPanelProps) {
  const [counts, setCounts] = useState<NavCounts>({ total: 0, agent: 0, todo: 0 });
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);

  const handleCountsChange = useCallback((next: NavCounts) => {
    setCounts(next);
  }, []);

  return (
    <div className={cn(
      'flex h-full min-w-0 select-none flex-col text-[var(--agent-foreground)]',
      !transparentSurface && 'bg-[var(--agent-bg)]',
    )}>
      {/* 顶部 header ── Mac/Win 差分:
            - Mac: h-10 + pl-[90px] 避开红绿灯 + rounded-xl 按钮
            - Win: h-9 (在 OS 标题栏下方, 仅做内部 UI) + rounded-lg 按钮
          两者都整块作为窗口拖动区 (data-tauri-drag-region)。 */}
      {isWindowsPlatform() ? (
        <NoteNavigationPanelHeaderWin
          onTogglePanel={onTogglePanel}
          onOpenPreferences={onOpenPreferences}
        />
      ) : (
        <NoteNavigationPanelHeaderMac onTogglePanel={onTogglePanel} />
      )}

      {/* 笔记本列表 ── max-h 320px 固定顶部, 达到上限内部滚动; 标签列表占剩余高度独立滚动。 */}
      <NotebookList
        notebooks={notebooks}
        selectedNotebook={selectedNotebook}
        onSelectNotebook={onSelectNotebook}
        onEditNotebook={onEditNotebook}
        onDeleteNotebook={onDeleteNotebook}
        onCreateNotebook={onCreateNotebook}
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <OverlayScrollbar
          className="min-h-0 flex-1"
          scrollerClassName="h-full overflow-y-auto px-2"
          onScroll={(event) => {
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
          }}
        >
          <NavFilterButtons
            totalMemoCount={counts.total}
            todoMemoCount={counts.todo}
            onSelectItem={onTogglePanel}
          />
          <PluginNavItems
            activePluginId={activePluginId}
            onOpenPlugin={onOpenPlugin}
          />
          {/* 待办与标签组之间的分割线 ── my-1 上下各 4px 留白; 下方 4px 与标签组容器 pt-1 (padding, 不与 margin 折叠) 叠加, 分隔线到标签标题实际间距 8px。 */}
          <div className="my-1 border-t border-[var(--muted-foreground)]/30" />
          <TagTree
            selectedNotebook={selectedNotebook}
            onCountsChange={handleCountsChange}
            onSelectTag={() => onTogglePanel()}
          />
          {/* 标签组与资料组之间的分割线 ── my-1 上下各 4px 留白; 下方 4px 与资料组容器 pt-1 (padding, 不与 margin 折叠) 叠加, 分隔线到资料标题实际间距 8px。 */}
          <div className="my-1 border-t border-[var(--muted-foreground)]/30" />

          {/* 选中笔记本的可访问文件夹 (文件) ── 与标签同处一个滚动容器, 文件在标签
              下方。 展示该 notebook 自己的默认 folders (不 fallback 全局), 主空间行
              标角标; 空时显示「添加资料」按钮。 编辑入口走右键菜单
              (设为主空间 / 取消主空间 / 删除); 显式取消主空间后 effectiveWorkspace
              fallback 到 notebook.path。 */}
          <NotebookAccessFilesList
            notebook={selectedNotebook ?? undefined}
            onOpenFile={() => onTogglePanel()}
          />
        </OverlayScrollbar>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-3 bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_3%,transparent)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </div>
  );
}
