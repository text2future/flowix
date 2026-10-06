'use client';

import { useCallback, useState } from 'react';

import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { NoteNavigationPanelHeaderMac } from '@features/memo/components/note-navigation-panel-header-mac';
import { NoteNavigationPanelHeaderWin } from '@features/memo/components/note-navigation-panel-header-win';
import { NavFilterButtons } from '@features/memo/components/nav-filter-buttons';
import { TagTree } from '@features/memo/components/tag-tree';
import { type Notebook } from '@features/memo/store/note-store';
import { cn } from '@/lib/utils';
import { isWindowsPlatform } from '@/lib/shortcuts/platform';
import { PluginNavItems } from '@features/plugin/public/shell-api';
import type { PluginDescriptor } from '@platform/tauri/client';

interface NoteNavigationPanelProps {
  selectedNotebook: Notebook | null;
  onTogglePanel: () => void;
  onOpenPreferences: (tab?: string) => void;
  activePluginId: string | null;
  onOpenPlugin: (plugin: PluginDescriptor) => void | Promise<void>;
  /** Lets an overlay owner provide the panel surface (for translucent drawers). */
  transparentSurface?: boolean;
}

interface NavCounts {
  total: number;
  todo: number;
}

// 导航栏 ── 最左侧导航区域的组合根。笔记本切换和仓库列表不在此抽屉展示。
//   - TagTree               标签树 (拖拽重排 + reparent + 行内重命名 + 删除)
// 本组件只负责布局编排。筛选项和筛选管理入口不放在导航抽屉中。
export function NoteNavigationPanel({
  selectedNotebook,
  onTogglePanel,
  onOpenPreferences,
  activePluginId,
  onOpenPlugin,
  transparentSurface = false,
}: NoteNavigationPanelProps) {
  const [counts, setCounts] = useState<NavCounts>({ total: 0, todo: 0 });
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

      <div className="relative flex min-h-0 flex-1 flex-col">
        <OverlayScrollbar
          className="min-h-0 flex-1"
          scrollerClassName="h-full overflow-y-auto px-2"
          onScroll={(event) => {
            setShowScrollTopHint(event.currentTarget.scrollTop > 0);
          }}
        >
          <div className="flex min-h-full flex-col">
            {/* 筛选器、插件和标签共用同一个滚动容器。 */}
            <NavFilterButtons
              totalMemoCount={counts.total}
              todoMemoCount={counts.todo}
              onSelectItem={onTogglePanel}
            />
            <PluginNavItems
              activePluginId={activePluginId}
              onOpenPlugin={onOpenPlugin}
            />
            <TagTree
              selectedNotebook={selectedNotebook}
              onCountsChange={handleCountsChange}
              onSelectTag={() => onTogglePanel()}
            />
          </div>
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
