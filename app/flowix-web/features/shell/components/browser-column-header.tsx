import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Code2, FileText, FilePlus2, Folder, Globe, MessageCirclePlus, X } from 'lucide-react';
import { NotebookTreeFileIcon } from '@features/memo/public/shell-api';
import {
  canMoveBrowserColumnTargetToWorkColumn,
  type BrowserColumnTab,
} from '@features/workspace/public/browser-column-api';
import {
  AgentThreadCardFullscreenExitButton,
  useDocumentEditorMode,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/public/shell-api';
import { AgentIcon } from '@features/agent/public/shell-api';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { BrowserColumnSurfaceChrome } from '@features/surface/public/shell-api';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { DEFAULT_AGENT_TYPE_KEY } from '@/lib/agent-types';
import { WORK_COLUMN_TITLEBAR_GRADIENT } from './work-column-titlebar-shell';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@shared/ui/context-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { documentIdentityFromFile } from '@features/document/public/shell-api';
import { requireFileDisplayIdentity } from '@/lib/file-display-registry';
import { AGENT_TYPES, isAgentTypeSelectable, isAlwaysVisibleNewConversationAgent } from '@/lib/agent-types';
import { useAgentRuntimeStore } from '@features/agent/store/agent-runtime-store';
import { isAgentRuntimeInstalledState, normalizeAgentRuntimeStatus } from '@features/agent/runtime/agent-runtime-status';
import type { AgentTypeKey } from '@/types/agent';

function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined'
    && (/Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform));
}

function tabIcon(tab: BrowserColumnTab, agentTypeKey = DEFAULT_AGENT_TYPE_KEY) {
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
  if (tab.target.kind === 'file-browser' && !tab.target.activeFilePath) return <Folder className="h-3.5 w-3.5" />;
  if (tab.target.kind === 'agent_conversation') {
    return <AgentIcon typeKey={agentTypeKey} alt="" className="h-3.5 w-3.5" />;
  }
  if (tab.target.kind === 'web') return <Globe className="h-3.5 w-3.5" />;
  if (tab.target.kind === 'file-browser' && tab.target.activeFilePath?.toLowerCase().endsWith('.md'))
    return <NotebookTreeFileIcon className="h-4 w-4" />;
  return <FileText className="h-3.5 w-3.5" />;
}

