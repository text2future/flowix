'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import {
  type DocumentTitlebarProps,
  type DocumentState,
  ExternalTitlebarBadge,
  MemoActions,
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC,
  AgentThreadCardFullscreenExitButton,
  AgentThreadCardFullscreenIdentity,
  useAgentThreadCardFullscreenActive,
} from '@features/document/components/document-titlebar-shared';
import { useI18n } from '@/lib/i18n';
import {
  WORK_COLUMN_TITLEBAR_GRADIENT,
  WorkColumnTitlebarShell,
} from '@features/shell/components/work-column-titlebar-shell';

const NAV_BTN =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-colors';
const ICON_BTN = DOCUMENT_TITLEBAR_ICON_BUTTON_MAC;

export function DocumentTitlebarMac({
  reserveWindowsControls: _reserveWindowsControls = true,
  document: { currentMemo, externalFilePath = null },
  sidebar: {
    hidden: isSidebarHidden,
    noteNavigationVisible,
    onToggle: onToggleSidebar,
    onPreviewTriggerEnter,
    onPreviewTriggerLeave,
  },
  navigation: {
    canNavigateBack,
    canNavigateForward,
    onNavigateBack,
    onNavigateForward,
    visible: showNavigationButtons = true,
  },
  contentCapabilities: {
    search: canSearch,
    properties: canEditProperties,
    copyFullText: canCopyFullText,
    exportContent: canExportContent,
    saveAsTemplate: canSaveAsTemplate,
    versionHistory: canViewVersionHistory,
  },
  actions: {
    onOpenSearch,
    onCopyLink,
    onCopyFullText,
    onOpenProperties,
    onTogglePin,
    onExportMarkdown,
    onSaveAsTemplate,
    onExportWord,
    onRequestDeleteMemo,
    onColorsChange,
  },
}: DocumentTitlebarProps) {
  const { t } = useI18n();
  const isAgentThreadCardFullscreen = useAgentThreadCardFullscreenActive();
  const documentState: DocumentState = currentMemo
    ? 'memo'
    : externalFilePath
      ? 'external'
      : 'empty';

  return (
      <WorkColumnTitlebarShell
      isWindows={false}
      showTrafficLightSpacer={isSidebarHidden && !noteNavigationVisible}
      className={isAgentThreadCardFullscreen ? 'agent-thread-card-fullscreen-titlebar' : ''}
      style={isAgentThreadCardFullscreen ? undefined : { backgroundImage: WORK_COLUMN_TITLEBAR_GRADIENT }}
    >
      <div className="flex shrink-0 items-center gap-1">
        {isSidebarHidden && (
          <>
            <button
              type="button"
              onClick={onToggleSidebar}
              onMouseEnter={onPreviewTriggerEnter}
              onMouseLeave={onPreviewTriggerLeave}
              aria-label={t("document.titlebar.showSidebar")}
              title={t("document.titlebar.showSidebarTooltip")}
              className="w-5 h-5 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-xl transition-colors"
            >
              <SidebarToggleIcon className="w-5 h-5" variant="collapsed" />
            </button>
          </>
        )}
        {showNavigationButtons && (
          <>
            <Tooltip content={t("document.titlebar.backTooltip")} shortcut="history.back">
              <button
                type="button"
                onClick={onNavigateBack}
                disabled={!canNavigateBack}
                aria-label={t("document.titlebar.back")}
                className={`${NAV_BTN} disabled:opacity-35`}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content={t("document.titlebar.forwardTooltip")} shortcut="history.forward">
              <button
                type="button"
                onClick={onNavigateForward}
                disabled={!canNavigateForward}
                aria-label={t("document.titlebar.forward")}
                className={`${NAV_BTN} disabled:opacity-35`}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      <AgentThreadCardFullscreenIdentity />

      <div
        data-tauri-drag-region
        className="ml-auto flex shrink-0 items-center gap-3 pr-3"
      >
        <AgentThreadCardFullscreenExitButton className="agent-thread-card-fullscreen-exit-btn" />
        {documentState === 'external' && (
          <ExternalTitlebarBadge />
        )}
        {documentState === 'memo' && currentMemo && (
          <MemoActions
            memo={currentMemo}
            iconButtonClass={ICON_BTN}
            onOpenSearch={onOpenSearch}
            onCopyLink={onCopyLink}
            onCopyFullText={onCopyFullText}
            onOpenProperties={onOpenProperties}
            onTogglePin={onTogglePin}
            onExportMarkdown={onExportMarkdown}
            onSaveAsTemplate={onSaveAsTemplate}
            onExportWord={onExportWord}
            onRequestDeleteMemo={onRequestDeleteMemo}
            onColorsChange={onColorsChange ?? (() => {})}
            canSearch={canSearch}
            canEditProperties={canEditProperties}
            canCopyFullText={canCopyFullText}
            canExportContent={canExportContent}
            canSaveAsTemplate={canSaveAsTemplate}
            canViewVersionHistory={canViewVersionHistory}
          />
        )}
      </div>
      </WorkColumnTitlebarShell>
  );
}
