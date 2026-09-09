import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Blocks, Check, ChevronDown, FileText, Folder, Globe, MessageSquare, X } from 'lucide-react';
import { canMoveBrowserColumnTargetToWorkColumn, type BrowserColumnTab } from '@features/workspace/store/browser-column-store';
import {
  AgentThreadCardFullscreenExitButton,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/components/document-titlebar-shared';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { WORK_COLUMN_TITLEBAR_GRADIENT } from './work-column-titlebar-shell';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined'
    && (/Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform));
}

function tabIcon(tab: BrowserColumnTab) {
  if (tab.icon?.startsWith('http://') || tab.icon?.startsWith('https://')) {
    return (
      <span className="relative flex h-4 w-4 items-center justify-center">
        <Globe className="h-3.5 w-3.5" />
        <img
          src={tab.icon}
          alt=""
          className="absolute h-3.5 w-3.5 rounded-sm"
          onError={(event) => { event.currentTarget.style.display = 'none'; }}
        />
      </span>
    );
  }
  if (tab.icon) return <span className="text-sm leading-none">{tab.icon}</span>;
  if (tab.target.kind === 'artifact') return <Blocks className="h-3.5 w-3.5" />;
  if (tab.target.kind === 'file-browser' && !tab.target.activeFilePath) return <Folder className="h-3.5 w-3.5" />;
  if (tab.target.kind === 'agent_conversation') return <MessageSquare className="h-3.5 w-3.5" />;
  if (tab.target.kind === 'web') return <Globe className="h-3.5 w-3.5" />;
  return <FileText className="h-3.5 w-3.5" />;
}

export interface BrowserColumnHeaderProps {
  tabs: BrowserColumnTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void | boolean | null | Promise<void | boolean | null>;
  onCloseTab: (tabId: string) => void | Promise<void>;
  onCloseOtherTabs: (tabId: string) => void | Promise<void>;
  onCloseTabsToRight: (tabId: string) => void | Promise<void>;
  onCloseAllTabs: () => void | Promise<void>;
  onOpenTabInWorkColumn: (tabId: string) => void | Promise<void>;
  onReorderTab: (tabId: string, beforeTabId: string | null) => void;
  isTabMenuOpen: boolean;
  onTabMenuOpenChange: (open: boolean) => void;
  onContextMenuOpenChange: (tabId: string, open: boolean) => void;
}

