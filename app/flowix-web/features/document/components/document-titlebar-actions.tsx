import { useState } from 'react';
import { isHtmlFilePath } from '@features/content/public/content-api';
import { Check, Code2, Ellipsis } from 'lucide-react';
import { LinkSimpleIcon, CopyIcon, FolderOpenIcon, FileMdIcon, FileDocIcon, FilePdfIcon, ClockIcon, MapPinSimpleAreaIcon, TrashSimpleIcon, SwatchesIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@shared/ui/dropdown-menu';
import { POPUP_SEPARATOR_CLASS } from '@shared/ui/popup-separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@shared/ui/dialog';
import { FontSizeSwitcher } from '@shared/ui/font-size-switcher';
import { FolderCollectionSwitchConfirmDialog } from '@features/collection/public/folder-api';
import { CollectionDisplayMenuItems } from '@features/collection/public/title-api';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { EditorFontSwitcher } from './editor-font-switcher';
import { NoteColorPicker } from './document-titlebar-controls';
import { VersionHistorySubmenu, formatVersionTime } from './document-version-history-menu';
import { useDocumentTitlebarActions } from './use-document-titlebar-actions';
import type { DocumentTitlebarProps, DocumentTitlebarTarget } from './document-titlebar-model';
import type { DocumentEditorMode } from '@features/document/store/document-editor-view-store';

export function DocumentTitlebarActions({
  target,
  iconButtonClass,
  capabilities,
  actions,
  folderCollectionViewType,
  collectionDisplayIndexPath,
  showEditorFontSwitcher = false,
  showEditorModeToggle = false,
  editorMode = 'rich',
  onSetEditorMode,
  visible = true,
  showColorPicker = true,
}: {
  target: DocumentTitlebarTarget;
  iconButtonClass: string;
  capabilities: DocumentTitlebarProps['contentCapabilities'];
  actions: DocumentTitlebarProps['actions'];
  folderCollectionViewType?: DocumentTitlebarProps['folderCollectionViewType'];
  collectionDisplayIndexPath?: string;
  showEditorFontSwitcher?: boolean;
  showEditorModeToggle?: boolean;
  editorMode?: DocumentEditorMode;
  onSetEditorMode?: (mode: DocumentEditorMode) => void;
  visible?: boolean;
  showColorPicker?: boolean;
}) {
  const {
    copyFullText: canCopyFullText, memoColors: canEditColors, exportContent: canExportContent,
    saveAsTemplate: canSaveAsTemplate, versionHistory: canViewVersionHistory,
  } = capabilities;
  const {
    onCopyLink: onCopyPath, onCopyFullText, onExportMarkdown, onExportWord,
    onExportPdf, onSaveAsTemplate, onDeleteExternalFile,
  } = actions;
  const { t, language } = useI18n();
  const {
    colors, changeColors, fontSwitch, selectedFontSizeMode, setEditorFontSizeMode,
    confirmVersion, setConfirmVersion, restoringVersionId, versionRefreshKey,
    archiveVersion, restorePathVersion, copyFolderPath, revealFile,
  } = useDocumentTitlebarActions(target);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingViewType, setPendingViewType] = useState<'table' | 'media_library' | null>(null);
  const filePath = target.fileIdentity.path;
  const indexable = target.indexable;
  const hideDeleteAction = Boolean(folderCollectionViewType || target.isOutsideCurrentNotebook);
  const itemClass = 'group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]';
  const handleCopyPath = () => folderCollectionViewType || target.isOutsideCurrentNotebook
    ? copyFolderPath() : onCopyPath();

  if (!visible) return null;

  return (
    <>
    {showColorPicker && canEditColors && (
      <NoteColorPicker colors={colors} iconButtonClass={iconButtonClass}
        onChange={changeColors} />
    )}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={iconButtonClass}
          aria-label={t('document.titlebar.moreTooltip')}
          title={t('document.titlebar.moreTooltip')}
        >
          <Ellipsis className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px] space-y-0.5 rounded-xl border-[var(--border-popup)] p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]">
        {collectionDisplayIndexPath && <>
          <CollectionDisplayMenuItems indexPath={collectionDisplayIndexPath} />
          <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
        </>}
        {folderCollectionViewType ? (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1 text-xs font-normal uppercase tracking-wider text-[var(--muted-foreground)]">
              <span>内容偏好</span>
              <span className="inline-flex items-center gap-1 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] normal-case tracking-normal">
                文件夹
              </span>
            </div>
            {([['table', '展示笔记'], ['media_library', '展示图/视频']] as const).map(([type, label]) => (
              <DropdownMenuItem key={type} onClick={() => { if (type !== folderCollectionViewType.current) setPendingViewType(type); }} className={itemClass}>
                <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
                  {folderCollectionViewType.current === type && <Check className="h-4 w-4 text-[var(--brand)]" />}
                </span>
                <span className="flex-1">{label}</span>
              </DropdownMenuItem>
            ))}
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
          </>
        ) : showEditorFontSwitcher ? <>
          <EditorFontSwitcher
            fontMode={fontSwitch.fontMode}
            downloadingMode={fontSwitch.downloadingMode}
            onSelect={fontSwitch.selectFontMode}
          />
          <FontSizeSwitcher sizeMode={selectedFontSizeMode} onSelect={setEditorFontSizeMode} />
        </> : null}
        <DropdownMenuItem onClick={() => void handleCopyPath()} className={itemClass}>
          <LinkSimpleIcon className="h-4 w-4" /> {t('memo.fileTree.copyPath')}
        </DropdownMenuItem>
        {canCopyFullText && (
          <DropdownMenuItem onClick={onCopyFullText} className={itemClass}>
            <CopyIcon className="h-4 w-4" /> {t('document.action.copyFullText')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => { void revealFile(); }}
          className={itemClass}
        >
          <FolderOpenIcon className="h-4 w-4" /> {t('document.file.reveal')}
        </DropdownMenuItem>
        {showEditorModeToggle && (
          <DropdownMenuItem
            onClick={() => onSetEditorMode?.(editorMode === 'source' ? 'rich' : 'source')}
            className={itemClass}
          >
            <Code2 className="h-4 w-4" />
            {t(editorMode === 'source'
              ? isHtmlFilePath(filePath) ? 'htmlResource.previewMode' : 'document.action.richTextMode'
              : 'document.action.sourceMode')}
          </DropdownMenuItem>
        )}
        {(canSaveAsTemplate || canExportContent) && (
          <>
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
            {canSaveAsTemplate && (
              <DropdownMenuItem onClick={onSaveAsTemplate} className={itemClass}>
                <SwatchesIcon className="h-4 w-4" /> {t('document.action.saveAsTemplate')}
              </DropdownMenuItem>
            )}
            {canExportContent && (
              <>
                <DropdownMenuItem onClick={onExportMarkdown} className={itemClass}>
                  <FileMdIcon className="h-4 w-4" /> {t('document.action.exportMarkdown')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExportWord} className={itemClass}>
                  <FileDocIcon className="h-4 w-4" /> {t('document.action.exportWord')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExportPdf} className={itemClass}>
                  <FilePdfIcon className="h-4 w-4" /> {t('document.action.exportPdf')}
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
        {canViewVersionHistory && target.notebookId && target.relativePath && (
          <>
            <DropdownMenuItem className={itemClass} onClick={() => { void archiveVersion(); }}><ClockIcon className="h-4 w-4" /> {t('document.action.archiveVersion')}</DropdownMenuItem>
            <VersionHistorySubmenu
              notebookId={target.notebookId}
              relativePath={target.relativePath}
              refreshKey={versionRefreshKey}
              restoringVersionId={restoringVersionId}
              onSelectVersion={setConfirmVersion}
            />
          </>
        )}
        {!hideDeleteAction && <DropdownMenuItem
          onClick={() => setConfirmDelete(true)}
          className="group h-7 items-center justify-start gap-2 rounded-lg px-2 py-0 text-left hover:bg-transparent hover:text-[var(--destructive)]"
        >
          <TrashSimpleIcon className="h-4 w-4" /> {t(indexable ? 'memo.delete.confirm' : 'document.external.deleteFile')}
        </DropdownMenuItem>}
        {folderCollectionViewType && (
          <>
            <div role="separator" aria-hidden="true" className={POPUP_SEPARATOR_CLASS} />
            <DropdownMenuItem onClick={folderCollectionViewType.onToggleDefaultFolder} className={itemClass}>
              <MapPinSimpleAreaIcon className="h-4 w-4" aria-hidden="true" />
              {t(folderCollectionViewType.isDefaultFolder ? 'memo.fileTree.clearDefaultCreateFolder' : 'memo.fileTree.setDefaultCreateFolder')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
      <FolderCollectionSwitchConfirmDialog
        open={pendingViewType !== null}
        onOpenChange={(open) => { if (!open) setPendingViewType(null); }}
        onConfirm={() => {
          const type = pendingViewType;
          setPendingViewType(null);
          if (type) folderCollectionViewType?.onSelect(type);
        }}
      />
      {!hideDeleteAction && <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(indexable ? 'memo.delete.title' : 'document.external.deleteFileTitle')}</DialogTitle>
            <DialogDescription>
              {t(indexable ? 'memo.delete.description' : 'document.external.deleteFileDescription', { name: filePath.split(/[\\/]/).pop() ?? filePath })}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)]">
              {t('dialog.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete(false);
                void onDeleteExternalFile();
              }}
              className="h-8 rounded-lg border border-[var(--destructive)] bg-[var(--destructive)] px-3 text-sm text-white hover:opacity-90"
            >
              {t(indexable ? 'memo.delete.confirm' : 'document.external.deleteFileConfirm')}
            </button>
          </div>
        </DialogContent>
      </Dialog>}
      <Dialog open={!!confirmVersion} onOpenChange={(open) => !open && setConfirmVersion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('document.version.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('document.version.confirmDescription', {
              time: confirmVersion ? formatVersionTime(confirmVersion.createdAt, language) : '',
            } satisfies I18nParams)}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" disabled={!!restoringVersionId} onClick={() => setConfirmVersion(null)} className="h-8 rounded-lg px-3 text-sm hover:bg-[var(--muted)] disabled:opacity-60">
              {t('document.version.cancel')}
            </button>
            <button type="button" disabled={!!restoringVersionId} onClick={() => { void restorePathVersion(); }} className="h-8 rounded-lg bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)] disabled:opacity-60">
              {t('document.version.confirm')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </DropdownMenu>
    </>
  );
}