function MemoEditorModeContextMenuItem({
  filePath,
  onToggle,
}: {
  filePath: string;
  onToggle: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const editorMode = useDocumentEditorMode(
    'browser-column',
    documentIdentityFromFile(requireFileDisplayIdentity(filePath)),
  );

  return (
    <ContextMenuItem
      onClick={() => { void onToggle(); }}
      className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
    >
      <Code2 className="mr-2 h-4 w-4" />
      <span className="leading-5">
        {editorMode === 'source'
          ? t('document.action.richTextMode')
          : t('document.action.sourceMode')}
      </span>
    </ContextMenuItem>
  );
}

export interface BrowserColumnHeaderProps {
  tabs: BrowserColumnTab[];
  activeTabId: string | null;
  activeSurfaceChrome: BrowserColumnSurfaceChrome;
  onSelectTab: (tabId: string) => void | boolean | null | Promise<void | boolean | null>;
  onCloseTab: (tabId: string) => void | Promise<void>;
  onCloseOtherTabs: (tabId: string) => void | Promise<void>;
  onCloseTabsToRight: (tabId: string) => void | Promise<void>;
  onCloseAllTabs: () => void | Promise<void>;
  onToggleMemoEditorMode: (tabId: string) => void | Promise<void>;
  onOpenTabInWorkColumn: (tabId: string) => void | Promise<void>;
  onReorderTab: (tabId: string, beforeTabId: string | null) => void;
  isTabMenuOpen: boolean;
  onTabMenuOpenChange: (open: boolean) => void;
  onCloseColumn?: () => void;
  onContextMenuOpenChange: (tabId: string, open: boolean) => void;
  isFocused: boolean;
  canCreate: boolean;
  onCreateNote: () => void;
  onCreateAgentConversation: (typeKey: AgentTypeKey) => void;
}

export function BrowserColumnHeader({
  tabs,
  activeTabId,
  activeSurfaceChrome,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onToggleMemoEditorMode,
  onOpenTabInWorkColumn,
  onReorderTab,
  isTabMenuOpen,
  onTabMenuOpenChange,
  onCloseColumn = () => {},
  onContextMenuOpenChange,
  isFocused,
  canCreate,
  onCreateNote,
  onCreateAgentConversation,
}: BrowserColumnHeaderProps) {
  const { t } = useI18n();
  const [agentTypeMenuAnchor, setAgentTypeMenuAnchor] = useState<{ left: number; top: number } | null>(null);
  const agentRuntimeStatusByType = useAgentRuntimeStore((state) => state.statusByType);
  const agentRuntimeIsChecking = useAgentRuntimeStore((state) => state.isChecking);
  const conversationInstances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const refreshAgentRuntimeIfStale = useAgentRuntimeStore((state) => state.refreshIfStale);
  const newConversationAgentTypes = useMemo(() => AGENT_TYPES.filter((type) => {
    if (!isAgentTypeSelectable(type.key)) return false;
    if (isAlwaysVisibleNewConversationAgent(type.key)) return true;
    return isAgentRuntimeInstalledState(normalizeAgentRuntimeStatus(
      agentRuntimeStatusByType[type.key],
      agentRuntimeIsChecking,
    ));
  }), [agentRuntimeIsChecking, agentRuntimeStatusByType]);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const selectionRequest = useRef(0);
  const activeTabIdRef = useRef(activeTabId);
  const [pendingActiveTabId, setPendingActiveTabId] = useState<string | null>(null);
  activeTabIdRef.current = activeTabId;
  const displayedActiveTabId = pendingActiveTabId ?? activeTabId;

  useEffect(() => {
    if (pendingActiveTabId === activeTabId || (pendingActiveTabId && !tabs.some((tab) => tab.id === pendingActiveTabId))) {
      setPendingActiveTabId(null);
    }
  }, [activeTabId, pendingActiveTabId, tabs]);

  const selectTab = async (tabId: string) => {
    const request = ++selectionRequest.current;
    // The active-tab chrome must reach the DOM before navigation can mount and
    // parse a large document on the main thread.
    flushSync(() => setPendingActiveTabId(tabId));
    let succeeded = false;
    try {
      const result = await onSelectTab(tabId);
      succeeded = result !== false && result !== null;
    } catch {
      // Keep the current document and recover focus just as for a rejected save.
    }
    if (succeeded || request !== selectionRequest.current || tabButtons.current.size === 0) return;
    setPendingActiveTabId(null);
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
  // A fullscreen Thread Card keeps its DOM position inside this column, so the
  // host-scoped info hook only fires for cards mounted in the browser column —
  // work-column fullscreen never reaches this header.
  const fullscreenInfo = useFullscreenAgentThreadCardInfo('browser-column');
  const isAgentSurface = activeSurfaceChrome === 'agent' || Boolean(fullscreenInfo);
  const isMediaSurface = activeSurfaceChrome === 'media';

  const tabLabel = (tab: BrowserColumnTab) => {
    if (tab.target.kind !== 'agent_conversation') return tab.title;
    const title = conversationInstances[tab.target.instanceId]?.title.trim();
    return title || tab.title;
  };
  const tabAgentTypeKey = (tab: BrowserColumnTab) => tab.target.kind === 'agent_conversation'
    ? conversationInstances[tab.target.instanceId]?.agentType ?? DEFAULT_AGENT_TYPE_KEY
    : DEFAULT_AGENT_TYPE_KEY;

  useEffect(() => {
    if (displayedActiveTabId) {
      tabButtons.current.get(displayedActiveTabId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [displayedActiveTabId]);

  useEffect(() => {
    if (agentTypeMenuAnchor) void refreshAgentRuntimeIfStale();
  }, [agentTypeMenuAnchor, refreshAgentRuntimeIfStale]);

  const openAgentTypeMenu = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setAgentTypeMenuAnchor({ left: rect.right + 2, top: rect.top });
  };

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
        isAgentSurface && 'agent-surface-titlebar',
        isMediaSurface && 'media-surface-titlebar',
      )}
      // Keep the tab strip visually continuous with the work-column titlebar.
      // The tabs themselves stay transparent so this fade remains visible
      // behind active and inactive tabs alike.
      style={isAgentSurface || isMediaSurface ? undefined : { backgroundImage: WORK_COLUMN_TITLEBAR_GRADIENT }}
    >
      <button
        type="button"
        aria-label={t('tabWindow.closeColumn')}
        title={t('tabWindow.closeColumn')}
        onClick={onCloseColumn}
        className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <div
        role="tablist"
        aria-label={t('tabWindow.openContent')}
        data-tauri-drag-region
        className="flex h-10 min-h-10 min-w-0 flex-1 items-center gap-0 overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === displayedActiveTabId;
          const moveUnavailableReason = tab.target.kind === 'web'
            ? t('tabWindow.context.moveWebUnavailable')
            : tab.target.kind === 'file-browser' && !tab.target.activeFilePath
              ? t('tabWindow.context.moveFolderUnavailable')
              : null;
          // 仅激活 tab 会挂载内容，全屏卡片必然在其中 ── 全屏期间激活
          // tab 换成 Agent 图标 + 对话标题，退出后回退 tab 自身标题。
          const tabFullscreen = tab.id === activeTabId && fullscreenInfo
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
                    'group relative flex h-8 min-w-[96px] max-w-[150px] shrink basis-[150px] select-none items-center border text-xs transition-[color,opacity] [-webkit-app-region:no-drag]',
                    selected && isFocused
                      ? 'browser-column-tab-active rounded-t-xl border-[var(--border)] border-b-transparent text-[var(--foreground)] shadow-[0_-1px_4px_-3px_rgb(0_0_0_/_0.08)]'
                      : selected
                        ? 'browser-column-tab-active rounded-t-xl border-[var(--border)] border-b-transparent text-[var(--foreground)] shadow-[0_-1px_4px_-3px_rgb(0_0_0_/_0.08)]'
                        : 'rounded-lg border-transparent bg-transparent text-[var(--muted-foreground)] shadow-none hover:text-[var(--foreground)]',
                    draggedTabId === tab.id && 'opacity-45',
                  )}
                >
              {selected && isFocused && (
                <span
                  key={`${tab.id}-${activeTabId}-${isFocused ? 'focused' : 'unfocused'}`}
                  aria-hidden="true"
                  className="browser-column-active-tab-indicator pointer-events-none absolute left-[5%] right-[5%] top-0 h-px"
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
                title={tabFullscreen?.title ?? tabLabel(tab)}
                draggable={false}
                onClick={() => { void selectTab(tab.id); }}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="min-w-0 flex-1 cursor-default select-none truncate py-2 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
              >
                {tabFullscreen ? (
                  <span className="flex min-w-0 items-center">
                    <AgentIcon
                      typeKey={tabFullscreen.typeKey}
                      alt=""
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{tabFullscreen.title}</span>
                  </span>
                ) : (
                  <span className="flex min-w-0 items-center">
                    <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {tabIcon(tab, tabAgentTypeKey(tab))}
                    </span>
                    <span className="min-w-0 truncate">{tabLabel(tab)}</span>
                  </span>
                )}
              </button>
              <button
                type="button"
                draggable={false}
                data-tab-close
                onClick={() => onCloseTab(tab.id)}
                className={cn(
                  'flex h-5 shrink-0 cursor-default items-center justify-center hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]',
                  selected
                    ? 'mr-[0.25rem] w-5 opacity-60'
                    : 'pointer-events-none mr-0 w-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-150 group-hover:pointer-events-auto group-hover:mr-[0.25rem] group-hover:w-5 group-hover:opacity-60',
                )}
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
                {tab.target.kind === 'file-browser' && tab.target.activeFilePath && /\.md$/i.test(tab.target.activeFilePath) && (
                  <MemoEditorModeContextMenuItem
                    filePath={tab.target.activeFilePath}
                    onToggle={() => onToggleMemoEditorMode(tab.id)}
                  />
                )}
                <div
                  role="separator"
                  aria-hidden="true"
                  className={POPUP_SEPARATOR_CLASS}
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
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              data-tauri-drag-region
              aria-hidden="true"
              className="h-8 min-w-2 flex-1 self-stretch [-webkit-app-region:no-drag]"
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-[180px] space-y-0.5 rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
            <ContextMenuItem
              disabled={!canCreate}
              onClick={onCreateNote}
              className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <FilePlus2 className="mr-2 h-4 w-4" />
              <span className="leading-5">{t('tabWindow.context.newNote')}</span>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canCreate}
              onClick={openAgentTypeMenu}
              className="h-7 items-center justify-start gap-0 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <MessageCirclePlus className="mr-2 h-4 w-4" />
              <span className="flex-1 leading-5">{t('tabWindow.context.newConversation')}</span>
              <ChevronRight className="ml-2 h-3.5 w-3.5" />
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
      <DropdownMenu
        open={agentTypeMenuAnchor !== null}
        onOpenChange={(open) => { if (!open) setAgentTypeMenuAnchor(null); }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="pointer-events-none fixed h-px w-px opacity-0"
            style={agentTypeMenuAnchor ?? { left: -100, top: -100 }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={0}
          className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
        >
          <DropdownMenuLabel className="flex items-center gap-1.5 px-[0.375rem] pb-[0.35rem] pt-[0.35rem] text-xs font-normal leading-[1.2] text-[var(--muted-foreground)]">
            {t('tabWindow.context.newConversation')}
          </DropdownMenuLabel>
          {newConversationAgentTypes.map((type) => {
            const status = normalizeAgentRuntimeStatus(
              agentRuntimeStatusByType[type.key],
              agentRuntimeIsChecking,
            );
            const showNotInstalled = isAlwaysVisibleNewConversationAgent(type.key)
              && status.state === 'not-installed';
            const name = type.nameKey
              ? t(type.nameKey as Parameters<typeof t>[0])
              : type.name;
            return (
              <DropdownMenuItem
                key={type.key}
                onClick={() => {
                  setAgentTypeMenuAnchor(null);
                  onCreateAgentConversation(type.key);
                }}
                className="agent-conversation-new-agent-item group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
              >
                <AgentIcon typeKey={type.key} alt="" className="h-4 w-4 shrink-0 object-contain" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {showNotInstalled && (
                  <span className="shrink-0 text-xs text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]">
                    {t('agent.status.notInstalled')}
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
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
                  const selected = tab.id === displayedActiveTabId;
                  return (
                    <DropdownMenuItem
                      key={tab.id}
                      title={tabLabel(tab)}
                      onClick={() => { void selectTab(tab.id); }}
                      className="group h-7 gap-1 rounded-lg px-2 py-0 hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)] group-hover:text-[var(--primary-foreground)]">
                        {tabIcon(tab, tabAgentTypeKey(tab))}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-left">{tabLabel(tab)}</span>
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
