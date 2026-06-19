'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SidebarToggleIcon } from '../../../components/icons/sidebar-toggle-icon';
import { Tooltip } from '../../../components/ui/tooltip';
import type { MemoColor, MemoItem } from '../../../lib/store';
import {
  type DocumentState,
  ExternalCopyButton,
  ExternalPathDisplay,
  ExternalSaveButton,
  MemoActions,
} from './document-titlebar-shared';

interface DocumentTitlebarWinProps {
  currentMemo: MemoItem | null;
  isSidebarHidden: boolean;
  isAgentPanelVisible: boolean;
  onToggleSidebar: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onOpenSearch: () => void;
  onCopyLink: () => void;
  onCopyFullText: () => void;
  onTogglePin: () => void;
  onExportMarkdown: () => void;
  onExportWord: () => void;
  onRequestDeleteMemo: () => void;
  onColorsChange?: (next: MemoColor[]) => void;
  externalFilePath?: string | null;
  isExternalSaving?: boolean;
  onSaveExternalToMemo?: () => void;
  onCopyExternalPath?: () => void;
}

const ICON_BTN =
  'w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-colors';
const SAVE_BTN =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-60';

export function DocumentTitlebarWin({
  currentMemo,
  isSidebarHidden,
  isAgentPanelVisible,
  onToggleSidebar,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
  onOpenSearch,
  onCopyLink,
  onCopyFullText,
  onTogglePin,
  onExportMarkdown,
  onExportWord,
  onRequestDeleteMemo,
  onColorsChange,
  externalFilePath = null,
  isExternalSaving = false,
  onSaveExternalToMemo,
  onCopyExternalPath,
}: DocumentTitlebarWinProps) {
  const documentState: DocumentState = currentMemo
    ? 'memo'
    : externalFilePath
      ? 'external'
      : 'empty';

  return (
    <div
      data-tauri-drag-region
      className={`h-9 shrink-0 pl-2 z-[50] flex items-center ${isAgentPanelVisible ? 'pr-0' : 'pr-[126px]'}`}
      style={{ backgroundImage: 'linear-gradient(to bottom, var(--bg-titlebar), transparent)' }}
    >
      <div className="flex shrink-0 items-center gap-1">
        {isSidebarHidden && (
          <Tooltip content="显示侧栏">
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label="显示侧栏"
              className="w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-[opacity,transform,color] duration-[400ms] animate-in fade-in zoom-in-95"
            >
              <SidebarToggleIcon className="w-4 h-4" variant="collapsed" />
            </button>
          </Tooltip>
        )}
        <Tooltip content="后退" shortcut="history.back">
          <button
            type="button"
            onClick={onNavigateBack}
            disabled={!canNavigateBack}
            aria-label="后退"
            className={`${ICON_BTN} disabled:pointer-events-none disabled:opacity-35`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content="前进" shortcut="history.forward">
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!canNavigateForward}
            aria-label="前进"
            className={`${ICON_BTN} disabled:pointer-events-none disabled:opacity-35`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {documentState === 'external' && externalFilePath && (
        <ExternalPathDisplay path={externalFilePath} />
      )}

      <div className="ml-auto flex shrink-0 items-center gap-2 pr-2">
        {documentState === 'memo' && currentMemo && (
          <MemoActions
            memo={currentMemo}
            iconButtonClass={ICON_BTN}
            onOpenSearch={onOpenSearch}
            onCopyLink={onCopyLink}
            onCopyFullText={onCopyFullText}
            onTogglePin={onTogglePin}
            onExportMarkdown={onExportMarkdown}
            onExportWord={onExportWord}
            onRequestDeleteMemo={onRequestDeleteMemo}
            onColorsChange={onColorsChange ?? (() => {})}
          />
        )}
        {documentState === 'external' && externalFilePath && onSaveExternalToMemo && (
          <>
            {onCopyExternalPath && (
              <ExternalCopyButton
                onCopy={onCopyExternalPath}
                iconButtonClass={ICON_BTN}
              />
            )}
            <ExternalSaveButton
              isSaving={isExternalSaving}
              onSave={onSaveExternalToMemo}
              className={SAVE_BTN}
            />
          </>
        )}
      </div>
    </div>
  );
}