export function BrowserColumnHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onOpenTabInWorkColumn,
  onReorderTab,
  isTabMenuOpen,
  onTabMenuOpenChange,
  onContextMenuOpenChange,
}: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectionRequest = useRef(0);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const selectTab = async (tabId: string) => {
    const request = ++selectionRequest.current;
    let succeeded = false;
    try {
      const result = await onSelectTab(tabId);
      succeeded = result !== false && result !== null;
    } catch {
      // Keep the current document and recover focus just as for a rejected save.
    }
    if (succeeded || request !== selectionRequest.current || tabButtons.current.size === 0) return;
    const activeButton = activeTabIdRef.current
      ? tabButtons.current.get(activeTabIdRef.current)
      : undefined;
    // Never steal focus if the user has moved into an editor or another control.
    if (document.activeElement === tabButtons.current.get(tabId)) {
      activeButton?.focus();
      activeButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    toast.error(t('tabWindow.switchFailed'));
  };
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const isWindows = isWindowsPlatform();
  const isFocused = useWorkspaceFocusStore((state) => state.focusedHostId === 'browser-column');
  // A fullscreen Thread Card keeps its DOM position inside this column, so the
  // host-scoped info hook only fires for cards mounted in the browser column —
  // work-column fullscreen never reaches this header.
  const fullscreenInfo = useFullscreenAgentThreadCardInfo('browser-column');

  useEffect(() => {
    if (activeTabId) tabButtons.current.get(activeTabId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = Math.min(index + 1, tabs.length - 1);
    else if (event.key === 'ArrowLeft') nextIndex = Math.max(index - 1, 0);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    const button = tabButtons.current.get(nextTab.id);
    button?.focus();
    button?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    void selectTab(nextTab.id);
  };

  return (
    <header
      data-browser-column-header
      data-tauri-drag-region
      data-thread-card-fullscreen={fullscreenInfo ? '' : undefined}
      className={cn(
        'relative flex shrink-0 items-center pl-1 pr-2',
        isWindows ? 'h-9 min-h-9 pr-[126px]' : 'h-12 min-h-12',
        fullscreenInfo && 'agent-thread-card-fullscreen-titlebar',
      )}
      // Keep the tab strip visually continuous with the work-column titlebar.
      // The tabs themselves stay transparent so this fade remains visible
      // behind active and inactive tabs alike.
      style={fullscreenInfo ? undefined : { backgroundImage: WORK_COLUMN_TITLEBAR_GRADIENT }}
    >
      <div
        role="tablist"
        aria-label={t('tabWindow.openContent')}
        data-tauri-drag-region
        className="flex h-10 min-h-10 min-w-0 flex-1 items-center gap-0 overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeTabId;
          const moveUnavailableReason = tab.target.kind === 'web'
            ? t('tabWindow.context.moveWebUnavailable')
            : tab.target.kind === 'file-browser' && !tab.target.activeFilePath
              ? t('tabWindow.context.moveFolderUnavailable')
              : null;
          // 仅激活 tab 会挂载内容，全屏卡片必然在其中 ── 全屏期间激活
          // tab 换成 Agent 图标 + 对话标题，退出后回退 tab 自身标题。
          const tabFullscreen = selected && fullscreenInfo
            ? { title: fullscreenInfo.title || tab.title, typeKey: fullscreenInfo.typeKey }
            : null;
          return (
            <ContextMenu
              key={tab.id}
              onOpenChange={(open) => onContextMenuOpenChange(tab.id, open)}
            >
              <ContextMenuTrigger asChild>
                <div
                  draggable
                  onDragStart={(event: DragEvent<HTMLDivElement>) => {
                    if ((event.target as HTMLElement).closest('[data-tab-close]')) {
                      event.preventDefault();
                      return;
                    }
                    setDraggedTabId(tab.id);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', tab.id);
                  }}
                  onDragEnd={() => setDraggedTabId(null)}
                  onDragOver={(event) => {
                    if (!draggedTabId || draggedTabId === tab.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const sourceTabId = draggedTabId ?? event.dataTransfer.getData('text/plain');
                    if (sourceTabId && sourceTabId !== tab.id) onReorderTab(sourceTabId, tab.id);
                    setDraggedTabId(null);
                  }}
                  className={cn(
                    'group relative flex h-8 min-w-[96px] max-w-[150px] shrink basis-[150px] select-none items-center overflow-hidden border text-xs transition-[color,background-color,border-color,opacity] [-webkit-app-region:no-drag]',
                    selected && isFocused
                      ? 'rounded-t-xl border-[var(--border)] border-b-transparent bg-transparent text-[var(--foreground)] shadow-[0_-1px_6px_-3px_rgb(0_0_0_/_0.20)]'
                      : selected
                        ? 'rounded-t-xl border-[var(--border)] border-b-transparent bg-transparent text-[var(--foreground)] shadow-[0_-1px_6px_-3px_rgb(0_0_0_/_0.20)]'
                        : 'rounded-lg border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
                    draggedTabId === tab.id && 'opacity-45',
                  )}
                >
              {selected && isFocused && (
                <span
                  key={`${tab.id}-${activeTabId}-${isFocused ? 'focused' : 'unfocused'}`}
                  aria-hidden="true"
                  className="browser-column-active-tab-indicator pointer-events-none absolute inset-x-0 top-0 h-px"
                />
              )}
              <button
                type="button"
                role="tab"
                ref={(node) => {
                  if (node) tabButtons.current.set(tab.id, node);
                  else tabButtons.current.delete(tab.id);
                }}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={tabFullscreen?.title ?? tab.title}
                draggable={false}
                onClick={() => { void selectTab(tab.id); }}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="min-w-0 flex-1 cursor-default select-none truncate py-2 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
              >
                {tabFullscreen ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <AgentIcon
                      typeKey={tabFullscreen.typeKey}
                      alt=""
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{tabFullscreen.title}</span>
                  </span>
                ) : (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">{tabIcon(tab)}</span>
                    <span className="min-w-0 truncate">{tab.title}</span>
                  </span>
                )}
              </button>
              <button
                type="button"
                draggable={false}
                data-tab-close
                onClick={() => onCloseTab(tab.id)}
                className="mr-[0.25rem] flex h-5 w-5 shrink-0 cursor-default items-center justify-center opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
                aria-label={t('tabWindow.closeTab', { title: tab.title })}
                title={t('tabWindow.closeTab', { title: tab.title })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
                <ContextMenuItem
                  onClick={() => onCloseTab(tab.id)}
                  className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  <span className="leading-5">{t('tabWindow.context.close')}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={tabs.length <= 1}
                  onClick={() => onCloseOtherTabs(tab.id)}
                  className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  <span className="leading-5">{t('tabWindow.context.closeOther')}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  disabled={index === tabs.length - 1}
                  onClick={() => onCloseTabsToRight(tab.id)}
                  className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  <span className="leading-5">{t('tabWindow.context.closeRight')}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={onCloseAllTabs}
                  className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  <span className="leading-5">{t('tabWindow.context.closeAll')}</span>
                </ContextMenuItem>
                <div
                  role="separator"
                  aria-hidden="true"
                  className="mx-1 my-1 h-px bg-[var(--border-popup)] opacity-60"
                />
                <ContextMenuItem
                  aria-describedby={moveUnavailableReason ? `move-unavailable-${tab.id}` : undefined}
                  disabled={!canMoveBrowserColumnTargetToWorkColumn(tab.target)}
                  onClick={() => onOpenTabInWorkColumn(tab.id)}
                  className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                >
                  <span className="leading-5">{t('tabWindow.context.openInWorkColumn')}</span>
                </ContextMenuItem>
                {moveUnavailableReason && (
                  <p id={`move-unavailable-${tab.id}`} className="px-2 py-1 text-xs leading-5 text-[var(--muted-foreground)]">
                    {moveUnavailableReason}
                  </p>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      {/* 全屏 Thread Card 接管本列内容区时，退出按钮落在浏览器列头部，
          紧邻右侧的下拉按钮左侧，与第三列 titlebar 的 exit 按钮同一组件/样式，
          仅 host 作用域不同。 */}
      <AgentThreadCardFullscreenExitButton
        host="browser-column"
        className="agent-thread-card-fullscreen-exit-btn"
      />
      <div className="h-8 w-8 shrink-0 pr-0.5 [-webkit-app-region:no-drag]">
        <DropdownMenu
          className="[-webkit-app-region:no-drag]"
          open={isTabMenuOpen}
          onOpenChange={onTabMenuOpenChange}
        >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('tabWindow.showAll')}
                title={t('tabWindow.showAll')}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] [-webkit-app-region:no-drag]"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={4}
              className="max-h-[min(420px,calc(100vh-16px))] w-[210px] rounded-xl overflow-y-auto p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
            >
              <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-[var(--muted-foreground)]">
                {t('tabWindow.all')}
              </DropdownMenuLabel>
              <div className="space-y-0.5">
                {tabs.map((tab) => {
                  const selected = tab.id === activeTabId;
                  return (
                    <DropdownMenuItem
                      key={tab.id}
                      title={tab.title}
                      onClick={() => { void selectTab(tab.id); }}
                      className="group h-7 gap-2 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]">
                        {tabIcon(tab)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)] group-hover:text-[var(--primary-foreground)]" />}
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
